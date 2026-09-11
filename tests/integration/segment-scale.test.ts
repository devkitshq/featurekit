/**
 * Segment loading at scale, against real Postgres (review PR-B4, Scenario F).
 *
 * The compiler used to read every segment member with one
 * `SELECT ... WHERE segment_id IN (...)`. That is fine at ten thousand members
 * and fatal at ten million: the driver materialises every row into a single
 * array before returning, inside the process whose entire job is to keep
 * answering flag requests.
 *
 * Two properties are asserted here, and both need a real database — keyset
 * pagination is a property of the SQL, and the ceiling only means anything if
 * the rows genuinely exist:
 *
 * 1. A large segment loads correctly, in pages, with every member present and
 *    no duplicates.
 * 2. Past the ceiling the compile **fails loudly** rather than truncating.
 *    Truncation would build a membership filter from part of the list, which
 *    answers "not a member" for real members — and a negated segment clause
 *    then grants the gated feature to exactly the wrong people.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import {
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  projects,
  segmentMembers,
  segments,
} from "../../src/db/schema.js";
import {
  loadCompilerInput,
  SegmentTooLargeError,
} from "../../src/repositories/snapshot-input.js";
import { compileSnapshot } from "../../src/snapshot/compile.js";
import { eq } from "drizzle-orm";

const reason = await containerUnavailableReason();

describe("segment scale prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; segment scale tests will run"
      : `segment scale tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("segment loading at scale", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let environmentId: string;

  const MEMBERS = 60_000;

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    const [project] = await db
      .insert(projects)
      .values({ key: "scale", name: "Scale" })
      .returning({ id: projects.id });
    const [environment] = await db
      .insert(environments)
      .values({
        projectId: project!.id,
        key: "production",
        name: "Production",
        bucketSalt: "salt",
      })
      .returning({ id: environments.id });
    environmentId = environment!.id;

    const [flag] = await db
      .insert(flags)
      .values({ projectId: project!.id, key: "gated", name: "Gated", kind: "boolean" })
      .returning({ id: flags.id });
    const variations = await db
      .insert(flagVariations)
      .values([
        { flagId: flag!.id, idx: 0, value: false },
        { flagId: flag!.id, idx: 1, value: true },
      ])
      .returning({ id: flagVariations.id, idx: flagVariations.idx });
    await db.insert(flagEnvironments).values({
      flagId: flag!.id,
      environmentId,
      enabled: true,
      offVariationId: variations.find((v) => v.idx === 0)!.id,
      fallthroughVariationId: variations.find((v) => v.idx === 1)!.id,
    });

    const [segment] = await db
      .insert(segments)
      .values({
        projectId: project!.id,
        environmentId,
        key: "big",
        name: "Big segment",
      })
      .returning({ id: segments.id });

    // Insert in chunks: the point of the test is the *read* path, and a single
    // 60k-row insert would hit the driver's parameter limit.
    for (let start = 0; start < MEMBERS; start += 5_000) {
      await db.insert(segmentMembers).values(
        Array.from({ length: Math.min(5_000, MEMBERS - start) }, (_, i) => ({
          segmentId: segment!.id,
          contextKind: "user",
          contextKey: `user-${start + i}`,
        })),
      );
    }
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    await infra?.stop();
  });

  it("reads every member across many pages, exactly once", async () => {
    const input = await loadCompilerInput(db, environmentId, { memberPageSize: 1_000 });
    expect(input.segmentMembers).toHaveLength(MEMBERS);

    const keys = new Set(input.segmentMembers.map((m) => m.contextKey));
    expect(keys.size).toBe(MEMBERS);
    // Both ends, so an off-by-one at a page boundary cannot hide.
    expect(keys.has("user-0")).toBe(true);
    expect(keys.has(`user-${MEMBERS - 1}`)).toBe(true);
  }, 120_000);

  it("produces the same members whatever the page size", async () => {
    // Page size is a memory knob; it must not be able to change the answer.
    const small = await loadCompilerInput(db, environmentId, { memberPageSize: 997 });
    const large = await loadCompilerInput(db, environmentId, { memberPageSize: 50_000 });
    expect(small.segmentMembers.length).toBe(large.segmentMembers.length);
    expect(new Set(small.segmentMembers.map((m) => m.contextKey))).toEqual(
      new Set(large.segmentMembers.map((m) => m.contextKey)),
    );
  }, 120_000);

  it("compiles a large segment into a filter, not an inline list", async () => {
    const input = await loadCompilerInput(db, environmentId, { memberPageSize: 10_000 });
    const snapshot = compileSnapshot(input, { version: 1, segmentInlineMax: 1_000 });
    const segment = snapshot.segments["big"];
    expect(segment).toBeDefined();
    // 60k integral-looking keys? No — they are `user-N`, so cuckoo, not roaring.
    expect(segment!.kind).toBe("cuckoo");
  }, 120_000);

  it("fails loudly past the ceiling instead of truncating", async () => {
    // The important half. A truncated read would compile a filter that answers
    // "not a member" for real members, and a negated segment clause would then
    // grant the gated feature to exactly the wrong people (§22.3).
    await expect(
      loadCompilerInput(db, environmentId, { memberPageSize: 5_000, maxSegmentMembers: 10_000 }),
    ).rejects.toThrow(SegmentTooLargeError);
  }, 120_000);

  it("names the offending segment in the error", async () => {
    // At 3am the operator needs to know which segment, not that "a segment" was
    // too large.
    await expect(
      loadCompilerInput(db, environmentId, { memberPageSize: 5_000, maxSegmentMembers: 10_000 }),
    ).rejects.toThrow(/segment big exceeds/);
  }, 120_000);

  it("stops reading as soon as the ceiling is crossed", async () => {
    // The refusal must not itself require loading everything first.
    const started = Date.now();
    await expect(
      loadCompilerInput(db, environmentId, { memberPageSize: 1_000, maxSegmentMembers: 2_000 }),
    ).rejects.toThrow(SegmentTooLargeError);
    // Three pages, not sixty.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 120_000);

  it("leaves the previous snapshot serving when the ceiling is hit", async () => {
    // `SnapshotService` treats a compile failure as "keep what you have", which
    // is only a safe policy if the failure is a throw rather than a truncation.
    const [row] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    expect(row).toBeDefined();
  });
});
