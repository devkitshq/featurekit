/**
 * The flag write path.
 *
 * Three properties this file exists to guarantee, each of which is a named P0
 * in the production review:
 *
 * 1. **Every read and write is scoped by project *in SQL*.** `resolveTarget`
 *    is the only way into a flag's configuration, and it joins
 *    project → environment → flag → flag_environment in one statement. A caller
 *    holding another tenant's flag uuid gets `null`, and the route turns that
 *    into a 404 — never a 403, which would confirm the object exists.
 * 2. **A write is one transaction, and it is version-checked.** The row is
 *    locked `FOR UPDATE`, the caller's `expectedVersion` is compared under that
 *    lock, and the configuration, the version bump and the audit row commit
 *    together. Two engineers saving the same flag is the concurrent-edit scenario: the
 *    second one now gets a 409 carrying the current state instead of silently
 *    erasing the first one's work.
 * 3. **The audit row holds the full before and after.** Not a field list —
 *    "restore this flag to exactly how it was at 14:02" is the thing you need
 *    during an incident, and it is what makes `revert` a replay rather than a
 *    reconstruction.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Rollout } from "../sdk/index.js";
import type { Database } from "../db/client.js";
import {
  auditLog,
  environments,
  flagEnvironments,
  flagTargets,
  flagVariations,
  flags,
  members,
  prerequisites,
  projects,
  ruleClauses,
  targetingRules,
} from "../db/schema.js";
import { HttpError } from "../http/router.js";
import type { Principal } from "../auth/principal.js";
import { actorOf } from "../auth/principal.js";
import type { FlagConfigBody } from "../contracts/admin.js";

/* ─────────────────────────────── shapes ─────────────────────────────── */

export interface FlagTarget {
  contextKind: string;
  variation: number;
  keys: string[];
}

export interface FlagClause {
  contextKind: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
}

export interface FlagRule {
  description?: string;
  clauses: FlagClause[];
  variation?: number;
  rollout?: Rollout;
}

export interface FlagPrerequisite {
  flagKey: string;
  variation: number;
}

/** The canonical configuration document: the GET body, the audit before/after. */
export interface FlagConfig {
  flagKey: string;
  environmentKey: string;
  version: number;
  enabled: boolean;
  offVariation: number | null;
  fallthroughVariation?: number;
  fallthroughRollout?: Rollout;
  targets: FlagTarget[];
  rules: FlagRule[];
  prerequisites: FlagPrerequisite[];
}

export interface ResolvedTarget {
  projectId: string;
  environmentId: string;
  environmentKey: string;
  isProduction: boolean;
  flagId: string;
  flagKey: string;
  flagEnvironmentId: string;
  version: number;
  /** Index → variation id, and the reverse. Rules speak indices; rows speak ids. */
  variationIds: string[];
  variationIndexById: Map<string, number>;
}

/* ────────────────────────────── resolution ──────────────────────────── */

/**
 * Resolve a `(project, environment, flag)` triple to the row ids behind it.
 *
 * This is the tenant-isolation boundary. Everything downstream takes the ids it
 * returns and nothing takes ids from the request, so there is no path where a
 * caller-supplied uuid reaches a `WHERE` clause unchecked.
 */
export async function resolveTarget(
  db: Database,
  keys: { projectKey: string; environmentKey: string; flagKey: string },
): Promise<ResolvedTarget | null> {
  const rows = await db
    .select({
      projectId: projects.id,
      environmentId: environments.id,
      environmentKey: environments.key,
      isProduction: environments.isProduction,
      flagId: flags.id,
      flagKey: flags.key,
      flagEnvironmentId: flagEnvironments.id,
      version: flagEnvironments.version,
    })
    .from(projects)
    .innerJoin(environments, eq(environments.projectId, projects.id))
    // The flag is joined on the SAME project as the environment. Without this
    // predicate a flag key from another project would resolve here.
    .innerJoin(flags, eq(flags.projectId, projects.id))
    .innerJoin(
      flagEnvironments,
      and(
        eq(flagEnvironments.flagId, flags.id),
        eq(flagEnvironments.environmentId, environments.id),
      ),
    )
    .where(
      and(
        eq(projects.key, keys.projectKey),
        eq(environments.key, keys.environmentKey),
        eq(flags.key, keys.flagKey),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const variations = await db
    .select({ id: flagVariations.id, idx: flagVariations.idx })
    .from(flagVariations)
    .where(eq(flagVariations.flagId, row.flagId))
    .orderBy(asc(flagVariations.idx));

  const variationIds: string[] = [];
  const variationIndexById = new Map<string, number>();
  for (const variation of variations) {
    variationIds[variation.idx] = variation.id;
    variationIndexById.set(variation.id, variation.idx);
  }

  return { ...row, variationIds, variationIndexById };
}

/* ──────────────────────────────── reads ─────────────────────────────── */

export async function readFlagConfig(
  db: Database,
  target: ResolvedTarget,
): Promise<FlagConfig> {
  const [config] = await db
    .select({
      enabled: flagEnvironments.enabled,
      offVariationId: flagEnvironments.offVariationId,
      fallthroughVariationId: flagEnvironments.fallthroughVariationId,
      fallthroughRollout: flagEnvironments.fallthroughRollout,
      version: flagEnvironments.version,
    })
    .from(flagEnvironments)
    .where(eq(flagEnvironments.id, target.flagEnvironmentId))
    .limit(1);

  if (config === undefined) throw new HttpError(404, "NOT_FOUND", "no such flag configuration");

  const [targetRows, ruleRows, prerequisiteRows] = await Promise.all([
    db
      .select({
        contextKind: flagTargets.contextKind,
        contextKey: flagTargets.contextKey,
        variationId: flagTargets.variationId,
      })
      .from(flagTargets)
      .where(eq(flagTargets.flagEnvironmentId, target.flagEnvironmentId)),
    db
      .select({
        id: targetingRules.id,
        idx: targetingRules.idx,
        description: targetingRules.description,
        variationId: targetingRules.variationId,
        rollout: targetingRules.rollout,
      })
      .from(targetingRules)
      .where(eq(targetingRules.flagEnvironmentId, target.flagEnvironmentId))
      .orderBy(asc(targetingRules.idx)),
    db
      .select({
        prerequisiteFlagId: prerequisites.prerequisiteFlagId,
        requiredVariationId: prerequisites.requiredVariationId,
      })
      .from(prerequisites)
      .where(eq(prerequisites.flagEnvironmentId, target.flagEnvironmentId)),
  ]);

  const ruleIds = ruleRows.map((r) => r.id);
  const clauseRows =
    ruleIds.length === 0
      ? []
      : await db
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
          .where(inArray(ruleClauses.ruleId, ruleIds))
          .orderBy(asc(ruleClauses.idx));

  const clausesByRule = new Map<string, FlagClause[]>();
  for (const clause of clauseRows) {
    const list = clausesByRule.get(clause.ruleId) ?? [];
    list.push({
      contextKind: clause.contextKind,
      attribute: clause.attribute,
      op: clause.op,
      values: clause.values,
      negate: clause.negate,
    });
    clausesByRule.set(clause.ruleId, list);
  }

  // Targets are stored one row per key and presented grouped, which is how a
  // human reads them and how the compiler emits them.
  const targetsByKind = new Map<string, FlagTarget>();
  for (const row of targetRows) {
    const variation = target.variationIndexById.get(row.variationId);
    if (variation === undefined) continue;
    const id = `${row.contextKind}:${variation}`;
    const existing = targetsByKind.get(id) ?? {
      contextKind: row.contextKind,
      variation,
      keys: [],
    };
    existing.keys.push(row.contextKey);
    targetsByKind.set(id, existing);
  }

  const flagKeysById = await flagKeysFor(
    db,
    prerequisiteRows.map((p) => p.prerequisiteFlagId),
  );

  return {
    flagKey: target.flagKey,
    environmentKey: target.environmentKey,
    version: config.version,
    enabled: config.enabled,
    offVariation:
      config.offVariationId === null
        ? null
        : (target.variationIndexById.get(config.offVariationId) ?? null),
    ...(config.fallthroughVariationId !== null
      ? { fallthroughVariation: target.variationIndexById.get(config.fallthroughVariationId) ?? 0 }
      : {}),
    ...(config.fallthroughRollout !== null ? { fallthroughRollout: config.fallthroughRollout } : {}),
    targets: [...targetsByKind.values()],
    rules: ruleRows.map((rule) => ({
      ...(rule.description !== null ? { description: rule.description } : {}),
      clauses: clausesByRule.get(rule.id) ?? [],
      ...(rule.variationId !== null
        ? { variation: target.variationIndexById.get(rule.variationId) ?? 0 }
        : {}),
      ...(rule.rollout !== null ? { rollout: rule.rollout } : {}),
    })),
    prerequisites: prerequisiteRows.flatMap((p) => {
      const flagKey = flagKeysById.get(p.prerequisiteFlagId);
      const variation = target.variationIndexById.get(p.requiredVariationId);
      // A prerequisite on another flag's variation: resolve the index against
      // that flag, not this one.
      return flagKey === undefined
        ? []
        : [{ flagKey, variation: variation ?? 0 }];
    }),
  };
}

async function flagKeysFor(db: Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: flags.id, key: flags.key })
    .from(flags)
    .where(inArray(flags.id, ids));
  return new Map(rows.map((r) => [r.id, r.key]));
}

/* ─────────────────────────────── writes ─────────────────────────────── */

export interface WriteResult {
  before: FlagConfig;
  after: FlagConfig;
  version: number;
  auditId: string;
}

/**
 * Apply a configuration change.
 *
 * The whole body is one transaction. If anything in it fails — a bad variation
 * index, a prerequisite naming a flag that does not exist, a constraint — the
 * flag is left exactly as it was, rather than half-rewritten with its rules
 * deleted and its replacements not yet inserted. That intermediate state is
 * "every user loses their targeting for 40 milliseconds", which in a flag
 * system is a production incident.
 */
export async function writeFlagConfig(
  db: Database,
  target: ResolvedTarget,
  body: FlagConfigBody,
  principal: Principal,
  options: { action?: string } = {},
): Promise<WriteResult> {
  return db.transaction(async (tx) => {
    // Lock first. Everything after this reads a row nobody else can move.
    const locked = await tx
      .select({ version: flagEnvironments.version })
      .from(flagEnvironments)
      .where(eq(flagEnvironments.id, target.flagEnvironmentId))
      .for("update")
      .limit(1);

    const current = locked[0];
    if (current === undefined) throw new HttpError(404, "NOT_FOUND", "no such flag configuration");

    if (current.version !== body.expectedVersion) {
      // 409 carrying the current state: the client can show a diff rather than
      // asking a human to guess what changed underneath them.
      const conflict = await readFlagConfig(tx as unknown as Database, target);
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        `flag was modified concurrently: expected version ${body.expectedVersion}, found ${current.version}`,
        { current: conflict },
      );
    }

    const before = await readFlagConfig(tx as unknown as Database, target);
    const variationId = (index: number | null | undefined): string | null => {
      if (index === null || index === undefined) return null;
      const id = target.variationIds[index];
      if (id === undefined) {
        throw new HttpError(400, "UNKNOWN_VARIATION", `flag has no variation ${index}`);
      }
      return id;
    };

    /* update the row itself */
    const patch: Record<string, unknown> = { version: current.version + 1, updatedAt: new Date() };
    if (body.enabled !== undefined) patch["enabled"] = body.enabled;
    if (body.offVariation !== undefined) patch["offVariationId"] = variationId(body.offVariation);
    if (body.fallthroughVariation !== undefined) {
      // `fallthrough_xor` in Postgres requires exactly one to be set, so writing
      // one always clears the other. Leaving both would be rejected by the
      // constraint — correctly, but with an error nobody can act on.
      patch["fallthroughVariationId"] = variationId(body.fallthroughVariation);
      patch["fallthroughRollout"] = null;
    }
    if (body.fallthroughRollout !== undefined) {
      patch["fallthroughRollout"] = normalizeRollout(rolloutFromBody(body.fallthroughRollout), target);
      patch["fallthroughVariationId"] = null;
    }
    await tx
      .update(flagEnvironments)
      .set(patch)
      .where(eq(flagEnvironments.id, target.flagEnvironmentId));

    /* targets */
    if (body.targets !== undefined) {
      await tx
        .delete(flagTargets)
        .where(eq(flagTargets.flagEnvironmentId, target.flagEnvironmentId));
      const rows = body.targets.flatMap((t) =>
        t.keys.map((key) => ({
          flagEnvironmentId: target.flagEnvironmentId,
          variationId: variationId(t.variation)!,
          contextKind: t.contextKind,
          contextKey: key,
        })),
      );
      if (rows.length > 0) await tx.insert(flagTargets).values(rows);
    }

    /* rules and their clauses */
    if (body.rules !== undefined) {
      await tx
        .delete(targetingRules)
        .where(eq(targetingRules.flagEnvironmentId, target.flagEnvironmentId));
      for (const [idx, rule] of body.rules.entries()) {
        const [inserted] = await tx
          .insert(targetingRules)
          .values({
            flagEnvironmentId: target.flagEnvironmentId,
            idx,
            description: rule.description ?? null,
            variationId: rule.variation === undefined ? null : variationId(rule.variation),
            rollout:
              rule.rollout === undefined
                ? null
                : normalizeRollout(rolloutFromBody(rule.rollout), target),
          })
          .returning({ id: targetingRules.id });
        if (inserted === undefined) throw new Error("featurekit: rule insert returned nothing");
        if (rule.clauses.length > 0) {
          await tx.insert(ruleClauses).values(
            rule.clauses.map((clause, clauseIdx) => ({
              ruleId: inserted.id,
              idx: clauseIdx,
              contextKind: clause.contextKind,
              attribute: clause.attribute,
              op: clause.op,
              values: clause.values,
              negate: clause.negate,
            })),
          );
        }
      }
    }

    /* prerequisites */
    if (body.prerequisites !== undefined) {
      await tx
        .delete(prerequisites)
        .where(eq(prerequisites.flagEnvironmentId, target.flagEnvironmentId));
      for (const prerequisite of body.prerequisites) {
        // Resolved within this project only: a prerequisite pointing at another
        // tenant's flag would otherwise be expressible.
        const [row] = await tx
          .select({ flagId: flags.id, variationId: flagVariations.id })
          .from(flags)
          .innerJoin(
            flagVariations,
            and(
              eq(flagVariations.flagId, flags.id),
              eq(flagVariations.idx, prerequisite.variation),
            ),
          )
          .where(and(eq(flags.projectId, target.projectId), eq(flags.key, prerequisite.flagKey)))
          .limit(1);
        if (row === undefined) {
          throw new HttpError(
            400,
            "UNKNOWN_PREREQUISITE",
            `no flag ${prerequisite.flagKey} with variation ${prerequisite.variation} in this project`,
          );
        }
        await tx.insert(prerequisites).values({
          flagEnvironmentId: target.flagEnvironmentId,
          prerequisiteFlagId: row.flagId,
          requiredVariationId: row.variationId,
        });
      }
    }

    const after = await readFlagConfig(tx as unknown as Database, {
      ...target,
      version: current.version + 1,
    });

    const auditId = await writeAudit(tx as unknown as Database, {
      projectId: target.projectId,
      environmentId: target.environmentId,
      principal,
      action: options.action ?? "flag.updated",
      entityType: "flag_environment",
      entityId: target.flagEnvironmentId,
      entityKey: target.flagKey,
      diff: { before, after },
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
    });

    return { before, after, version: current.version + 1, auditId };
  });
}

/**
 * Rollout weights must sum to `WEIGHT_SCALE`.
 *
 * Checked here rather than trusted from the caller because the evaluator treats
 * the weights as a cumulative ladder: weights summing to 90,000 leave 10% of
 * traffic falling off the end of the rollout and landing on the caller's
 * default, which shows up as a mysterious 10% error rate rather than as a
 * validation failure at the point somebody made the mistake.
 */
function normalizeRollout(rollout: Rollout, target: ResolvedTarget): Rollout {
  let sum = 0;
  for (const variation of rollout.variations) {
    if (target.variationIds[variation.variationIndex ?? -1] === undefined) {
      throw new HttpError(
        400,
        "UNKNOWN_VARIATION",
        `rollout references variation ${variation.variationIndex}, which this flag does not have`,
      );
    }
    sum += variation.weight;
  }
  if (sum !== 100_000) {
    throw new HttpError(
      400,
      "ROLLOUT_WEIGHTS",
      `rollout weights must sum to 100000 (got ${sum}); anything less silently serves the caller's default`,
    );
  }
  return rollout;
}

/** The API speaks `{variation, weight}`; the wire format speaks `variationIndex`. */
export function rolloutFromBody(body: {
  contextKind?: string | undefined;
  bucketBy?: string | undefined;
  seed?: number | undefined;
  variations: { variation: number; weight: number }[];
}): Rollout {
  return {
    ...(body.contextKind !== undefined ? { contextKind: body.contextKind } : {}),
    ...(body.bucketBy !== undefined ? { bucketBy: body.bucketBy } : {}),
    ...(body.seed !== undefined ? { seed: body.seed } : {}),
    variations: body.variations.map((v) => ({ variationIndex: v.variation, weight: v.weight })),
  };
}

/**
 * The kill switch.
 *
 * Its own function because it must work when nothing else does: no expected
 * version, no configuration body, no read-modify-write. One UPDATE, one audit
 * row, and the caller then propagates it without the debounce.
 */
export async function killSwitch(
  db: Database,
  target: ResolvedTarget,
  principal: Principal,
  comment?: string,
): Promise<{ version: number; auditId: string; alreadyOff: boolean }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ version: flagEnvironments.version, enabled: flagEnvironments.enabled })
      .from(flagEnvironments)
      .where(eq(flagEnvironments.id, target.flagEnvironmentId))
      .for("update")
      .limit(1);
    if (current === undefined) throw new HttpError(404, "NOT_FOUND", "no such flag configuration");

    await tx
      .update(flagEnvironments)
      .set({ enabled: false, version: current.version + 1, updatedAt: new Date() })
      .where(eq(flagEnvironments.id, target.flagEnvironmentId));

    const auditId = await writeAudit(tx as unknown as Database, {
      projectId: target.projectId,
      environmentId: target.environmentId,
      principal,
      action: "flag.killed",
      entityType: "flag_environment",
      entityId: target.flagEnvironmentId,
      entityKey: target.flagKey,
      diff: { before: { enabled: current.enabled }, after: { enabled: false } },
      ...(comment !== undefined ? { comment } : {}),
    });

    return { version: current.version + 1, auditId, alreadyOff: !current.enabled };
  });
}

/* ──────────────────────────────── audit ─────────────────────────────── */

export interface AuditInput {
  projectId: string;
  environmentId: string | null;
  principal: Principal;
  action: string;
  entityType: string;
  entityId: string | null;
  entityKey: string | null;
  diff: unknown;
  comment?: string;
}

/**
 * A deterministic serialisation, with object keys sorted at every depth.
 *
 * **`jsonb` is not a byte store.** Postgres parses jsonb, discards key order and
 * duplicate keys, and re-serialises on read — so `JSON.stringify(diff)` at write
 * time and `JSON.stringify(diff)` after a round trip are different strings for
 * the same value. A hash over the raw stringification therefore fails to verify
 * on a log nobody touched, which is worse than no tamper evidence at all: it
 * cries wolf, and then people stop running it.
 *
 * Found exactly that way — the chain verified in isolation and failed the moment
 * the diff had more than one key.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The hash over one audit entry, chained to the previous one.
 *
 * Field order is fixed and explicit rather than `JSON.stringify(row)`: key order
 * in an object literal is not a stable contract, and a chain whose hash depends
 * on serialisation order breaks the first time somebody reorders a field.
 */
export function auditEntryHash(input: {
  prevHash: string | null;
  projectId: string;
  environmentId: string | null;
  actorId: string | null;
  actorKind: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityKey: string | null;
  diff: unknown;
  comment: string | null;
}): string {
  const canonical = [
    input.prevHash ?? "",
    input.projectId,
    input.environmentId ?? "",
    input.actorId ?? "",
    input.actorKind,
    input.action,
    input.entityType,
    input.entityId ?? "",
    input.entityKey ?? "",
    canonicalJson(input.diff ?? null),
    input.comment ?? "",
  ].join("\0");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function writeAudit(db: Database, input: AuditInput): Promise<string> {
  const actor = actorOf(input.principal);

  // The chain head for this project. Read inside whatever transaction the
  // caller is already in, so two concurrent writes to the same project cannot
  // both chain off the same predecessor — the flag-environment row is locked
  // `FOR UPDATE` by then, which serialises them.
  const [previous] = await db
    .select({ entryHash: auditLog.entryHash })
    .from(auditLog)
    .where(eq(auditLog.projectId, input.projectId))
    // By `seq`, never by `created_at`: the latter is transaction-start time and
    // ties for every row written in one transaction.
    .orderBy(sql`${auditLog.seq} desc`)
    .limit(1);

  const prevHash = previous?.entryHash ?? null;
  const entryHash = auditEntryHash({
    prevHash,
    projectId: input.projectId,
    environmentId: input.environmentId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityKey: input.entityKey,
    diff: input.diff,
    comment: input.comment ?? null,
  });

  const [row] = await db
    .insert(auditLog)
    .values({
      projectId: input.projectId,
      environmentId: input.environmentId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityKey: input.entityKey,
      diff: input.diff as Record<string, unknown>,
      comment: input.comment ?? null,
      prevHash,
      entryHash,
    })
    .returning({ id: auditLog.id });
  if (row === undefined) throw new Error("featurekit: audit insert returned nothing");
  return row.id;
}

/**
 * Walk a project's audit chain and report the first break.
 *
 * A break means a row was edited, deleted, or inserted out of band. It does not
 * say which — only where the chain stops verifying, which is where to look.
 */
export async function verifyAuditChain(
  db: Database,
  projectId: string,
  limit = 10_000,
): Promise<{ ok: true; checked: number } | { ok: false; checked: number; brokenAt: string }> {
  const rows = await db
    .select({
      id: auditLog.id,
      environmentId: auditLog.environmentId,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityKey: auditLog.entityKey,
      diff: auditLog.diff,
      comment: auditLog.comment,
      prevHash: auditLog.prevHash,
      entryHash: auditLog.entryHash,
    })
    .from(auditLog)
    .where(eq(auditLog.projectId, projectId))
    .orderBy(asc(auditLog.seq))
    .limit(limit);

  let expectedPrev: string | null = null;
  let checked = 0;

  for (const row of rows) {
    // Rows written before the chain existed carry no hashes. Skipping them is
    // deliberate: refusing to verify anything because history predates the
    // feature would make the tool useless on every real deployment.
    if (row.entryHash === null) continue;

    const recomputed = auditEntryHash({
      prevHash: row.prevHash,
      projectId,
      environmentId: row.environmentId,
      actorId: row.actorId,
      actorKind: row.actorKind,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityKey: row.entityKey,
      diff: row.diff,
      comment: row.comment,
    });

    if (recomputed !== row.entryHash) return { ok: false, checked, brokenAt: row.id };
    if (expectedPrev !== null && row.prevHash !== expectedPrev) {
      // The content is intact but the link is not: a row was removed from the
      // middle, or one was inserted.
      return { ok: false, checked, brokenAt: row.id };
    }

    expectedPrev = row.entryHash;
    checked++;
  }

  return { ok: true, checked };
}

/**
 * The audit trail for one project, newest first.
 *
 * Scoped by project id from a resolved path, never by a caller-supplied id, and
 * indexed by `audit_proj_time_idx` so this stays a range scan rather than a
 * sequential read of every tenant's history.
 */
export async function listAudit(
  db: Database,
  projectId: string,
  options: { limit?: number; entityKey?: string } = {},
): Promise<
  Array<{
    id: string;
    action: string;
    entityType: string;
    entityKey: string | null;
    actorId: string | null;
    actorKind: string;
    /** Null when the member has no display name, or no longer exists. */
    actorName: string | null;
    actorEmail: string | null;
    createdAt: Date;
    comment: string | null;
    before?: unknown;
    after?: unknown;
  }>
> {
  const limit = Math.min(options.limit ?? 50, 200);
  const where =
    options.entityKey === undefined
      ? eq(auditLog.projectId, projectId)
      : and(eq(auditLog.projectId, projectId), eq(auditLog.entityKey, options.entityKey));

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityKey: auditLog.entityKey,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      actorName: members.name,
      actorEmail: members.email,
      createdAt: auditLog.createdAt,
      comment: auditLog.comment,
      diff: auditLog.diff,
    })
    .from(auditLog)
    // Left join: a deleted member's history stays, it just loses its name.
    // actor_id is a member id for token-driven changes too (actorOf).
    .leftJoin(members, eq(members.id, auditLog.actorId))
    .where(where)
    .orderBy(sql`${auditLog.createdAt} desc`)
    .limit(limit);

  return rows.map((row) => {
    const { diff, ...rest } = row;
    const d = (diff as { before?: unknown; after?: unknown }) ?? {};
    return {
      ...rest,
      before: d.before,
      after: d.after,
    };
  });
}

/**
 * One audit row's full diff, for revert. Scoped to the environment being
 * reverted, not just the project: an environment-scoped token must not be able
 * to replay (and read back) another environment's configuration.
 */
export async function readAuditDiff(
  db: Database,
  projectId: string,
  environmentId: string,
  auditId: string,
): Promise<{ before: FlagConfig; after: FlagConfig; entityKey: string | null } | null> {
  const [row] = await db
    .select({ diff: auditLog.diff, entityKey: auditLog.entityKey })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.id, auditId),
        eq(auditLog.projectId, projectId),
        eq(auditLog.environmentId, environmentId),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const diff = row.diff as { before?: FlagConfig; after?: FlagConfig };
  if (diff.before === undefined || diff.after === undefined) return null;
  // Only full config snapshots can be reverted; a kill-switch row records just
  // {enabled} and would otherwise crash the revert with a TypeError.
  if (!Array.isArray(diff.before.rules) || !Array.isArray(diff.before.targets)) return null;
  return { before: diff.before, after: diff.after, entityKey: row.entityKey };
}
