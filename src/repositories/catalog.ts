/**
 * Tenancy, flag creation, keys and segments (§7.1–§7.6, §12).
 *
 * The write side of everything that is not a targeting change. Two shapes worth
 * pointing at:
 *
 * - **Creating a flag creates its per-environment configuration rows in the
 *   same transaction**, one per environment, all disabled. A flag that exists
 *   in the project but has no row in production is a flag whose first
 *   production toggle is an INSERT — and an INSERT has no `expectedVersion` to
 *   check, so the §18 concurrent-edit protection would not apply to the single
 *   most dangerous edit anyone makes.
 * - **Segment member import is chunked and idempotent.** `ON CONFLICT DO
 *   UPDATE` on the composite primary key means a retried page is a no-op rather
 *   than a duplicate-key failure that strands an import half-done (Scenario F).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/client.js";
import {
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  projects,
  sdkKeys,
  segmentMembers,
  segments,
} from "../db/schema.js";
import { HttpError } from "../http/router.js";
import { generateSdkKey, storageFor, type SdkKeyKind } from "../auth/keys.js";
import type { Principal } from "../auth/principal.js";
import { canAccessEnvironment } from "../auth/principal.js";

/* ────────────────────────────── projects ────────────────────────────── */

export async function listProjects(
  db: Database,
  principal: Principal,
): Promise<Array<{ id: string; key: string; name: string; environments: string[] }>> {
  const rows = await db
    .select({
      projectId: projects.id,
      projectKey: projects.key,
      projectName: projects.name,
      environmentId: environments.id,
      environmentKey: environments.key,
    })
    .from(projects)
    .leftJoin(environments, eq(environments.projectId, projects.id))
    .orderBy(asc(projects.key));

  const byProject = new Map<string, { id: string; key: string; name: string; environments: string[] }>();
  for (const row of rows) {
    // Scope filtering happens here rather than in SQL because a token scoped to
    // one environment should still see the project that contains it — with only
    // that environment listed.
    if (row.environmentId !== null && !canAccessEnvironment(principal, row.environmentId)) continue;
    const entry = byProject.get(row.projectId) ?? {
      id: row.projectId,
      key: row.projectKey,
      name: row.projectName,
      environments: [],
    };
    if (row.environmentKey !== null) entry.environments.push(row.environmentKey);
    byProject.set(row.projectId, entry);
  }
  // A scoped token sees no project it has no environment in.
  return [...byProject.values()].filter(
    (p) => p.environments.length > 0 || principal.environmentIds === null,
  );
}

export async function createProject(
  db: Database,
  input: { key: string; name: string },
): Promise<{ id: string; key: string }> {
  const [row] = await db
    .insert(projects)
    .values({ key: input.key, name: input.name })
    .onConflictDoNothing()
    .returning({ id: projects.id, key: projects.key });
  if (row === undefined) throw new HttpError(409, "ALREADY_EXISTS", "a project with that key exists");
  return row;
}

export async function findProject(
  db: Database,
  projectKey: string,
): Promise<{ id: string; key: string } | null> {
  const [row] = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(eq(projects.key, projectKey))
    .limit(1);
  return row ?? null;
}

/* ──────────────────────────── environments ──────────────────────────── */

/**
 * A per-environment bucketing salt, generated once and never rotated casually.
 *
 * Rotating it re-randomises every percentage rollout in the environment — which
 * is occasionally what you want and usually catastrophic (§7.1). It is
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

/* ─────────────────────────────── flags ──────────────────────────────── */

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

/* ─────────────────────────────── SDK keys ───────────────────────────── */

/**
 * Mint an SDK key.
 *
 * The plaintext is returned **once**. A server key is stored hashed and is
 * unrecoverable afterwards, which is the point: a database leak yields nothing
 * usable (§7.2). Client and mobile keys are stored public because they ship in
 * a bundle and the dashboard has to display them.
 */
export async function createSdkKey(
  db: Database,
  input: { environmentId: string; kind: SdkKeyKind; name?: string; expiresAt?: Date },
): Promise<{ id: string; key: string; kind: SdkKeyKind }> {
  const key = generateSdkKey(input.kind);
  const storage = storageFor(input.kind, key);
  const [row] = await db
    .insert(sdkKeys)
    .values({
      environmentId: input.environmentId,
      kind: input.kind,
      keyHash: storage.keyHash,
      keyPublic: storage.keyPublic,
      name: input.name ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: sdkKeys.id });
  if (row === undefined) throw new Error("featurekit: sdk key insert returned nothing");
  return { id: row.id, key, kind: input.kind };
}

export async function listSdkKeys(
  db: Database,
  environmentId: string,
): Promise<
  Array<{ id: string; kind: string; name: string | null; revokedAt: Date | null; publicKey: string | null }>
> {
  const rows = await db
    .select({
      id: sdkKeys.id,
      kind: sdkKeys.kind,
      name: sdkKeys.name,
      revokedAt: sdkKeys.revokedAt,
      keyPublic: sdkKeys.keyPublic,
    })
    .from(sdkKeys)
    .where(eq(sdkKeys.environmentId, environmentId));
  // `key_hash` is never returned, by omission here and by being unrecoverable
  // anyway. Only the public half of a client key is displayable.
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    revokedAt: r.revokedAt,
    publicKey: r.keyPublic,
  }));
}

/** Revoked, never deleted: the audit log references the key (§7.2). */
export async function revokeSdkKey(
  db: Database,
  environmentId: string,
  keyId: string,
): Promise<void> {
  const rows = await db
    .update(sdkKeys)
    .set({ revokedAt: new Date() })
    // Scoped by environment: a key id from another tenant matches nothing.
    .where(and(eq(sdkKeys.id, keyId), eq(sdkKeys.environmentId, environmentId)))
    .returning({ id: sdkKeys.id });
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "no such key");
}

/* ─────────────────────────────── segments ───────────────────────────── */

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
 * (§9, Scenario F). The version bump is what tells the compiler to re-encode
 * the filter.
 */
export async function applySegmentMembers(
  db: Database,
  segmentId: string,
  page: { add: SegmentMemberInput[]; remove: Array<{ contextKind: string; contextKey: string }> },
): Promise<{ version: number; memberCount: number }> {
  return db.transaction(async (tx) => {
    if (page.add.length > 0) {
      await tx
        .insert(segmentMembers)
        .values(
          page.add.map((member) => ({
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

    for (const member of page.remove) {
      await tx
        .delete(segmentMembers)
        .where(
          and(
            eq(segmentMembers.segmentId, segmentId),
            eq(segmentMembers.contextKind, member.contextKind),
            eq(segmentMembers.contextKey, member.contextKey),
          ),
        );
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

export async function environmentIdsFor(db: Database, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  return rows.map((r) => r.id);
}

export async function flagKeysIn(db: Database, projectId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ key: flags.key })
    .from(flags)
    .where(and(eq(flags.projectId, projectId), inArray(flags.key, keys)));
  return new Set(rows.map((r) => r.key));
}
