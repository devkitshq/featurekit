/**
 * The Postgres schema.
 *
 * The schema *is* the design, so this is written out concretely rather than
 * derived. Two shapes carry most of the weight:
 *
 * - **`flags` and `flag_environments` are separate tables.** A flag exists once
 *   at the project level; its *configuration* exists once per environment.
 *   Environments are siblings, not a hierarchy. This is the thing every
 *   home-grown flag system gets wrong first.
 * - **Variations are a table, not a `jsonb` array.** Rules reference a specific
 *   variation; with an array you get bare integer indices with no referential
 *   integrity, and reordering silently rewrites every rule in the project.
 *
 * Experiments, metrics and metric events are **not** here; v1 preserves what
 * they need so they can land later.
 *
 * @see docs/storage/schema.md
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Rollout } from "../sdk/index.js";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

/** HLL sketches are opaque bytes to the application. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
});

/* ───────────────────────────── 7.1 Tenancy ──────────────────────────── */

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key").notNull().unique(),
  name: varchar("name").notNull(),
  createdAt: createdAt(),
});

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(), // "production", "staging", "dev"
    name: varchar("name").notNull(),
    color: varchar("color"),
    isProduction: boolean("is_production").notNull().default(false),
    /**
     * Per-environment bucketing salt. Rotating it re-randomises every
     * percentage rollout in the environment — occasionally what you want,
     * usually catastrophic. Rotation is an explicit, audited action, never a
     * side effect.
     *
     * Never leaves the server: the client tier does not bucket.
     */
    bucketSalt: varchar("bucket_salt").notNull(),
    /**
     * Monotonic snapshot version for this environment, bumped in the same
     * transaction as any config change.
     *
     * It lives in a logged table rather than the UNLOGGED snapshot cache
     * precisely because the cache is allowed to be lost. A version that reset
     * when the cache was emptied would
     * go *backwards*, and the SDK's version guard would then reject every
     * subsequent patch as stale — an environment frozen on its last good
     * snapshot with nothing in the logs to say why.
     */
    snapshotVersion: integer("snapshot_version").notNull().default(1),
    eventSampleRatio: doublePrecision("event_sample_ratio").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique("environments_project_key_uq").on(t.projectId, t.key),
    /** Target for the composite FK on segments, so a segment's env and project agree. */
    unique("env_project_id_id_uq").on(t.projectId, t.id),
  ],
);

/* ───────────────────────────── 7.2 SDK keys ─────────────────────────── */

export const sdkKeyKindEnum = pgEnum("sdk_key_kind", ["server", "client", "mobile"]);

export const sdkKeys = pgTable("sdk_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  environmentId: uuid("environment_id")
    .notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  kind: sdkKeyKindEnum("kind").notNull(),
  /**
   * Server keys are hashed at rest — they grant the full ruleset, so a database
   * leak must not yield usable keys. Client and mobile keys are public by
   * construction (they ship in a JS bundle or an app binary) and are stored in
   * the clear so the dashboard can display them. A public client key is not a
   * vulnerability, because it buys evaluated values for a context the holder
   * can prove, not the ruleset.
   */
  keyHash: varchar("key_hash").unique(),
  keyPublic: varchar("key_public").unique(),
  name: varchar("name"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** A revoked key is kept, not deleted — the audit log references it. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/* ─────────────────────── 7.3 Flags and variations ───────────────────── */

export const flagKindEnum = pgEnum("flag_kind", ["boolean", "string", "number", "json"]);

export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    kind: flagKindEnum("kind").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'`),
    /**
     * Temporary flags are release toggles meant to be deleted after rollout.
     * Permanent flags are ops switches and entitlement gates that live forever.
     * The stale-flag detector only nags about temporary ones — the entire
     * reason the distinction exists.
     */
    temporary: boolean("temporary").notNull().default(true),
    /**
     * Whether this flag is evaluated for the client tier at all. A flag left
     * false is invisible to browsers: its key never appears in a client
     * payload, so an unreleased feature's *existence* stays private, not just
     * its value.
     */
    clientAvailable: boolean("client_available").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("flags_project_key_uq").on(t.projectId, t.key),
    index("flag_tag_idx").using("gin", t.tags),
  ],
);

export const flagVariations = pgTable(
  "flag_variations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    /** Ordinal. Rules reference variations by id; the wire format uses this index. */
    idx: integer("idx").notNull(),
    name: varchar("name"),
    description: text("description"),
    value: jsonb("value").notNull(),
  },
  (t) => [unique("flag_variations_flag_idx_uq").on(t.flagId, t.idx)],
);

/* ────────────────── 7.4 Per-environment configuration ───────────────── */

export const flagEnvironments = pgTable(
  "flag_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),

    enabled: boolean("enabled").notNull().default(false),
    offVariationId: uuid("off_variation_id").references(() => flagVariations.id),

    fallthroughVariationId: uuid("fallthrough_variation_id").references(() => flagVariations.id),
    fallthroughRollout: jsonb("fallthrough_rollout").$type<Rollout | null>(),

    /**
     * Monotonic per-flag-per-env version. The SDK discards any patch whose
     * version is not greater than what it holds, making out-of-order delivery
     * and duplicate broadcasts harmless instead of corrupting.
     */
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
    /**
     * FK to `members(id)` is added in the migration rather than here: `members`
     * is declared further down this file, and a forward `references()` callback
     * is resolved eagerly enough by drizzle to hit the temporal dead zone.
     * Declaring it in SQL keeps this file's reading order intact.
     */
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    unique("flag_environments_flag_env_uq").on(t.flagId, t.environmentId),
    index("flag_env_env_idx").on(t.environmentId),
    check(
      "fallthrough_xor",
      sql`num_nonnulls(${t.fallthroughVariationId}, ${t.fallthroughRollout}) = 1`,
    ),
  ],
);

/* ───────────────────────────── 7.5 Targeting ────────────────────────── */

/** Individual overrides. Highest precedence after prerequisites. */
export const flagTargets = pgTable(
  "flag_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id")
      .notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    variationId: uuid("variation_id")
      .notNull()
      .references(() => flagVariations.id),
    contextKind: varchar("context_kind").notNull().default("user"),
    contextKey: text("context_key").notNull(),
  },
  (t) => [
    unique("flag_targets_fe_kind_key_uq").on(t.flagEnvironmentId, t.contextKind, t.contextKey),
    index("flag_target_lookup_idx").on(t.flagEnvironmentId, t.contextKind),
  ],
);

export const targetingRules = pgTable(
  "targeting_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id")
      .notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    /** Evaluated in ascending order; first match wins. Order is meaningful. */
    idx: integer("idx").notNull(),
    description: text("description"),
    variationId: uuid("variation_id").references(() => flagVariations.id),
    rollout: jsonb("rollout").$type<Rollout | null>(),
  },
  (t) => [
    unique("targeting_rules_fe_idx_uq").on(t.flagEnvironmentId, t.idx),
    check("rule_outcome_xor", sql`num_nonnulls(${t.variationId}, ${t.rollout}) = 1`),
  ],
);

/**
 * Clauses within a rule are ANDed. Rules are ORed by first-match. No nested
 * boolean expression tree, deliberately: the UI for one is bad, the semantics
 * are hard to explain at 3am, and every real targeting need is an ordered list
 * of AND-clause rules. Anything genuinely more complex belongs in a segment.
 */
export const ruleClauses = pgTable(
  "rule_clauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => targetingRules.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    contextKind: varchar("context_kind").notNull().default("user"),
    attribute: text("attribute").notNull(), // "country", "plan", "address.tier"
    op: varchar("op").notNull(),
    values: jsonb("values").notNull().$type<unknown[]>(),
    negate: boolean("negate").notNull().default(false),
  },
  (t) => [unique("rule_clauses_rule_idx_uq").on(t.ruleId, t.idx)],
);

/* ───────────────────────────── 7.6 Segments ─────────────────────────── */

export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Environment-scoped, like flag configs: "beta-testers" in staging is a
     * different population than in production, and sharing them across
     * environments is exactly how staging traffic lands in a production rollout.
     *
     * `projectId` is carried only so the composite FK below can enforce that it
     * agrees with the environment's project — it is otherwise derivable and must
     * never be written independently.
     */
    projectId: uuid("project_id").notNull(),
    environmentId: uuid("environment_id").notNull(),
    key: varchar("key").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    /**
     * Large imported lists are not inlined into the snapshot. See
     * docs/evaluation/segments.md for how the SDK resolves them without a network call on the evaluation path.
     */
    external: boolean("external").notNull().default(false),
    memberCount: integer("member_count"),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("segments_env_key_uq").on(t.environmentId, t.key),
    /** Composite FK: the segment's project must be the environment's project. */
    foreignKey({
      columns: [t.projectId, t.environmentId],
      foreignColumns: [environments.projectId, environments.id],
      name: "segments_env_project_fk",
    }).onDelete("cascade"),
  ],
);

export const segmentMembers = pgTable(
  "segment_members",
  {
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    contextKind: varchar("context_kind").notNull().default("user"),
    contextKey: text("context_key").notNull(),
    /**
     * DERIVED, never assigned: the integer value of `contextKey` when the key
     * is integral, NULL otherwise. It is a generated column precisely so nobody
     * can invent an ordinal that the SDK has no way to reproduce.
     *
     * This is the roaring-bitmap eligibility test. An ordinal from a
     * sequence would be denser, but the SDK holds a string key and would need a
     * 500k-entry dictionary to translate it — which costs more heap than the
     * Set the bitmap was meant to replace.
     *
     * **The pattern excludes leading zeros**, unlike a naive `^[0-9]{1,9}$`.
     * `"07"` and `"7"` are distinct context keys but the same integer, so a
     * bitmap would answer identically for both and membership would depend on
     * how an id happened to be formatted. This agrees with `ordinalOf` in the
     * SDK; the two MUST agree or the compiler can pick roaring for a segment
     * the SDK then answers `false` for. See docs/decisions.md §9.
     */
    ordinal: bigint("ordinal", { mode: "number" }).generatedAlwaysAs(
      sql`CASE WHEN context_key ~ '^(0|[1-9][0-9]{0,8})$' THEN context_key::bigint END`,
    ),
    /** Excluded wins over included, so a person can be pinned out of a segment. */
    excluded: boolean("excluded").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.contextKind, t.contextKey] }),
    /** Partial: lets the compiler ask "is every member of this kind integral?" in one scan. */
    index("segment_member_ordinal_idx")
      .on(t.segmentId, t.contextKind, t.ordinal)
      .where(sql`ordinal IS NOT NULL`),
  ],
);

export const segmentRules = pgTable(
  "segment_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** Optional: match only this share of everyone the clauses select. */
    weight: integer("weight"),
    bucketBy: text("bucket_by"),
    contextKind: varchar("context_kind").notNull().default("user"),
  },
  (t) => [unique("segment_rules_segment_idx_uq").on(t.segmentId, t.idx)],
);

export const segmentRuleClauses = pgTable(
  "segment_rule_clauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentRuleId: uuid("segment_rule_id")
      .notNull()
      .references(() => segmentRules.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    contextKind: varchar("context_kind").notNull().default("user"),
    attribute: text("attribute").notNull(),
    op: varchar("op").notNull(),
    values: jsonb("values").notNull().$type<unknown[]>(),
    negate: boolean("negate").notNull().default(false),
  },
  (t) => [unique("segment_rule_clauses_rule_idx_uq").on(t.segmentRuleId, t.idx)],
);

/* ─────────────────────────── 7.7 Prerequisites ──────────────────────── */

/**
 * `onDelete: "restrict"`: you cannot delete a flag another flag depends on.
 * The compiler additionally rejects cycles at compile time, so the evaluator
 * never needs cycle detection on the hot path.
 */
export const prerequisites = pgTable(
  "prerequisites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id")
      .notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    prerequisiteFlagId: uuid("prerequisite_flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "restrict" }),
    requiredVariationId: uuid("required_variation_id")
      .notNull()
      .references(() => flagVariations.id),
  },
  (t) => [unique("prerequisites_fe_flag_uq").on(t.flagEnvironmentId, t.prerequisiteFlagId)],
);

/* ────────────────────────── 7.8 Context kinds ───────────────────────── */

/**
 * Multi-context from day one, because retrofitting it is brutal. `"user"`
 * exists implicitly and is the default everywhere, so the simple case stays
 * simple.
 */
export const contextKinds = pgTable(
  "context_kinds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(), // "user", "organization", "device"
    name: varchar("name").notNull(),
    description: text("description"),
  },
  (t) => [unique("context_kinds_project_key_uq").on(t.projectId, t.key)],
);

/* ────────────────────── 7.9 Evaluation analytics ────────────────────── */

/**
 * PARTITIONED BY RANGE (bucket_at), one partition per day.
 *
 * Drizzle does not emit partitioned DDL, so the `CREATE TABLE ... PARTITION BY`
 * lives in a hand-written migration, and daily partition creation and retention
 * are owned by `pg_partman` under `pg_cron` — **not** by a Node worker. This
 * definition describes the shape for type-safe reads; it is not the authority
 * for the DDL.
 *
 * Postgres requires every unique constraint on a partitioned table to include
 * the partition key. `bucketAt` is in the primary key already — but that is a
 * requirement being satisfied, not a coincidence, and it must survive edits.
 */
export const evaluationSummaries = pgTable(
  "evaluation_summaries",
  {
    environmentId: uuid("environment_id").notNull(),
    flagKey: varchar("flag_key").notNull(),
    variationIdx: integer("variation_idx"), // null = caller default served
    reason: varchar("reason").notNull(),
    /** Start of the aggregation window, truncated to the minute. Partition key. */
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
    /** HLL sketch of distinct context keys, merged in-process before write. */
    uniqueSketch: bytea("unique_sketch"),
  },
  (t) => [
    primaryKey({
      columns: [t.environmentId, t.flagKey, t.variationIdx, t.reason, t.bucketAt],
    }),
    index("eval_summary_time_idx").on(t.environmentId, t.bucketAt),
  ],
);

/* ───────────────────────────── 7.10 Governance ──────────────────────── */

/**
 * Audit rows store the full before/after, not a field list. Storage is cheap;
 * "restore this flag to exactly how it was at 14:02" during an incident is not.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    environmentId: uuid("environment_id"),
    actorId: uuid("actor_id"),
    /** "member" | "token" | "system" — a scheduled change has no human. */
    actorKind: varchar("actor_kind").notNull(),
    action: varchar("action").notNull(), // "flag.toggled", "rule.deleted"
    entityType: varchar("entity_type").notNull(),
    entityId: uuid("entity_id"),
    entityKey: varchar("entity_key"),
    /** Full before/after of the flag-environment config. Enables one-click revert. */
    diff: jsonb("diff").notNull(),
    comment: text("comment"),
    /**
     * Hash chain over the project's audit history.
     *
     * Each row commits to the previous one, so editing or deleting any row
     * breaks every hash after it. Tamper *evidence*, not tamper prevention: an
     * operator with UPDATE can recompute the chain, and saying so is more
     * useful than implying otherwise.
     */
    prevHash: varchar("prev_hash"),
    entryHash: varchar("entry_hash"),
    /**
     * Insertion order, and the chain's only ordering.
     *
     * `created_at` cannot be used: it is transaction-start time, so rows written
     * in one transaction tie and the chain has no single predecessor.
     */
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_proj_time_idx").on(t.projectId, t.createdAt),
    index("audit_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const scheduledChanges = pgTable("scheduled_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  flagEnvironmentId: uuid("flag_environment_id")
    .notNull()
    .references(() => flagEnvironments.id, { onDelete: "cascade" }),
  /** The same patch shape the REST API accepts, so scheduling is a deferred PATCH. */
  patch: jsonb("patch").notNull(),
  executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  failedReason: text("failed_reason"),
  createdBy: uuid("created_by"),
});

export const changeRequests = pgTable("change_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  flagEnvironmentId: uuid("flag_environment_id")
    .notNull()
    .references(() => flagEnvironments.id, { onDelete: "cascade" }),
  patch: jsonb("patch").notNull(),
  status: varchar("status").notNull().default("pending"),
  requestedBy: uuid("requested_by"),
  reviewedBy: uuid("reviewed_by"),
  comment: text("comment"),
  createdAt: createdAt(),
});

/* ────────────────────── 7.11 Members and tokens ─────────────────────── */

export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email").notNull().unique(),
  name: varchar("name"),
  role: varchar("role").notNull().default("writer"), // owner | admin | writer | reader
  /**
   * `scrypt$N$r$p$salt$hash`, or null for a member who only uses a PAT.
   *
   * Null is a real state, not a placeholder: it means "this account cannot be
   * logged into", which is exactly what a CI identity should be.
   */
  passwordHash: varchar("password_hash"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Dashboard sessions.
 *
 * Rows rather than signed cookies, because "log this person out now" has to be
 * answerable — a stateless token is valid until it expires whatever anyone
 * decides in between. Only the hash is stored; the plaintext is in the cookie.
 */
export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash").notNull().unique(),
    userAgent: varchar("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("dashboard_sessions_member_idx").on(t.memberId),
    index("dashboard_sessions_expires_idx").on(t.expiresAt),
  ],
);

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash").notNull().unique(),
  name: varchar("name"),
  environmentIds: uuid("environment_ids").array(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const schema = {
  projects,
  environments,
  sdkKeys,
  flags,
  flagVariations,
  flagEnvironments,
  flagTargets,
  targetingRules,
  ruleClauses,
  segments,
  segmentMembers,
  segmentRules,
  segmentRuleClauses,
  prerequisites,
  contextKinds,
  evaluationSummaries,
  auditLog,
  scheduledChanges,
  dashboardSessions,
  changeRequests,
  members,
  accessTokens,
};
