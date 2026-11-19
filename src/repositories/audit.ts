/**
 * The audit log.
 *
 * Each row holds the full before and after, not a field list: "restore this
 * flag to exactly how it was at 14:02" is what you need during an incident, and
 * it makes `revert` a replay rather than a reconstruction. Rows are hash-chained,
 * so an edited or deleted row breaks `verifyAuditChain`.
 */

import type { FlagConfig } from "./flag-config.js";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql, or, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, members } from "../db/schema.js";
import { type Principal, actorOf } from "../auth/principal.js";

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
  options: {
    limit?: number;
    entityKey?: string;
    /** An environment-scoped principal's scope; null or absent means unscoped. */
    environmentIds?: readonly string[] | null;
  } = {},
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
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50) || 50, 200));
  const scope = options.environmentIds ?? null;
  // Rows carry the full before/after config of one environment, so a scoped
  // principal sees only its own environments plus project-level rows.
  const where = and(
    eq(auditLog.projectId, projectId),
    options.entityKey === undefined ? undefined : eq(auditLog.entityKey, options.entityKey),
    scope === null
      ? undefined
      : or(
          isNull(auditLog.environmentId),
          scope.length === 0 ? sql`false` : inArray(auditLog.environmentId, [...scope]),
        ),
  );

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
