/**
 * Flag definitions: create, update, archive, restore, and the reads the
 * dashboard lists them with.
 *
 * **Creating a flag creates its per-environment configuration rows in the same
 * transaction**, one per environment, all disabled. A flag with no row in
 * production would get its first production toggle as an INSERT, which has no
 * `expectedVersion` to check — so the concurrent-edit protection would not apply
 * to the single most dangerous edit anyone makes.
 *
 * The dashboard reads are one query per table, not one request per flag: a
 * table of two hundred flags must not be the reason the database is busy.
 */

import { and, asc, eq, inArray, sql, desc, gte, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  evaluationSummaries,
  flagTargets,
  prerequisites,
  targetingRules,
} from "../db/schema.js";
import { HttpError } from "../http/router.js";

export async function listFlags(
  db: Database,
  projectId: string,
): Promise<Array<{ key: string; name: string; kind: string; archived: boolean }>> {
  const rows = await db
    .select({
      key: flags.key,
      name: flags.name,
      kind: flags.kind,
      archivedAt: flags.archivedAt,
    })
    .from(flags)
    .where(eq(flags.projectId, projectId))
    .orderBy(asc(flags.key));
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    kind: r.kind,
    archived: r.archivedAt !== null,
  }));
}

export interface CreateFlagInput {
  projectId: string;
  key: string;
  name: string;
  description?: string | undefined;
  kind: "boolean" | "string" | "number" | "json";
  temporary: boolean;
  clientAvailable: boolean;
  tags: string[];
  variations: Array<{ name?: string | undefined; value: unknown }>;
}

export async function createFlag(db: Database, input: CreateFlagInput): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [flag] = await tx
      .insert(flags)
      .values({
        projectId: input.projectId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        temporary: input.temporary,
        clientAvailable: input.clientAvailable,
        tags: input.tags,
      })
      .onConflictDoNothing()
      .returning({ id: flags.id });
    if (flag === undefined) throw new HttpError(409, "ALREADY_EXISTS", "a flag with that key exists");

    const variations = await tx
      .insert(flagVariations)
      .values(
        input.variations.map((variation, idx) => ({
          flagId: flag.id,
          idx,
          name: variation.name ?? null,
          value: variation.value as never,
        })),
      )
      .returning({ id: flagVariations.id, idx: flagVariations.idx });

    const environmentRows = await tx
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, input.projectId));

    // Off by default, serving variation 0 when off. A flag that arrives enabled
    // is a flag that shipped a feature the moment somebody created it.
    const offVariationId = variations.find((v) => v.idx === 0)?.id ?? null;
    const fallthroughId = variations.find((v) => v.idx === variations.length - 1)?.id ?? null;
    if (environmentRows.length > 0) {
      await tx.insert(flagEnvironments).values(
        environmentRows.map((environment) => ({
          flagId: flag.id,
          environmentId: environment.id,
          enabled: false,
          offVariationId,
          fallthroughVariationId: fallthroughId,
        })),
      );
    }
    return flag;
  });
}

export interface UpdateFlagDefinitionInput {
  projectId: string;
  key: string;
  name?: string | undefined;
  description?: string | null | undefined;
  temporary?: boolean | undefined;
  clientAvailable?: boolean | undefined;
  tags?: string[] | undefined;
  variations?: Array<{ name?: string | undefined; value: unknown }> | undefined;
}

export async function updateFlagDefinition(
  db: Database,
  input: UpdateFlagDefinitionInput,
): Promise<{ id: string } | null> {
  return db.transaction(async (tx) => {
    const [flag] = await tx
      .select({ id: flags.id })
      .from(flags)
      .where(and(eq(flags.projectId, input.projectId), eq(flags.key, input.key)))
      .limit(1);
    if (!flag) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates["name"] = input.name;
    if (input.description !== undefined) updates["description"] = input.description;
    if (input.temporary !== undefined) updates["temporary"] = input.temporary;
    if (input.clientAvailable !== undefined) updates["clientAvailable"] = input.clientAvailable;
    if (input.tags !== undefined) updates["tags"] = input.tags;

    await tx.update(flags).set(updates).where(eq(flags.id, flag.id));

    if (input.variations !== undefined && input.variations.length > 0) {
      for (let idx = 0; idx < input.variations.length; idx++) {
        const v = input.variations[idx]!;
        await tx
          .insert(flagVariations)
          .values({
            flagId: flag.id,
            idx,
            name: v.name ?? null,
            value: v.value as never,
          })
          .onConflictDoUpdate({
            target: [flagVariations.flagId, flagVariations.idx],
            set: {
              name: v.name ?? null,
              value: v.value as never,
            },
          });
      }
    }

    return flag;
  });
}

export async function archiveFlag(db: Database, projectId: string, flagKey: string): Promise<void> {
  const result = await db
    .update(flags)
    .set({ archivedAt: new Date() })
    .where(and(eq(flags.projectId, projectId), eq(flags.key, flagKey)))
    .returning({ id: flags.id });
  if (result.length === 0) throw new HttpError(404, "NOT_FOUND", "no such flag");
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

export async function flagKeysIn(db: Database, projectId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ key: flags.key })
    .from(flags)
    .where(and(eq(flags.projectId, projectId), inArray(flags.key, keys)));
  return new Set(rows.map((r) => r.key));
}

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
