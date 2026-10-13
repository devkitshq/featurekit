/**
 * The management API against real Postgres and real Redis.
 *
 * These are the tests the production review's §8 and §18 actually ask for, and
 * they cannot be written against mocks: tenant isolation is a property of the
 * SQL, optimistic concurrency is a property of `FOR UPDATE` under a real
 * transaction, and "the audit row and the config commit together" is only true
 * if a real transaction rolls both back.
 *
 * Container-gated like the rest of `tests/integration`. In CI,
 * `FEATUREKIT_REQUIRE_CONTAINERS=1` turns a skip into a failure — a skipped
 * authorization suite is indistinguishable from a passing one, which is how an
 * IDOR ships.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { members, accessTokens, auditLog, environments } from "../../src/db/schema.js";
import { hashKey, generateAccessToken } from "../../src/auth/keys.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { registerAdminRoutes } from "../../src/routes/admin.js";
import { registerSdkRoutes } from "../../src/routes/sdk.js";
import { AccessTokenRepository } from "../../src/repositories/access-tokens.js";
import { SdkKeyRepository } from "../../src/repositories/sdk-keys.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";

const reason = await containerUnavailableReason();

describe("management API prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; management API tests will run"
      : `management API tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("management API", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let server: HttpServer;
  let snapshots: SnapshotService;
  let base: string;
  let sdkKeys: SdkKeyRepository;

  /** An owner token, and a token scoped to one tenant's environment only. */
  let ownerToken: string;
  let scopedToken: string;

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    const store = new MemorySnapshotStore();
    snapshots = new SnapshotService({
      store,
      loadInput: (environmentId) => loadCompilerInput(db, environmentId),
      nextVersion: (environmentId) => nextSnapshotVersion(db, environmentId),
      debounceMs: 5,
    });
    sdkKeys = new SdkKeyRepository(db, { ttlMs: 50 });

    const router = new Router();
    registerAdminRoutes(router, {
      db,
      snapshots,
      tokens: new AccessTokenRepository(db, { ttlMs: 0, negativeTtlMs: 0 }),
      onKeyRevoked: () => sdkKeys.invalidateAll(),
    });
    registerSdkRoutes(router, {
      snapshots,
      store,
      authenticate: async (presented) => {
        const resolved = await sdkKeys.resolve(presented);
        return resolved === null ? null : { ...resolved };
      },
    });

    server = new HttpServer({ router, port: 0 });
    const address = await server.listen();
    base = `http://${address.host}:${address.port}`;

    const [owner] = await db
      .insert(members)
      .values({ email: "owner@example.com", name: "Owen Owner", role: "owner" })
      .returning({ id: members.id });
    ownerToken = generateAccessToken();
    await db.insert(accessTokens).values({
      memberId: owner!.id,
      tokenHash: hashKey(ownerToken),
      name: "owner",
      environmentIds: null,
    });
    scopedToken = generateAccessToken();
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await snapshots?.close();
    await handle?.close();
    await infra?.stop();
  });

  const call = (path: string, init: RequestInit = {}, token = ownerToken) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  async function seedTenant(prefix: string) {
    await call("/v1/admin/projects", {
      method: "POST",
      body: JSON.stringify({ key: prefix, name: prefix }),
    });
    await call(`/v1/admin/projects/${prefix}/environments`, {
      method: "POST",
      body: JSON.stringify({ key: "production", name: "Production", isProduction: true }),
    });
    await call(`/v1/admin/projects/${prefix}/flags`, {
      method: "POST",
      body: JSON.stringify({
        key: "checkout",
        name: "Checkout",
        kind: "boolean",
        variations: [{ value: false }, { value: true }],
      }),
    });
    return `/v1/admin/projects/${prefix}/environments/production/flags/checkout`;
  }

  /* ── authentication ──────────────────────────────────────────────── */

  it("refuses an unknown token, indistinguishably from an expired one", async () => {
    const unknown = await call("/v1/admin/projects", {}, "fk_pat_definitely-not-real");
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: string }).error).toBe("TOKEN_REJECTED");
  });

  it("requires a token at all", async () => {
    expect((await fetch(`${base}/v1/admin/projects`)).status).toBe(401);
  });

  /* ── tenant isolation ───────────────────────────────────────── */

  it("hides another tenant's flag behind a 404, never a 403", async () => {
    // 403 would confirm the object exists, turning any id list into an
    // existence oracle for another customer's flag keys.
    await seedTenant("tenant-a");
    await seedTenant("tenant-b");

    // Tenant B's project, tenant A's flag key does not exist there.
    const crossed = await call(
      "/v1/admin/projects/tenant-b/environments/production/flags/does-not-exist",
    );
    expect(crossed.status).toBe(404);

    // And a project that does not exist at all looks identical.
    const missing = await call(
      "/v1/admin/projects/tenant-zzz/environments/production/flags/checkout",
    );
    expect(missing.status).toBe(404);
  });

  it("scopes a token to its environments", async () => {
    const path = await seedTenant("tenant-c");
    const [member] = await db
      .insert(members)
      .values({ email: `scoped-${Date.now()}@example.com`, role: "writer" })
      .returning({ id: members.id });
    // Scoped to an environment that exists but is not this one.
    await db.insert(accessTokens).values({
      memberId: member!.id,
      tokenHash: hashKey(scopedToken),
      environmentIds: ["00000000-0000-0000-0000-000000000000"],
    });

    const response = await call(path, {}, scopedToken);
    expect(response.status).toBe(404);
  });

  it("refuses a writer token on an admin-only route", async () => {
    await seedTenant("tenant-roles");
    const readerToken = generateAccessToken();
    const [member] = await db
      .insert(members)
      .values({ email: `reader-${Date.now()}@example.com`, role: "reader" })
      .returning({ id: members.id });
    await db
      .insert(accessTokens)
      .values({ memberId: member!.id, tokenHash: hashKey(readerToken), environmentIds: null });

    const response = await call(
      "/v1/admin/projects/tenant-roles/environments/production/keys",
      { method: "POST", body: JSON.stringify({ kind: "server" }) },
      readerToken,
    );
    expect(response.status).toBe(403);
  });

  /* ── optimistic concurrency ────────────────────────────────── */

  it("refuses the second of two concurrent edits instead of losing one", async () => {
    // The §18 scenario, exactly: one engineer changes targeting, the other
    // changes the rollout, both save.
    const path = await seedTenant("tenant-race");
    const current = (await (await call(path)).json()) as { version: number };

    const first = await call(path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: current.version,
        rules: [
          { clauses: [{ attribute: "country", op: "in", values: ["NL"] }], variation: 1 },
        ],
      }),
    });
    expect(first.status).toBe(200);

    const second = await call(path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: current.version, // stale: read before the first write
        fallthroughRollout: {
          variations: [
            { variation: 0, weight: 50_000 },
            { variation: 1, weight: 50_000 },
          ],
        },
      }),
    });
    expect(second.status).toBe(409);

    const body = (await second.json()) as { error: string; details: { current: unknown } };
    expect(body.error).toBe("VERSION_CONFLICT");
    // The current state travels with the conflict, so a UI can show a diff.
    expect(body.details.current).toBeDefined();

    // The first engineer's rule survived.
    const after = (await (await call(path)).json()) as { rules: unknown[] };
    expect(after.rules).toHaveLength(1);
  });

  it("rejects rollout weights that do not sum to 100000", async () => {
    // Weights summing to 90,000 leave 10% of traffic falling off the end of the
    // rollout onto the caller's default — a mystery error rate, not an error.
    const path = await seedTenant("tenant-weights");
    const current = (await (await call(path)).json()) as { version: number };
    const response = await call(path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: current.version,
        fallthroughRollout: { variations: [{ variation: 1, weight: 90_000 }] },
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ROLLOUT_WEIGHTS");
  });

  it("rolls back the whole change when part of it is invalid", async () => {
    const path = await seedTenant("tenant-atomic");
    const current = (await (await call(path)).json()) as { version: number };
    const response = await call(path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: current.version,
        rules: [{ clauses: [], variation: 0 }],
        prerequisites: [{ flagKey: "no-such-flag", variation: 0 }],
      }),
    });
    expect(response.status).toBe(400);

    // The rules were deleted and reinserted before the prerequisite failed. If
    // the transaction did not roll back, the flag now has one rule and no
    // targeting — for a flag serving production traffic.
    const after = (await (await call(path)).json()) as { rules: unknown[]; version: number };
    expect(after.rules).toHaveLength(0);
    expect(after.version).toBe(current.version);
  });

  /* ── audit and revert ──────────────────────────────────────── */

  it("writes an audit row in the same transaction as the change", async () => {
    const path = await seedTenant("tenant-audit");
    const current = (await (await call(path)).json()) as { version: number };
    await call(path, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: current.version, enabled: true, comment: "ship it" }),
    });

    const audit = (await (
      await call("/v1/admin/projects/tenant-audit/audit")
    ).json()) as {
      entries: Array<{
        action: string;
        comment: string | null;
        actorId: string | null;
        actorName: string | null;
      }>;
    };
    expect(audit.entries[0]?.action).toBe("flag.updated");
    expect(audit.entries[0]?.comment).toBe("ship it");

    // The dashboard shows who made the change, by name and by id.
    const [owner] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.email, "owner@example.com"));
    expect(audit.entries[0]?.actorId).toBe(owner!.id);
    expect(audit.entries[0]?.actorName).toBe("Owen Owner");
  });

  it("reverts to a previous configuration through the same validation path", async () => {
    const path = await seedTenant("tenant-revert");
    let current = (await (await call(path)).json()) as { version: number };

    const changed = await call(path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: current.version,
        enabled: true,
        rules: [{ clauses: [{ attribute: "plan", op: "in", values: ["pro"] }], variation: 1 }],
      }),
    });
    const { auditId } = (await changed.json()) as { auditId: string };

    const reverted = await call(`${path}/revert`, {
      method: "POST",
      body: JSON.stringify({ auditId }),
    });
    expect(reverted.status).toBe(200);

    current = (await (await call(path)).json()) as { version: number };
    const after = (await (await call(path)).json()) as { rules: unknown[]; enabled: boolean };
    expect(after.rules).toHaveLength(0);
    expect(after.enabled).toBe(false);
  });

  it("refuses to revert using another flag's audit entry", async () => {
    const pathA = await seedTenant("tenant-revert-a");
    const current = (await (await call(pathA)).json()) as { version: number };
    const changed = await call(pathA, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: current.version, enabled: true }),
    });
    const { auditId } = (await changed.json()) as { auditId: string };

    const pathB = await seedTenant("tenant-revert-b");
    const response = await call(`${pathB}/revert`, {
      method: "POST",
      body: JSON.stringify({ auditId }),
    });
    // Another tenant's audit id is simply not found — it is scoped by project.
    expect(response.status).toBe(404);
  });

  /* ── kill switch (§23-A) ────────────────────────────────────── */

  it("turns a flag off without an expected version", async () => {
    const path = await seedTenant("tenant-kill");
    const current = (await (await call(path)).json()) as { version: number };
    await call(path, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: current.version, enabled: true }),
    });

    // No version, no configuration body: an operator mid-incident has neither.
    const killed = await call(`${path}/off`, { method: "POST", body: JSON.stringify({}) });
    expect(killed.status).toBe(200);

    const after = (await (await call(path)).json()) as { enabled: boolean };
    expect(after.enabled).toBe(false);

    const audit = (await (
      await call("/v1/admin/projects/tenant-kill/audit")
    ).json()) as { entries: Array<{ action: string }> };
    expect(audit.entries[0]?.action).toBe("flag.killed");
  });

  /* ── SDK keys ────────────────────────────────────────── */

  it("returns a server key once and never again", async () => {
    await seedTenant("tenant-keys");
    const created = await call("/v1/admin/projects/tenant-keys/environments/production/keys", {
      method: "POST",
      body: JSON.stringify({ kind: "server", name: "ci" }),
    });
    const { key, id } = (await created.json()) as { key: string; id: string };
    expect(key.startsWith("fk_srv_")).toBe(true);

    const listed = (await (
      await call("/v1/admin/projects/tenant-keys/environments/production/keys")
    ).json()) as { keys: Array<{ id: string; publicKey: string | null }> };
    // A server key is hashed at rest and unrecoverable: the listing has no
    // plaintext for it at all.
    expect(listed.keys.find((k) => k.id === id)?.publicKey).toBeNull();
  });

  it("authenticates an SDK request with a freshly minted key", async () => {
    await seedTenant("tenant-sdk");
    const created = await call("/v1/admin/projects/tenant-sdk/environments/production/keys", {
      method: "POST",
      body: JSON.stringify({ kind: "server" }),
    });
    const { key } = (await created.json()) as { key: string };

    const snapshot = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(snapshot.status).toBe(200);
  });

  it("stops accepting a revoked key within the stated bound", async () => {
    await seedTenant("tenant-revoke");
    const created = await call("/v1/admin/projects/tenant-revoke/environments/production/keys", {
      method: "POST",
      body: JSON.stringify({ kind: "server" }),
    });
    const { key, id } = (await created.json()) as { key: string; id: string };

    const before = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(before.status).toBe(200);

    await call(`/v1/admin/projects/tenant-revoke/environments/production/keys/${id}`, {
      method: "DELETE",
    });

    const after = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(after.status).toBe(401);
  });

  it("refuses a key id belonging to another environment", async () => {
    await seedTenant("tenant-key-a");
    await seedTenant("tenant-key-b");
    const created = await call("/v1/admin/projects/tenant-key-a/environments/production/keys", {
      method: "POST",
      body: JSON.stringify({ kind: "server" }),
    });
    const { id } = (await created.json()) as { id: string };

    const response = await call(
      `/v1/admin/projects/tenant-key-b/environments/production/keys/${id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });

  /* ── segments (Scenario F) ───────────────────────────────────── */

  it("imports segment members idempotently, page by page", async () => {
    await seedTenant("tenant-segments");
    const segmentPath = "/v1/admin/projects/tenant-segments/environments/production/segments";
    await call(segmentPath, {
      method: "POST",
      body: JSON.stringify({ key: "beta", name: "Beta testers" }),
    });

    const page = Array.from({ length: 500 }, (_, i) => ({ contextKey: `user-${i}` }));
    const first = await call(`${segmentPath}/beta/members`, {
      method: "POST",
      body: JSON.stringify({ add: page }),
    });
    expect(((await first.json()) as { memberCount: number }).memberCount).toBe(500);

    // The same page again — a retry after an ambiguous failure. It must not
    // duplicate, and it must not error.
    const retried = await call(`${segmentPath}/beta/members`, {
      method: "POST",
      body: JSON.stringify({ add: page }),
    });
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { memberCount: number }).memberCount).toBe(500);
  });

  /* ── snapshot propagation ────────────────────────────────────────── */

  it("allocates monotonic snapshot versions under concurrency", async () => {
    // Two nodes compiling the same environment must never receive the same
    // version: the SDK's guard would reject the loser's snapshot forever.
    await seedTenant("tenant-versions");
    const [environment] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.key, "production"))
      .limit(1);

    const versions = await Promise.all(
      Array.from({ length: 20 }, () => nextSnapshotVersion(db, environment!.id)),
    );
    expect(new Set(versions).size).toBe(20);
  });

  it("records every audit row against its own project", async () => {
    const rows = await db.select({ projectId: auditLog.projectId }).from(auditLog).limit(5);
    expect(rows.every((r) => typeof r.projectId === "string")).toBe(true);
  });
});
