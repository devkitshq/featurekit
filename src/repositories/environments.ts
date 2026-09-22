/**
 * Environment-level writes and the operational queries (§10.4, §16).
 *
 * The important function here is `nextSnapshotVersion`. §10.4 requires a
 * monotonic per-environment version, and `drizzle/0002_snapshot_version.sql`
 * added the column for it — this is the code that finally uses it.
 *
 * **It must be one statement.** `SELECT` then `UPDATE` from two API nodes
 * compiling the same environment at the same moment hands both the same
 * version, and two different snapshots then exist claiming to be version 41.
 * Every SDK's version guard accepts whichever arrives first and rejects the
 * other *permanently*, because the second is no longer greater. That is a flag
 * change that silently never lands — the §5 "lost update", in the one place it
 * is hardest to notice.
 */

import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { environments } from "../db/schema.js";

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  key: string;
  isProduction: boolean;
  bucketSalt: string;
  snapshotVersion: number;
}

/**
 * Allocate the next snapshot version, atomically.
 *
 * `UPDATE ... RETURNING` is the whole point: Postgres serialises concurrent
 * updates to the same row, so two callers get 41 and 42, never 41 and 41.
 */
export async function nextSnapshotVersion(db: Database, environmentId: string): Promise<number> {
  const rows = await db
    .update(environments)
    .set({ snapshotVersion: sql`${environments.snapshotVersion} + 1` })
    .where(eq(environments.id, environmentId))
    .returning({ version: environments.snapshotVersion });

  const version = rows[0]?.version;
  if (version === undefined) {
    throw new Error(`togglekit: no environment ${environmentId} to version`);
  }
  return version;
}

export async function getEnvironment(
  db: Database,
  environmentId: string,
): Promise<EnvironmentRecord | null> {
  const rows = await db
    .select({
      id: environments.id,
      projectId: environments.projectId,
      key: environments.key,
      isProduction: environments.isProduction,
      bucketSalt: environments.bucketSalt,
      snapshotVersion: environments.snapshotVersion,
    })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return rows[0] ?? null;
}

/** Every environment, for the startup warm and the snapshot-age gauges. */
export async function listEnvironments(db: Database): Promise<EnvironmentRecord[]> {
  return db
    .select({
      id: environments.id,
      projectId: environments.projectId,
      key: environments.key,
      isProduction: environments.isProduction,
      bucketSalt: environments.bucketSalt,
      snapshotVersion: environments.snapshotVersion,
    })
    .from(environments);
}

/* ─────────────────────────── operational queries ─────────────────────── */

/** Cheapest possible round trip. Readiness, not a health opinion. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

/**
 * Days of pre-created `evaluation_summaries` partitions remaining.
 *
 * Backed by the SQL function installed in `drizzle/0001_partitioning.sql`. A
 * missing function reads as `-1`, which readiness treats as failed — the
 * migration not having run is exactly the state that must not pass a probe.
 */
export async function partitionRunwayDays(db: Database): Promise<number> {
  try {
    const result = (await db.execute(
      sql`select togglekit_partition_runway_days() as days`,
    )) as unknown as Array<{ days: number | string | null }>;
    const raw = result[0]?.days;
    if (raw === null || raw === undefined) return -1;
    const days = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
    return Number.isFinite(days) ? days : -1;
  } catch {
    return -1;
  }
}
