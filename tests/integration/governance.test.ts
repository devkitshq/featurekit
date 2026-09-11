/**
 * Scheduled changes and change requests, against real Postgres (§18, PR-B11).
 *
 * Both tables shipped in the first migration with nothing reading them. That is
 * worse than not having them: an auditor sees governance features and an
 * operator schedules a change that never happens.
 *
 * The two properties that need a real database, because they are properties of
 * the SQL rather than of the code around it:
 *
 * - **`FOR UPDATE SKIP LOCKED` gives each due row to exactly one worker.** Every
 *   node runs the loop; a change applied twice is a change applied twice.
 * - **The four-eyes rule holds under a real transaction**, including when the
 *   same person tries to approve their own request.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import {
  changeRequests,
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  members,
  projects,
  scheduledChanges,
} from "../../src/db/schema.js";
import {
  ScheduledChangeWorker,
  approveChangeRequest,
  rejectChangeRequest,
} from "../../src/scheduler/scheduled-changes.js";
import {
  readFlagConfig,
  resolveTarget,
  verifyAuditChain,
  writeFlagConfig,
} from "../../src/repositories/flags.js";
import { auditLog } from "../../src/db/schema.js";
import type { Principal } from "../../src/auth/principal.js";

const reason = await containerUnavailableReason();

describe("governance prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; governance tests will run"
      : `governance tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("governance", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let flagEnvironmentId: string;
  let environmentId: string;
  let projectId: string;
  let author: Principal;
  let reviewer: Principal;

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    const [project] = await db
      .insert(projects)
      .values({ key: "gov", name: "Governance" })
      .returning({ id: projects.id });
    projectId = project!.id;

    const [environment] = await db
      .insert(environments)
      .values({ projectId, key: "production", name: "Production", bucketSalt: "salt" })
      .returning({ id: environments.id });
    environmentId = environment!.id;

    const [flag] = await db
      .insert(flags)
      .values({ projectId, key: "checkout", name: "Checkout", kind: "boolean" })
      .returning({ id: flags.id });
    const variations = await db
      .insert(flagVariations)
      .values([
        { flagId: flag!.id, idx: 0, value: false },
        { flagId: flag!.id, idx: 1, value: true },
      ])
      .returning({ id: flagVariations.id, idx: flagVariations.idx });
    const [config] = await db
      .insert(flagEnvironments)
      .values({
        flagId: flag!.id,
        environmentId,
        enabled: false,
        offVariationId: variations.find((v) => v.idx === 0)!.id,
        fallthroughVariationId: variations.find((v) => v.idx === 1)!.id,
      })
      .returning({ id: flagEnvironments.id });
    flagEnvironmentId = config!.id;

    const [one] = await db
      .insert(members)
      .values({ email: "author@example.com", role: "writer" })
      .returning({ id: members.id });
    const [two] = await db
      .insert(members)
      .values({ email: "reviewer@example.com", role: "admin" })
      .returning({ id: members.id });

    author = {
      kind: "token",
      tokenId: "t1",
      memberId: one!.id,
      memberEmail: "author@example.com",
      role: "writer",
      environmentIds: null,
    };
    reviewer = {
      kind: "token",
      tokenId: "t2",
      memberId: two!.id,
      memberEmail: "reviewer@example.com",
      role: "admin",
      environmentIds: null,
    };
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    await infra?.stop();
  });

  async function currentConfig() {
    const target = await resolveTarget(db, {
      projectKey: "gov",
      environmentKey: "production",
      flagKey: "checkout",
    });
    return readFlagConfig(db, target!);
  }

  function worker(over: Partial<ConstructorParameters<typeof ScheduledChangeWorker>[0]> = {}) {
    return new ScheduledChangeWorker({
      db,
      onApplied: () => {},
      onError: () => {},
      ...over,
    });
  }

  async function schedule(patch: unknown, executeAt: Date) {
    const [row] = await db
      .insert(scheduledChanges)
      .values({
        flagEnvironmentId,
        patch: patch as Record<string, unknown>,
        executeAt,
        createdBy: author.memberId,
      })
      .returning({ id: scheduledChanges.id });
    return row!.id;
  }

  /* ── scheduled changes ───────────────────────────────────────────── */

  it("does not apply a change before it is due", async () => {
    const id = await schedule({ enabled: true }, new Date(Date.now() + 3_600_000));
    expect(await worker().runDue()).toBe(0);

    const [row] = await db
      .select({ executedAt: scheduledChanges.executedAt })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.id, id));
    expect(row?.executedAt).toBeNull();
    await db.delete(scheduledChanges).where(eq(scheduledChanges.id, id));
  }, 60_000);

  it("applies a due change through the ordinary write path", async () => {
    expect((await currentConfig()).enabled).toBe(false);

    const id = await schedule({ enabled: true }, new Date(Date.now() - 1_000));
    expect(await worker().runDue()).toBe(1);

    const after = await currentConfig();
    expect(after.enabled).toBe(true);

    // Same write path means the version moved and an audit row exists.
    expect(after.version).toBeGreaterThan(1);
    const [row] = await db
      .select({ executedAt: scheduledChanges.executedAt })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.id, id));
    expect(row?.executedAt).not.toBeNull();
  }, 60_000);

  it("refuses to fire long after its window instead of surprising everyone", async () => {
    // A change scheduled for 09:00 must not turn a feature on at 15:00 because
    // the fleet was down in between. Fires-late is worse than does-not-fire.
    const before = await currentConfig();
    const id = await schedule({ enabled: !before.enabled }, new Date(Date.now() - 7_200_000));

    expect(await worker({ graceMs: 60_000 }).runDue()).toBe(0);

    const [row] = await db
      .select({ failedReason: scheduledChanges.failedReason })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.id, id));
    expect(row?.failedReason).toMatch(/missed window/);
    expect((await currentConfig()).enabled).toBe(before.enabled);
  }, 60_000);

  it("gives a due change to exactly one of several concurrent workers", async () => {
    // Every node runs this loop. `FOR UPDATE SKIP LOCKED` is what stops two of
    // them applying the same change.
    await db.delete(scheduledChanges);
    await schedule({ enabled: false }, new Date(Date.now() - 1_000));

    const applied = await Promise.all([
      worker().runDue(),
      worker().runDue(),
      worker().runDue(),
      worker().runDue(),
    ]);
    expect(applied.reduce((a, b) => a + b, 0)).toBe(1);
  }, 60_000);

  it("records a failure rather than retrying a broken change forever", async () => {
    const id = await schedule(
      // Weights that do not sum to 100000: rejected by the same validation the
      // API applies, which is the point of sharing the write path.
      { fallthroughRollout: { variations: [{ variation: 1, weight: 50_000 }] } },
      new Date(Date.now() - 1_000),
    );
    expect(await worker().runDue()).toBe(0);

    const [row] = await db
      .select({ failedReason: scheduledChanges.failedReason })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.id, id));
    expect(row?.failedReason).toBeTruthy();

    // And it is not picked up again on the next pass.
    expect(await worker().runDue()).toBe(0);
  }, 60_000);

  /* ── change requests ─────────────────────────────────────────────── */

  async function request(patch: unknown, requestedBy: Principal) {
    const [row] = await db
      .insert(changeRequests)
      .values({
        flagEnvironmentId,
        patch: patch as Record<string, unknown>,
        requestedBy: requestedBy.memberId,
      })
      .returning({ id: changeRequests.id });
    return row!.id;
  }

  it("applies an approved request and records who approved it", async () => {
    const before = await currentConfig();
    const id = await request({ enabled: !before.enabled }, author);

    const result = await approveChangeRequest(db, {
      requestId: id,
      projectId,
      reviewer,
      onApplied: () => {},
    });
    expect(result.applied).toBe(true);
    expect((await currentConfig()).enabled).toBe(!before.enabled);

    const [row] = await db
      .select({ status: changeRequests.status, reviewedBy: changeRequests.reviewedBy })
      .from(changeRequests)
      .where(eq(changeRequests.id, id));
    expect(row?.status).toBe("approved");
    expect(row?.reviewedBy).toBe(reviewer.memberId);
  }, 60_000);

  it("refuses self-approval", async () => {
    // The point of an approval workflow is that a second person looked.
    const id = await request({ enabled: true }, author);
    await expect(
      approveChangeRequest(db, { requestId: id, projectId, reviewer: author, onApplied: () => {} }),
    ).rejects.toThrow(/cannot be approved by the person who raised it/);
  }, 60_000);

  it("refuses to approve twice", async () => {
    const id = await request({ enabled: true }, author);
    await approveChangeRequest(db, { requestId: id, projectId, reviewer, onApplied: () => {} });
    await expect(
      approveChangeRequest(db, { requestId: id, projectId, reviewer, onApplied: () => {} }),
    ).rejects.toThrow(/already approved/);
  }, 60_000);

  it("hides another tenant's request behind a not-found", async () => {
    const id = await request({ enabled: true }, author);
    await expect(
      approveChangeRequest(db, {
        requestId: id,
        projectId: "00000000-0000-0000-0000-000000000000",
        reviewer,
        onApplied: () => {},
      }),
    ).rejects.toThrow("NOT_FOUND");
  }, 60_000);

  it("rejects a request without applying it", async () => {
    const before = await currentConfig();
    const id = await request({ enabled: !before.enabled }, author);
    await rejectChangeRequest(db, { requestId: id, projectId, reviewer, comment: "not now" });

    expect((await currentConfig()).enabled).toBe(before.enabled);
    const [row] = await db
      .select({ status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.id, id));
    expect(row?.status).toBe("rejected");
  }, 60_000);

  it("refuses to approve a rejected request", async () => {
    const id = await request({ enabled: true }, author);
    await rejectChangeRequest(db, { requestId: id, projectId, reviewer });
    await expect(
      approveChangeRequest(db, { requestId: id, projectId, reviewer, onApplied: () => {} }),
    ).rejects.toThrow(/already rejected/);
  }, 60_000);

  /* ── audit tamper evidence (PR-E7) ───────────────────────────────── */

  it("chains every audit row to the one before it", async () => {
    const target = await resolveTarget(db, {
      projectKey: "gov",
      environmentKey: "production",
      flagKey: "checkout",
    });

    for (let i = 0; i < 3; i++) {
      const current = await readFlagConfig(db, target!);
      await writeFlagConfig(
        db,
        { ...target!, version: current.version },
        { expectedVersion: current.version, enabled: i % 2 === 0 },
        reviewer,
      );
    }

    const result = await verifyAuditChain(db, projectId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checked).toBeGreaterThan(2);
  }, 60_000);

  it("detects an edited audit row", async () => {
    // The point of the chain: changing "who turned this on" is the first thing
    // somebody would want to change, and it must not be silent.
    const before = await verifyAuditChain(db, projectId);
    expect(before.ok).toBe(true);

    const [row] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.projectId, projectId))
      .limit(1);

    await db
      .update(auditLog)
      .set({ action: "flag.definitely_not_what_happened" })
      .where(eq(auditLog.id, row!.id));

    const after = await verifyAuditChain(db, projectId);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.brokenAt).toBe(row!.id);

    // Put it back so later assertions in this file are not confused by it.
    await db
      .update(auditLog)
      .set({ action: "flag.updated" })
      .where(eq(auditLog.id, row!.id));
  }, 60_000);

  it("detects a deleted audit row", async () => {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.projectId, projectId))
      .orderBy(auditLog.seq);
    // Remove one from the middle: the content of the survivors is intact, but
    // the links no longer join up.
    const victim = rows[Math.floor(rows.length / 2)];
    await db.delete(auditLog).where(eq(auditLog.id, victim!.id));

    const result = await verifyAuditChain(db, projectId);
    expect(result.ok).toBe(false);
  }, 60_000);
});
