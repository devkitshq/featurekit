/**
 * `featkit/migrate` — the migration step, as a function you can call (§9, §16).
 *
 * **Migrations are a deploy step, not something a booting node does.** Every
 * node running them on startup is a lock convoy at best: N nodes take the same
 * locks in the same order at the same moment, and on a large table one holds an
 * ACCESS EXCLUSIVE lock while the rest queue behind it — during a deploy, while
 * traffic is shifting.
 *
 * That advice was previously unfollowable for anyone who installed featkit
 * from npm. The separate step lived in `scripts/migrate.mjs`, and `scripts/` is
 * not in the published package — so `autoMigrate: true` was the only option a
 * dependency had, which is precisely the shape the advice argues against. This
 * module is the fix: one implementation, three callers.
 *
 * ```ts
 * // migrate.js, run as a deploy job before the new nodes start
 * import { migrate } from "featkit/migrate";
 * await migrate();
 * ```
 *
 * ```bash
 * node -e 'import("featkit/migrate").then(m => m.migrate())'
 * ```
 *
 * **A separate entry point because of what it does not load.** `featkit`'s
 * main entry is the control plane, so importing it to run one deploy job pulls
 * ioredis, pino, prom-client and the whole route layer. This reaches the
 * Postgres driver and Drizzle, because migrating is what it does, and nothing
 * else.
 *
 * Safe to run concurrently. It takes a Postgres advisory lock first, so a
 * retried deploy or two CI jobs racing produce one migration and one no-op
 * rather than two half-applied schemas.
 *
 * @see docs/ops/deployment.md
 */

import { sql } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, runMigrations } from "./db/client.js";

/** `dist/migrate.js` → the package root, where `drizzle/` lives. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Any stable 64-bit constant; it only has to agree with the other callers.
 *
 * Exported because `FeatkitServer` and any deploy job must take the *same*
 * lock, or holding one is decoration.
 */
export const MIGRATION_LOCK = 8_474_920_310_001n;

/** Days of partitions created ahead. A deploy that leaves none has not finished. */
const DEFAULT_PARTITION_PREMAKE_DAYS = 7;

export interface MigrateOptions {
  /** Defaults to `DATABASE_URL`. */
  databaseUrl?: string;
  /** Where the SQL lives. Defaults to the package's own `drizzle/`. */
  migrationsFolder?: string;
  /** How far ahead to create analytics partitions. */
  partitionPremakeDays?: number;
  /** Progress, one line at a time. Silent by default. */
  log?: (message: string) => void;
}

export interface MigrationStatus {
  applied: number;
  /** `null` when the runway function is not installed yet — an unmigrated database. */
  partitionRunwayDays: number | null;
}

function urlFrom(options: MigrateOptions | undefined): string {
  const url = options?.databaseUrl ?? process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("featkit: migrate() needs a databaseUrl, or DATABASE_URL in the environment");
  }
  return url;
}

/**
 * Apply every outstanding migration, then make sure the analytics table has
 * partitions to write into.
 *
 * The partition step is part of a successful migration rather than a separate
 * concern: a deploy that leaves the analytics table without partitions has not
 * finished, it has just not failed yet (§7.9).
 *
 * Forward-only, and additive by policy — old code runs against the new schema
 * for the length of a rollout, which is what makes `migrate → deploy new →
 * drain old` safe.
 */
export async function migrate(options: MigrateOptions = {}): Promise<void> {
  const log = options.log ?? ((): void => undefined);
  const { db, close } = createDatabase({ url: urlFrom(options), maxConnections: 1 });
  try {
    // Advisory locks live for the session, so this is released when the
    // connection closes — including if the process is killed mid-migration.
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      await runMigrations(db, options.migrationsFolder ?? join(PACKAGE_ROOT, "drizzle"));
      const premake = options.partitionPremakeDays ?? DEFAULT_PARTITION_PREMAKE_DAYS;
      try {
        await db.execute(sql`select featkit_ensure_partitions(${premake})`);
      } catch {
        await db.execute(sql`select featurekit_ensure_partitions(${premake})`);
      }
      log("migrations applied");
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`);
    }
  } finally {
    await close();
  }
}

/**
 * What is applied and how much partition runway is left. Changes nothing.
 *
 * Worth running as a scheduled check rather than only at deploy time: partition
 * runway shrinks on its own, and the failure — writes to the analytics table
 * with no partition to land in — arrives without a deploy to blame.
 */
export async function migrationStatus(options: MigrateOptions = {}): Promise<MigrationStatus> {
  const { db, close } = createDatabase({ url: urlFrom(options), maxConnections: 1 });
  try {
    let appliedCount = 0;
    try {
      const applied = await db.execute(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      const count = (applied as unknown as Array<{ count?: unknown }>)[0]?.count;
      appliedCount = typeof count === "number" ? count : 0;
    } catch {
      // The migrations table does not exist on an unmigrated database.
      appliedCount = 0;
    }
    let partitionRunwayDays: number | null = null;
    try {
      let runway: unknown;
      try {
        runway = await db.execute(sql`select featkit_partition_runway_days() as days`);
      } catch {
        runway = await db.execute(sql`select featurekit_partition_runway_days() as days`);
      }
      const days = (runway as unknown as Array<{ days?: unknown }>)[0]?.days;
      partitionRunwayDays = typeof days === "number" ? days : null;
    } catch {
      // The function ships with the migrations, so its absence means the
      // database has not been migrated — a status, not an error.
      partitionRunwayDays = null;
    }
    return {
      applied: appliedCount,
      partitionRunwayDays,
    };
  } finally {
    await close();
  }
}
