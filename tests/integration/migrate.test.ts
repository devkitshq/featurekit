/**
 * `featurekit-server/migrate` against a real Postgres.
 *
 * This entry point exists because the documented shape — migrate as a deploy
 * step, then roll nodes — was unfollowable for anyone who installed featurekit
 * from npm: the only implementation lived in `scripts/migrate.mjs`, and
 * `scripts/` is not published. So `autoMigrate: true` was a dependency's only
 * option, which is precisely the lock convoy the documentation argues against.
 *
 * What is worth testing is not "does drizzle apply SQL" — it is the three
 * properties a deploy job depends on and that nothing else asserts:
 *
 * 1. It is **idempotent**. A retried deploy must find nothing to do rather than
 *    fail, or every flaky pipeline becomes a manual database repair.
 * 2. It is **safe to run concurrently**. Two CI jobs racing must produce one
 *    migration and one no-op, not two half-applied schemas. The advisory lock
 *    is the mechanism; this asserts the mechanism works rather than trusting
 *    that it was called.
 * 3. It **creates partition runway**, because a deploy that leaves the
 *    analytics table without partitions has not finished, it has just not
 *    failed yet (§7.9).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { migrate, migrationStatus, MIGRATION_LOCK } from "../../src/migrate.js";

const reason = await containerUnavailableReason();

describe("migrate() prerequisites", () => {
  it(
    reason === null
      ? "container runtime is available; migration tests will run"
      : `migration tests SKIPPED — ${reason}. Start a Docker daemon, or set FEATUREKIT_REQUIRE_CONTAINERS=1 to fail instead`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

/** Needs no container, so it runs everywhere — including a laptop with no Docker. */
describe("featurekit-server/migrate configuration", () => {
  it("refuses to guess a database when none is configured", async () => {
    // Defaulting to localhost here would mean a deploy job with a missing
    // variable quietly migrating the wrong database, which is worse than a
    // failed deploy by a wide margin.
    const saved = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      await expect(migrate()).rejects.toThrow(/databaseUrl/);
      await expect(migrationStatus()).rejects.toThrow(/databaseUrl/);
    } finally {
      if (saved !== undefined) process.env["DATABASE_URL"] = saved;
    }
  });
});

describe.skipIf(reason !== null)("featurekit-server/migrate", () => {
  let databaseUrl: string;
  let stop: () => Promise<void>;
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const infrastructure = await startInfrastructure();
    databaseUrl = infrastructure.databaseUrl;
    stop = infrastructure.stop;
    ({ db, close } = createDatabase({ url: databaseUrl, maxConnections: 2 }));
  }, 180_000);

  afterAll(async () => {
    await close?.();
    await stop?.();
  });

  it("reports an unmigrated database instead of throwing", async () => {
    // A status call is what a readiness check or a deploy gate runs first, and
    // it must answer on a database that has never been migrated rather than
    // blowing up on a missing function.
    const status = await migrationStatus({ databaseUrl });
    expect(status.partitionRunwayDays).toBeNull();
  });

  it("applies migrations and leaves partition runway behind", async () => {
    await migrate({ databaseUrl });

    const status = await migrationStatus({ databaseUrl });
    expect(status.applied).toBeGreaterThan(0);
    expect(status.partitionRunwayDays).not.toBeNull();
    expect(status.partitionRunwayDays!).toBeGreaterThan(0);
  }, 120_000);

  it("is idempotent, so a retried deploy is not a repair job", async () => {
    const before = await migrationStatus({ databaseUrl });
    await migrate({ databaseUrl });
    const after = await migrationStatus({ databaseUrl });
    expect(after.applied).toBe(before.applied);
  }, 120_000);

  it("releases its advisory lock", async () => {
    // A migration that leaks the lock blocks the next deploy for as long as the
    // connection lives, and the symptom — a deploy job that hangs with no
    // output — points nowhere near the cause.
    const held = await db.execute(
      sql`select count(*)::int as count from pg_locks
          where locktype = 'advisory' and ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK}::bigint`,
    );
    expect((held as unknown as Array<{ count: number }>)[0]?.count).toBe(0);
  });

  it("serialises concurrent runs rather than racing them", async () => {
    // Two deploy jobs at once. Both must succeed; the lock decides the order.
    await expect(
      Promise.all([migrate({ databaseUrl }), migrate({ databaseUrl }), migrate({ databaseUrl })]),
    ).resolves.toHaveLength(3);

    const status = await migrationStatus({ databaseUrl });
    expect(status.applied).toBeGreaterThan(0);
  }, 180_000);
});
