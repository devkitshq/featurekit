import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { compileSnapshot } from "../../src/snapshot/compile.js";
import {
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  projects,
  segmentMembers,
  segments,
} from "../../src/db/schema.js";
import { sql } from "drizzle-orm";

const reason = await containerUnavailableReason();

/**
 * The gate status is a TEST, not a `console.warn` — vitest swallows console
 * output written during collection, and a skip nobody sees is
 * indistinguishable from a pass. This always runs and always prints, so the
 * reason the integration suite did not execute is in the report.
 */
describe("integration prerequisites", () => {
  it(
    reason === null
      ? "container runtime is available; integration tests will run"
      : `integration tests SKIPPED — ${reason}. Start a Docker daemon, or set FEATUREKIT_REQUIRE_CONTAINERS=1 to fail instead`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

/**
 * These assert the things a pure unit test structurally cannot: generated
 * columns, check constraints, composite foreign keys, and partitioned DDL.
 * That is exactly where a schema bug hides.
 */
describe.skipIf(reason !== null)("schema against real Postgres", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    await infra?.stop();
  });

  async function seedProject() {
    const [project] = await db
      .insert(projects)
      .values({ key: `p_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: "Acme" })
      .returning();
    const [env] = await db
      .insert(environments)
      .values({
        projectId: project!.id,
        key: "production",
        name: "Production",
        isProduction: true,
        bucketSalt: "s4lt",
      })
      .returning();
    return { project: project!, env: env! };
  }

  it("applies every migration, including the partitioned DDL", async () => {
    const [row] = await db.execute<{ relkind: string }>(
      sql`SELECT relkind::text FROM pg_class WHERE relname = 'evaluation_summaries'`,
    );
    // 'p' is a partitioned table. A plain 'r' here means drizzle-kit's
    // generated CREATE TABLE shadowed the partitioned one.
    expect(row?.relkind).toBe("p");
  });

  it("creates a week of partitions and reports runway", async () => {
    const [row] = await db.execute<{ runway: number }>(
      sql`SELECT featurekit_partition_runway_days() AS runway`,
    );
    // p_premake => 7 is the point: maintenance can miss a week of runs and
    // inserts still land. The readiness check pages below two days.
    expect(Number(row?.runway)).toBeGreaterThanOrEqual(2);
  });

  it("has NO default partition", async () => {
    // A DEFAULT partition converts a loud failure into a silent trap: one row
    // in it and future partition creation errors out permanently.
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n
            FROM pg_partitioned_table pt
            JOIN pg_class p ON p.oid = pt.partrelid
            JOIN pg_inherits i ON i.inhparent = p.oid
            JOIN pg_class c ON c.oid = i.inhrelid
           WHERE p.relname = 'evaluation_summaries'
             AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("enforces the fallthrough XOR constraint", async () => {
    const { project, env } = await seedProject();
    const [flag] = await db
      .insert(flags)
      .values({ projectId: project.id, key: "f", name: "F", kind: "boolean" })
      .returning();
    const [v0] = await db
      .insert(flagVariations)
      .values({ flagId: flag!.id, idx: 0, value: false })
      .returning();

    // Both set: rejected.
    await expect(
      db.insert(flagEnvironments).values({
        flagId: flag!.id,
        environmentId: env.id,
        fallthroughVariationId: v0!.id,
        fallthroughRollout: { variations: [{ variationIndex: 0, weight: 100_000 }] },
      }),
    ).rejects.toThrow();

    // Neither set: also rejected.
    await expect(
      db.insert(flagEnvironments).values({ flagId: flag!.id, environmentId: env.id }),
    ).rejects.toThrow();

    // Exactly one: accepted.
    await expect(
      db.insert(flagEnvironments).values({
        flagId: flag!.id,
        environmentId: env.id,
        fallthroughVariationId: v0!.id,
      }),
    ).resolves.toBeDefined();
  });

  it("computes segment_members.ordinal, and excludes leading zeros", async () => {
    // The generated column is the roaring eligibility test. It MUST agree with
    // the SDK's `ordinalOf`, or the compiler can pick roaring for a segment the
    // SDK then answers `false` for (docs/decisions.md §9).
    const { project, env } = await seedProject();
    const [segment] = await db
      .insert(segments)
      .values({ projectId: project.id, environmentId: env.id, key: "s", name: "S" })
      .returning();

    await db.insert(segmentMembers).values([
      { segmentId: segment!.id, contextKey: "42" },
      { segmentId: segment!.id, contextKey: "0" },
      { segmentId: segment!.id, contextKey: "07" },
      { segmentId: segment!.id, contextKey: "usr_7f3a" },
      { segmentId: segment!.id, contextKey: "999999999" },
      { segmentId: segment!.id, contextKey: "1000000000" },
    ]);

    const rows = await db.execute<{ context_key: string; ordinal: string | null }>(
      sql`SELECT context_key, ordinal FROM segment_members WHERE segment_id = ${segment!.id} ORDER BY context_key`,
    );
    const ordinals = Object.fromEntries(rows.map((r) => [r.context_key, r.ordinal]));
    expect(ordinals["42"]).toBe("42");
    expect(ordinals["0"]).toBe("0");
    expect(ordinals["999999999"]).toBe("999999999");
    expect(ordinals["07"]).toBeNull(); // leading zero: not integral
    expect(ordinals["usr_7f3a"]).toBeNull();
    expect(ordinals["1000000000"]).toBeNull(); // 10 digits: out of range
  });

  it("refuses a segment whose project disagrees with its environment", async () => {
    // The composite FK. `projectId` on segments is derivable and must never be
    // written independently, so the database enforces agreement.
    const { env } = await seedProject();
    const other = await seedProject();
    await expect(
      db.insert(segments).values({
        projectId: other.project.id,
        environmentId: env.id,
        key: "mismatched",
        name: "Mismatched",
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete a flag another flag depends on", async () => {
    const { project, env } = await seedProject();
    const inserted = await db
      .insert(flags)
      .values([
        { projectId: project.id, key: "dependent", name: "Dependent", kind: "boolean" },
        { projectId: project.id, key: "prereq", name: "Prereq", kind: "boolean" },
      ])
      .returning();
    const [dependent, prereq] = inserted;
    const variations = await db
      .insert(flagVariations)
      .values([
        { flagId: dependent!.id, idx: 0, value: false },
        { flagId: prereq!.id, idx: 0, value: false },
      ])
      .returning();
    const [feDependent] = await db
      .insert(flagEnvironments)
      .values({
        flagId: dependent!.id,
        environmentId: env.id,
        fallthroughVariationId: variations[0]!.id,
      })
      .returning();
    const { prerequisites } = await import("../../src/db/schema.js");
    await db.insert(prerequisites).values({
      flagEnvironmentId: feDependent!.id,
      prerequisiteFlagId: prereq!.id,
      requiredVariationId: variations[1]!.id,
    });

    const { eq } = await import("drizzle-orm");
    await expect(db.delete(flags).where(eq(flags.id, prereq!.id))).rejects.toThrow();
  });

  it("round-trips rows through the repository into a compiled snapshot", async () => {
    const { project, env } = await seedProject();
    const [flag] = await db
      .insert(flags)
      .values({
        projectId: project.id,
        key: "new-checkout",
        name: "New checkout",
        kind: "boolean",
        clientAvailable: true,
      })
      .returning();
    const variations = await db
      .insert(flagVariations)
      .values([
        { flagId: flag!.id, idx: 0, value: false },
        { flagId: flag!.id, idx: 1, value: true },
      ])
      .returning();
    await db.insert(flagEnvironments).values({
      flagId: flag!.id,
      environmentId: env.id,
      enabled: true,
      offVariationId: variations[0]!.id,
      fallthroughVariationId: variations[1]!.id,
      version: 7,
    });

    const input = await loadCompilerInput(db, env.id);
    const snapshot = compileSnapshot(input, { version: 1 });

    expect(snapshot.environmentKey).toBe("production");
    expect(snapshot.salt).toBe("s4lt");
    const compiled = snapshot.flags["new-checkout"]!;
    expect(compiled.on).toBe(true);
    expect(compiled.variations).toEqual([false, true]);
    expect(compiled.offVariation).toBe(0);
    expect(compiled.fallthrough).toEqual({ variation: 1 });
    expect(compiled.version).toBe(7);
    expect(compiled.clientAvailable).toBe(true);
  });
});
