/**
 * Segments and their members.
 *
 * **Member import is chunked and idempotent.** `ON CONFLICT DO UPDATE` on the
 * composite primary key makes a retried page a no-op rather than a duplicate-key
 * failure that strands an import half-done.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  flagEnvironments,
  flags,
  segmentMembers,
  segments,
  segmentRules,
  targetingRules,
} from "../db/schema.js";
import { HttpError } from "../http/router.js";

export async function createSegment(
  db: Database,
  input: {
    projectId: string;
    environmentId: string;
    key: string;
    name: string;
    description?: string | undefined;
    external: boolean;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(segments)
    .values({
      projectId: input.projectId,
      environmentId: input.environmentId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      external: input.external,
    })
    .onConflictDoNothing()
    .returning({ id: segments.id });
  if (row === undefined) throw new HttpError(409, "ALREADY_EXISTS", "a segment with that key exists");
  return row;
}

export async function findSegment(
  db: Database,
  environmentId: string,
  key: string,
): Promise<{ id: string; version: number; memberCount: number | null } | null> {
  const [row] = await db
    .select({ id: segments.id, version: segments.version, memberCount: segments.memberCount })
    .from(segments)
    .where(and(eq(segments.environmentId, environmentId), eq(segments.key, key)))
    .limit(1);
  return row ?? null;
}

/**
 * Rows per statement when writing segment members.
 *
 * A page may carry 50,000 members, and one INSERT for all of them is about
 * 200,000 bind parameters — three times Postgres's 65,535 limit per statement,
 * and deep enough to overflow the stack while the query is being built. At
 * 5,000 rows a statement stays near 20,000 parameters.
 */
const MEMBER_WRITE_CHUNK = 5_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SegmentMemberInput {
  contextKind: string;
  contextKey: string;
  excluded?: boolean;
}

/**
 * Apply one page of a segment import.
 *
 * Idempotent by construction: `ON CONFLICT (segment_id, context_kind,
 * context_key) DO UPDATE` means retrying a page that half-committed is safe,
 * which is what makes a 10M-member import resumable rather than all-or-nothing
 * (Scenario F). The version bump is what tells the compiler to re-encode
 * the filter.
 */
export async function applySegmentMembers(
  db: Database,
  segmentId: string,
  page: { add: SegmentMemberInput[]; remove: Array<{ contextKind: string; contextKey: string }> },
): Promise<{ version: number; memberCount: number }> {
  return db.transaction(async (tx) => {
    for (const chunk of chunks(page.add, MEMBER_WRITE_CHUNK)) {
      await tx
        .insert(segmentMembers)
        .values(
          chunk.map((member) => ({
            segmentId,
            contextKind: member.contextKind,
            contextKey: member.contextKey,
            excluded: member.excluded ?? false,
          })),
        )
        .onConflictDoUpdate({
          target: [segmentMembers.segmentId, segmentMembers.contextKind, segmentMembers.contextKey],
          set: { excluded: sql`excluded.excluded` },
        });
    }

    // Grouped by kind so each statement is one `IN` list, rather than one
    // DELETE per member — a page of 50,000 removals was 50,000 round trips.
    const removeByKind = new Map<string, string[]>();
    for (const member of page.remove) {
      const keys = removeByKind.get(member.contextKind) ?? [];
      keys.push(member.contextKey);
      removeByKind.set(member.contextKind, keys);
    }
    for (const [contextKind, keys] of removeByKind) {
      for (const chunk of chunks(keys, MEMBER_WRITE_CHUNK)) {
        await tx
          .delete(segmentMembers)
          .where(
            and(
              eq(segmentMembers.segmentId, segmentId),
              eq(segmentMembers.contextKind, contextKind),
              inArray(segmentMembers.contextKey, chunk),
            ),
          );
      }
    }

    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(segmentMembers)
      .where(eq(segmentMembers.segmentId, segmentId));
    const memberCount = counted?.count ?? 0;

    const [updated] = await tx
      .update(segments)
      .set({ version: sql`${segments.version} + 1`, memberCount, updatedAt: new Date() })
      .where(eq(segments.id, segmentId))
      .returning({ version: segments.version });

    return { version: updated?.version ?? 0, memberCount };
  });
}

/** Segment keys in an environment, for listing and for import validation. */
export async function listSegments(
  db: Database,
  environmentId: string,
): Promise<Array<{ key: string; name: string; external: boolean; memberCount: number | null }>> {
  return db
    .select({
      key: segments.key,
      name: segments.name,
      external: segments.external,
      memberCount: segments.memberCount,
    })
    .from(segments)
    .where(eq(segments.environmentId, environmentId))
    .orderBy(asc(segments.key));
}

/** Used by the flag-config writer to reject rules naming a segment that is gone. */
export async function segmentKeysIn(db: Database, environmentId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: segments.key })
    .from(segments)
    .where(eq(segments.environmentId, environmentId));
  return new Set(rows.map((r) => r.key));
}

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
