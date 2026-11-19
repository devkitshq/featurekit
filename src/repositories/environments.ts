/**
 * Environments, and the operational queries.
 *
 * The important function here is `nextSnapshotVersion`. Patches need a
 * monotonic per-environment version, and **it must be one statement.** `SELECT`
 * then `UPDATE` from two API nodes compiling the same environment at the same
 * moment hands both the same version, and two different snapshots then exist
 * claiming to be version 41. Every SDK's version guard accepts whichever arrives
 * first and rejects the other *permanently* — a flag change that silently never
 * lands.
 */

import { eq, sql, and, asc } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { environments, flagEnvironments, flags, projects } from "../db/schema.js";
import { randomBytes } from "node:crypto";
import { HttpError } from "../http/router.js";

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
    throw new Error(`featurekit: no environment ${environmentId} to version`);
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
      sql`select featurekit_partition_runway_days() as days`,
    )) as unknown as Array<{ days: number | string | null }>;
    const raw = result[0]?.days;
    if (raw === null || raw === undefined) return -1;
    const days = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
    return Number.isFinite(days) ? days : -1;
  } catch {
    return -1;
  }
}

/**
 * A per-environment bucketing salt, generated once and never rotated casually.
 *
 * Rotating it re-randomises every percentage rollout in the environment — which
 * is occasionally what you want and usually catastrophic. It is
 * generated here so no deployment can accidentally share one across
 * environments, which would make staging and production bucket identically.
 */
export async function createEnvironment(
  db: Database,
  input: { projectId: string; key: string; name: string; color?: string; isProduction: boolean },
): Promise<{ id: string; key: string }> {
  return db.transaction(async (tx) => {
    const [environment] = await tx
      .insert(environments)
      .values({
        projectId: input.projectId,
        key: input.key,
        name: input.name,
        color: input.color ?? null,
        isProduction: input.isProduction,
        bucketSalt: randomBytes(16).toString("hex"),
      })
      .onConflictDoNothing()
      .returning({ id: environments.id, key: environments.key });
    if (environment === undefined) {
      throw new HttpError(409, "ALREADY_EXISTS", "an environment with that key exists");
    }

    // Every existing flag gets a configuration row here, for the same reason
    // new flags get one per environment: the first toggle must be an UPDATE.
    const existing = await tx
      .select({ id: flags.id })
      .from(flags)
      .where(eq(flags.projectId, input.projectId));
    if (existing.length > 0) {
      await tx.insert(flagEnvironments).values(
        existing.map((flag) => ({
          flagId: flag.id,
          environmentId: environment.id,
          enabled: false,
        })),
      );
    }
    return environment;
  });
}

export async function findEnvironmentByKeys(
  db: Database,
  projectKey: string,
  environmentKey: string,
): Promise<{ id: string; projectId: string; key: string; isProduction: boolean } | null> {
  const [row] = await db
    .select({
      id: environments.id,
      projectId: environments.projectId,
      key: environments.key,
      isProduction: environments.isProduction,
    })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(projects.key, projectKey), eq(environments.key, environmentKey)))
    .limit(1);
  return row ?? null;
}

export async function environmentIdsFor(db: Database, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  return rows.map((r) => r.id);
}

export interface EnvironmentSummary {
  id: string;
  key: string;
  name: string;
  color: string | null;
  isProduction: boolean;
  snapshotVersion: number;
  createdAt: Date;
}

export async function listProjectEnvironments(
  db: Database,
  projectId: string,
): Promise<EnvironmentSummary[]> {
  return db
    .select({
      id: environments.id,
      key: environments.key,
      name: environments.name,
      color: environments.color,
      isProduction: environments.isProduction,
      snapshotVersion: environments.snapshotVersion,
      createdAt: environments.createdAt,
    })
    .from(environments)
    .where(eq(environments.projectId, projectId))
    // Production last, so the switcher's first entry is the safe one.
    .orderBy(asc(environments.isProduction), asc(environments.key));
}
