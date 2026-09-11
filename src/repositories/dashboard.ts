/**
 * Read models for the dashboard (dashboard/PLAN.md §3).
 *
 * The management API was written for scripts, which fetch one flag and know
 * what they wanted. A table of two hundred flags is a different question, and
 * answering it with two hundred requests is how a dashboard becomes the reason
 * the database is busy.
 *
 * Everything here is a **read**. Writes stay on the existing endpoints, so
 * there is exactly one code path that changes a flag and exactly one that
 * audits it.
 */

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  environments,
  evaluationSummaries,
  flagEnvironments,
  flagTargets,
  flagVariations,
  flags,
  prerequisites,
  segments,
  segmentRules,
  targetingRules,
} from "../db/schema.js";
import { HttpError } from "../http/router.js";

/* ───────────────────────────── environments ─────────────────────────── */

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

/* ─────────────────────────── the flags table ────────────────────────── */

export interface FlagRow {
  key: string;
  name: string;
  description: string | null;
  kind: string;
  tags: string[];
  temporary: boolean;
  clientAvailable: boolean;
  archived: boolean;
  createdAt: Date;
  /** Absent when the flag predates the environment and has no row in it yet. */
  environment: {
    enabled: boolean;
    version: number;
    updatedAt: Date;
    offVariation: number | null;
    fallthroughVariation: number | null;
    /** `[{ variation, weight }]` out of 100,000, or null for a single variation. */
    fallthroughRollout: { variation: number; weight: number }[] | null;
    ruleCount: number;
    targetCount: number;
    prerequisiteCount: number;
  } | null;
  variations: { idx: number; name: string | null; value: unknown }[];
}

/**
 * Every flag in a project, with its state in one environment.
 *
 * Five queries rather than one join: the counts are three separate one-to-many
 * relationships, and joining them all in one statement multiplies the rows by
 * each other. Five bounded queries and a merge in memory is both faster and
 * readable.
 */
export async function listFlagsForDashboard(
  db: Database,
  projectId: string,
  environmentId: string | null,
  options: { includeArchived?: boolean } = {},
): Promise<FlagRow[]> {
  const where =
    options.includeArchived === true
      ? eq(flags.projectId, projectId)
      : and(eq(flags.projectId, projectId), isNull(flags.archivedAt));

  const flagRows = await db
    .select({
      id: flags.id,
      key: flags.key,
      name: flags.name,
      description: flags.description,
      kind: flags.kind,
      tags: flags.tags,
      temporary: flags.temporary,
      clientAvailable: flags.clientAvailable,
      archivedAt: flags.archivedAt,
      createdAt: flags.createdAt,
    })
    .from(flags)
    .where(where)
    .orderBy(asc(flags.key));

  if (flagRows.length === 0) return [];
  const flagIds = flagRows.map((row) => row.id);

  const variationRows = await db
    .select({
      flagId: flagVariations.flagId,
      idx: flagVariations.idx,
      name: flagVariations.name,
      value: flagVariations.value,
      id: flagVariations.id,
    })
    .from(flagVariations)
    .where(inArray(flagVariations.flagId, flagIds))
    .orderBy(asc(flagVariations.idx));

  /** variation id → its index, so environment rows can speak indices. */
  const indexById = new Map(variationRows.map((row) => [row.id, row.idx]));
  const variationsByFlag = new Map<string, FlagRow["variations"]>();
  for (const row of variationRows) {
    const list = variationsByFlag.get(row.flagId) ?? [];
    list.push({ idx: row.idx, name: row.name, value: row.value });
    variationsByFlag.set(row.flagId, list);
  }

  const environmentRows =
    environmentId === null
      ? []
      : await db
          .select({
            id: flagEnvironments.id,
            flagId: flagEnvironments.flagId,
            enabled: flagEnvironments.enabled,
            version: flagEnvironments.version,
            updatedAt: flagEnvironments.updatedAt,
            offVariationId: flagEnvironments.offVariationId,
            fallthroughVariationId: flagEnvironments.fallthroughVariationId,
            fallthroughRollout: flagEnvironments.fallthroughRollout,
          })
          .from(flagEnvironments)
          .where(
            and(
              eq(flagEnvironments.environmentId, environmentId),
              inArray(flagEnvironments.flagId, flagIds),
            ),
          );

  const ids = environmentRows.map((row) => row.id);
  const count = sql<number>`count(*)::int`;
  const [ruleCounts, targetCounts, prerequisiteCounts] = await Promise.all([
    tally(
      ids.length === 0
        ? []
        : db
            .select({ id: targetingRules.flagEnvironmentId, count })
            .from(targetingRules)
            .where(inArray(targetingRules.flagEnvironmentId, ids))
            .groupBy(targetingRules.flagEnvironmentId),
    ),
    tally(
      ids.length === 0
        ? []
        : db
            .select({ id: flagTargets.flagEnvironmentId, count })
            .from(flagTargets)
            .where(inArray(flagTargets.flagEnvironmentId, ids))
            .groupBy(flagTargets.flagEnvironmentId),
    ),
    tally(
      ids.length === 0
        ? []
        : db
            .select({ id: prerequisites.flagEnvironmentId, count })
            .from(prerequisites)
            .where(inArray(prerequisites.flagEnvironmentId, ids))
            .groupBy(prerequisites.flagEnvironmentId),
    ),
  ]);

  const environmentByFlag = new Map(environmentRows.map((row) => [row.flagId, row]));

  return flagRows.map((flag) => {
    const environment = environmentByFlag.get(flag.id);
    return {
      key: flag.key,
      name: flag.name,
      description: flag.description,
      kind: flag.kind,
      tags: flag.tags,
      temporary: flag.temporary,
      clientAvailable: flag.clientAvailable,
      archived: flag.archivedAt !== null,
      createdAt: flag.createdAt,
      variations: variationsByFlag.get(flag.id) ?? [],
      environment:
        environment === undefined
          ? null
          : {
              enabled: environment.enabled,
              version: environment.version,
              updatedAt: environment.updatedAt,
              offVariation: indexOf(indexById, environment.offVariationId),
              fallthroughVariation: indexOf(indexById, environment.fallthroughVariationId),
              fallthroughRollout:
                environment.fallthroughRollout === null
                  ? null
                  : environment.fallthroughRollout.variations.map((v) => ({
                      variation: v.variationIndex,
                      weight: v.weight,
                    })),
              ruleCount: ruleCounts.get(environment.id) ?? 0,
              targetCount: targetCounts.get(environment.id) ?? 0,
              prerequisiteCount: prerequisiteCounts.get(environment.id) ?? 0,
            },
    };
  });
}

/* ───────────────────────── one flag's definition ────────────────────── */

export interface FlagDefinition {
  key: string;
  name: string;
  description: string | null;
  kind: string;
  tags: string[];
  temporary: boolean;
  clientAvailable: boolean;
  archived: boolean;
  createdAt: Date;
  variations: { idx: number; name: string | null; value: unknown }[];
}

/**
 * The flag itself, variation **values** included.
 *
 * `readFlagConfig` speaks variation indices, which is correct for a write API
 * and useless for a screen that has to render "25%" or "one-click". Nothing in
 * the API returned the values until this.
 */
export async function readFlagDefinition(
  db: Database,
  projectId: string,
  flagKey: string,
): Promise<FlagDefinition | null> {
  const [flag] = await db
    .select({
      id: flags.id,
      key: flags.key,
      name: flags.name,
      description: flags.description,
      kind: flags.kind,
      tags: flags.tags,
      temporary: flags.temporary,
      clientAvailable: flags.clientAvailable,
      archivedAt: flags.archivedAt,
      createdAt: flags.createdAt,
    })
    .from(flags)
    .where(and(eq(flags.projectId, projectId), eq(flags.key, flagKey)))
    .limit(1);
  if (flag === undefined) return null;

  const variations = await db
    .select({ idx: flagVariations.idx, name: flagVariations.name, value: flagVariations.value })
    .from(flagVariations)
    .where(eq(flagVariations.flagId, flag.id))
    .orderBy(asc(flagVariations.idx));

  return {
    key: flag.key,
    name: flag.name,
    description: flag.description,
    kind: flag.kind,
    tags: flag.tags,
    temporary: flag.temporary,
    clientAvailable: flag.clientAvailable,
    archived: flag.archivedAt !== null,
    createdAt: flag.createdAt,
    variations,
  };
}

/**
 * Undo an archive.
 *
 * Archiving is reversible everywhere else in this product; without this route
 * it was the one destructive action with no way back, which makes people
 * reluctant to tidy up and leaves dead flags in the list forever.
 */
export async function restoreFlag(db: Database, projectId: string, flagKey: string): Promise<void> {
  const restored = await db
    .update(flags)
    .set({ archivedAt: null })
    .where(and(eq(flags.projectId, projectId), eq(flags.key, flagKey)))
    .returning({ id: flags.id });
  if (restored.length === 0) throw new HttpError(404, "NOT_FOUND", "no such flag");
}

/* ──────────────────────────── flag metrics ──────────────────────────── */

export interface FlagMetricPoint {
  bucketAt: Date;
  variationIdx: number | null;
  reason: string;
  count: number;
}

/**
 * What the fleet actually evaluated, from the rollup.
 *
 * The question this answers is "is anything still reading this flag" — the one
 * that decides whether a temporary flag can be deleted. Written by the rollup
 * worker since M4 and, until now, read by nothing.
 */
export async function readFlagMetrics(
  db: Database,
  environmentId: string,
  flagKey: string,
  options: { sinceHours?: number } = {},
): Promise<FlagMetricPoint[]> {
  const since = new Date(Date.now() - (options.sinceHours ?? 24) * 60 * 60 * 1000);
  return db
    .select({
      bucketAt: evaluationSummaries.bucketAt,
      variationIdx: evaluationSummaries.variationIdx,
      reason: evaluationSummaries.reason,
      count: evaluationSummaries.count,
    })
    .from(evaluationSummaries)
    .where(
      and(
        eq(evaluationSummaries.environmentId, environmentId),
        eq(evaluationSummaries.flagKey, flagKey),
        gte(evaluationSummaries.bucketAt, since),
      ),
    )
    .orderBy(asc(evaluationSummaries.bucketAt))
    .limit(5_000);
}

/* ───────────────────────────── segments ─────────────────────────────── */

export interface SegmentDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  external: boolean;
  memberCount: number | null;
  version: number;
  ruleCount: number;
  updatedAt: Date;
}

export async function readSegment(
  db: Database,
  environmentId: string,
  segmentKey: string,
): Promise<SegmentDetail | null> {
  const [segment] = await db
    .select({
      id: segments.id,
      key: segments.key,
      name: segments.name,
      description: segments.description,
      external: segments.external,
      memberCount: segments.memberCount,
      version: segments.version,
      updatedAt: segments.updatedAt,
    })
    .from(segments)
    .where(and(eq(segments.environmentId, environmentId), eq(segments.key, segmentKey)))
    .limit(1);
  if (segment === undefined) return null;

  const [rules] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(segmentRules)
    .where(eq(segmentRules.segmentId, segment.id));

  return { ...segment, ruleCount: rules?.count ?? 0 };
}

/**
 * Delete a segment.
 *
 * Refused while a rule still names it: the compiler treats an unresolved
 * segment as a rule that fails closed, so deleting one out from under a live
 * flag silently changes who is targeted. The caller is told which flags to fix.
 */
export async function deleteSegment(
  db: Database,
  environmentId: string,
  segmentKey: string,
): Promise<void> {
  const [segment] = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.environmentId, environmentId), eq(segments.key, segmentKey)))
    .limit(1);
  if (segment === undefined) throw new HttpError(404, "NOT_FOUND", "no such segment");

  const users = await db
    .select({ flagKey: flags.key })
    .from(targetingRules)
    .innerJoin(flagEnvironments, eq(flagEnvironments.id, targetingRules.flagEnvironmentId))
    .innerJoin(flags, eq(flags.id, flagEnvironments.flagId))
    .where(
      and(
        eq(flagEnvironments.environmentId, environmentId),
        sql`exists (
          select 1 from rule_clauses rc
          where rc.rule_id = ${targetingRules.id}
            and rc.op = 'segmentMatch'
            and rc.values ? ${segmentKey}
        )`,
      ),
    )
    .limit(20);

  if (users.length > 0) {
    throw new HttpError(
      409,
      "SEGMENT_IN_USE",
      `still referenced by: ${[...new Set(users.map((u) => u.flagKey))].join(", ")}`,
    );
  }

  await db.delete(segments).where(eq(segments.id, segment.id));
}

/* ───────────────────────────── plumbing ─────────────────────────────── */

/** `[{ id, count }]` to a lookup, for the three child-table counts above. */
async function tally(
  rows: Promise<Array<{ id: string; count: number }>> | Array<{ id: string; count: number }>,
): Promise<Map<string, number>> {
  return new Map((await rows).map((row) => [row.id, row.count]));
}

function indexOf(indexById: Map<string, number>, variationId: string | null): number | null {
  if (variationId === null) return null;
  return indexById.get(variationId) ?? null;
}

/** Most recently changed flags in an environment — the dashboard's home page. */
export async function recentlyChangedFlags(
  db: Database,
  environmentId: string,
  limit = 10,
): Promise<Array<{ key: string; name: string; enabled: boolean; updatedAt: Date }>> {
  return db
    .select({
      key: flags.key,
      name: flags.name,
      enabled: flagEnvironments.enabled,
      updatedAt: flagEnvironments.updatedAt,
    })
    .from(flagEnvironments)
    .innerJoin(flags, eq(flags.id, flagEnvironments.flagId))
    .where(and(eq(flagEnvironments.environmentId, environmentId), isNull(flags.archivedAt)))
    .orderBy(desc(flagEnvironments.updatedAt))
    .limit(limit);
}
