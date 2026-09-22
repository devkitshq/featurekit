/**
 * Loading the compiler's input from Postgres.
 *
 * Deliberately thin: it fetches rows and reshapes nothing. All the judgement —
 * index resolution, cycle rejection, filter selection — lives in
 * `src/snapshot/compile.ts`, which is pure and therefore testable without a
 * database. This layer is the part that needs a container to test, so it is
 * kept as small as it can be.
 *
 * Everything is scoped to one environment and fetched in a single round of
 * queries rather than per-flag, because a compile touches every flag in the
 * environment by definition.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  environments,
  flagEnvironments,
  flagTargets,
  flagVariations,
  flags,
  prerequisites,
  projects,
  ruleClauses,
  segmentMembers,
  segmentRuleClauses,
  segmentRules,
  segments,
  targetingRules,
} from "../db/schema.js";
import type { CompilerInput } from "../snapshot/compile.js";

/**
 * Raised when one environment's segments hold more members than a compile is
 * willing to materialise.
 *
 * **Loud, not lossy.** The alternative — truncate and build a filter from part
 * of the list — produces a snapshot that answers "not a member" for real
 * members, and under a negated segment clause that grants a gated feature to
 * exactly the people who should not have it (§22.3). A compile that throws
 * leaves the previous snapshot serving, which is the correct failure: stale
 * beats wrong, and both beat a silent wrong answer.
 */
export class SegmentTooLargeError extends Error {
  constructor(
    readonly segmentKey: string,
    readonly loaded: number,
    readonly limit: number,
  ) {
    super(
      `togglekit: segment ${segmentKey} exceeds the compile ceiling of ${limit} members ` +
        `(loaded ${loaded}). Raise SEGMENT_MEMBER_CEILING if this node has the heap for it, ` +
        `or split the segment. The previous snapshot keeps serving until this is resolved.`,
    );
    this.name = "SegmentTooLargeError";
  }
}

export interface LoadCompilerInputOptions {
  /**
   * Rows per round trip when reading segment members.
   *
   * Not a performance knob so much as a memory one: a single
   * `SELECT ... WHERE segment_id IN (...)` over a ten-million-member segment
   * materialises every row in one result set before the driver hands back an
   * array, which is hundreds of megabytes inside a process whose whole job is
   * to stay responsive.
   */
  memberPageSize?: number;
  /** Hard ceiling across all of an environment's segments. */
  maxSegmentMembers?: number;
}

export class EnvironmentNotFoundError extends Error {
  constructor(projectKey: string, environmentKey: string) {
    super(`togglekit: no environment ${projectKey}/${environmentKey}`);
    this.name = "EnvironmentNotFoundError";
  }
}

/** Load everything `compileSnapshot` needs for one environment. */
export async function loadCompilerInput(
  db: Database,
  environmentId: string,
  options: LoadCompilerInputOptions = {},
): Promise<CompilerInput> {
  const [environment] = await db
    .select({
      id: environments.id,
      key: environments.key,
      bucketSalt: environments.bucketSalt,
      projectId: environments.projectId,
    })
    .from(environments)
    .where(eq(environments.id, environmentId));

  if (environment === undefined) {
    throw new EnvironmentNotFoundError("?", environmentId);
  }

  // Archived flags are dropped by the compiler, but filtering here too keeps
  // the payload off the wire for projects with a long archive tail.
  const flagRows = await db
    .select({
      id: flags.id,
      key: flags.key,
      kind: flags.kind,
      archivedAt: flags.archivedAt,
      clientAvailable: flags.clientAvailable,
    })
    .from(flags)
    .where(and(eq(flags.projectId, environment.projectId), isNull(flags.archivedAt)));

  const flagIds = flagRows.map((f) => f.id);

  const [variationRows, configRows, segmentRows] = await Promise.all([
    flagIds.length === 0
      ? []
      : db
          .select({
            id: flagVariations.id,
            flagId: flagVariations.flagId,
            idx: flagVariations.idx,
            value: flagVariations.value,
          })
          .from(flagVariations)
          .where(inArray(flagVariations.flagId, flagIds)),
    db
      .select({
        id: flagEnvironments.id,
        flagId: flagEnvironments.flagId,
        environmentId: flagEnvironments.environmentId,
        enabled: flagEnvironments.enabled,
        offVariationId: flagEnvironments.offVariationId,
        fallthroughVariationId: flagEnvironments.fallthroughVariationId,
        fallthroughRollout: flagEnvironments.fallthroughRollout,
        version: flagEnvironments.version,
      })
      .from(flagEnvironments)
      .where(eq(flagEnvironments.environmentId, environmentId)),
    db
      .select({
        id: segments.id,
        key: segments.key,
        environmentId: segments.environmentId,
        version: segments.version,
      })
      .from(segments)
      .where(eq(segments.environmentId, environmentId)),
  ]);

  const feIds = configRows.map((c) => c.id);
  const segmentIds = segmentRows.map((s) => s.id);

  const [targetRows, ruleRows, prereqRows, memberRows, segRuleRows] = await Promise.all([
    feIds.length === 0
      ? []
      : db
          .select({
            flagEnvironmentId: flagTargets.flagEnvironmentId,
            variationId: flagTargets.variationId,
            contextKind: flagTargets.contextKind,
            contextKey: flagTargets.contextKey,
          })
          .from(flagTargets)
          .where(inArray(flagTargets.flagEnvironmentId, feIds)),
    feIds.length === 0
      ? []
      : db
          .select({
            id: targetingRules.id,
            flagEnvironmentId: targetingRules.flagEnvironmentId,
            idx: targetingRules.idx,
            variationId: targetingRules.variationId,
            rollout: targetingRules.rollout,
          })
          .from(targetingRules)
          .where(inArray(targetingRules.flagEnvironmentId, feIds)),
    feIds.length === 0
      ? []
      : db
          .select({
            flagEnvironmentId: prerequisites.flagEnvironmentId,
            prerequisiteFlagId: prerequisites.prerequisiteFlagId,
            requiredVariationId: prerequisites.requiredVariationId,
          })
          .from(prerequisites)
          .where(inArray(prerequisites.flagEnvironmentId, feIds)),
    loadSegmentMembers(db, segmentRows, options),
    segmentIds.length === 0
      ? []
      : db
          .select({
            id: segmentRules.id,
            segmentId: segmentRules.segmentId,
            idx: segmentRules.idx,
            weight: segmentRules.weight,
            bucketBy: segmentRules.bucketBy,
            contextKind: segmentRules.contextKind,
          })
          .from(segmentRules)
          .where(inArray(segmentRules.segmentId, segmentIds)),
  ]);

  const ruleIds = ruleRows.map((r) => r.id);
  const segRuleIds = segRuleRows.map((r) => r.id);

  const [clauseRows, segClauseRows] = await Promise.all([
    ruleIds.length === 0
      ? []
      : db
          .select({
            ruleId: ruleClauses.ruleId,
            idx: ruleClauses.idx,
            contextKind: ruleClauses.contextKind,
            attribute: ruleClauses.attribute,
            op: ruleClauses.op,
            values: ruleClauses.values,
            negate: ruleClauses.negate,
          })
          .from(ruleClauses)
          .where(inArray(ruleClauses.ruleId, ruleIds)),
    segRuleIds.length === 0
      ? []
      : db
          .select({
            segmentRuleId: segmentRuleClauses.segmentRuleId,
            idx: segmentRuleClauses.idx,
            contextKind: segmentRuleClauses.contextKind,
            attribute: segmentRuleClauses.attribute,
            op: segmentRuleClauses.op,
            values: segmentRuleClauses.values,
            negate: segmentRuleClauses.negate,
          })
          .from(segmentRuleClauses)
          .where(inArray(segmentRuleClauses.segmentRuleId, segRuleIds)),
  ]);

  return {
    environment: {
      id: environment.id,
      key: environment.key,
      bucketSalt: environment.bucketSalt,
    },
    flags: flagRows,
    variations: variationRows,
    flagEnvironments: configRows,
    targets: targetRows,
    rules: ruleRows,
    clauses: clauseRows,
    prerequisites: prereqRows,
    segments: segmentRows,
    segmentMembers: memberRows,
    segmentRules: segRuleRows,
    segmentRuleClauses: segClauseRows,
  };
}

/** Resolve `project/environment` keys to an environment id. */
export async function findEnvironment(
  db: Database,
  projectKey: string,
  environmentKey: string,
): Promise<{ id: string; projectId: string } | null> {
  const [match] = await db
    .select({ id: environments.id, projectId: environments.projectId })
    .from(environments)
    .innerJoin(projects, eq(environments.projectId, projects.id))
    .where(and(eq(projects.key, projectKey), eq(environments.key, environmentKey)))
    .limit(1);

  return match ?? null;
}

/* ─────────────────────── paginated member loading ────────────────────── */

export interface SegmentMemberRowOut {
  segmentId: string;
  contextKind: string;
  contextKey: string;
  excluded: boolean;
}

/**
 * Read every segment's members, one page at a time.
 *
 * Keyset pagination on `(context_kind, context_key)` within a segment, which is
 * the table's primary key — so each page is an index range scan rather than an
 * `OFFSET` that re-walks everything it already skipped. Ten million members is
 * two hundred bounded queries instead of one query that returns a hundred
 * megabytes into a single array.
 *
 * The ceiling is checked as pages arrive, so an oversized segment is refused
 * after one page rather than after the whole thing is in memory.
 */
async function loadSegmentMembers(
  db: Database,
  segmentRows: ReadonlyArray<{ id: string; key: string }>,
  options: LoadCompilerInputOptions,
): Promise<SegmentMemberRowOut[]> {
  const pageSize = options.memberPageSize ?? 25_000;
  const ceiling = options.maxSegmentMembers ?? 2_000_000;

  const out: SegmentMemberRowOut[] = [];
  for (const segment of segmentRows) {
    let cursorKind = "";
    let cursorKey = "";
    let loadedForSegment = 0;

    for (;;) {
      const page = await db
        .select({
          segmentId: segmentMembers.segmentId,
          contextKind: segmentMembers.contextKind,
          contextKey: segmentMembers.contextKey,
          excluded: segmentMembers.excluded,
        })
        .from(segmentMembers)
        .where(
          and(
            eq(segmentMembers.segmentId, segment.id),
            // Strictly after the last row of the previous page, in primary-key
            // order. Row-value comparison, so it stays a single index seek.
            sql`(${segmentMembers.contextKind}, ${segmentMembers.contextKey}) > (${cursorKind}, ${cursorKey})`,
          ),
        )
        .orderBy(asc(segmentMembers.contextKind), asc(segmentMembers.contextKey))
        .limit(pageSize);

      if (page.length === 0) break;

      loadedForSegment += page.length;
      if (loadedForSegment > ceiling) {
        throw new SegmentTooLargeError(segment.key, loadedForSegment, ceiling);
      }

      for (const row of page) out.push(row);

      const last = page[page.length - 1]!;
      cursorKind = last.contextKind;
      cursorKey = last.contextKey;
      if (page.length < pageSize) break;
    }
  }
  return out;
}
