# featurekit — architecture plan

**You shouldn't have to build a feature flag service.**

Self-hosted feature flags and targeting. Server-side flags evaluate **in your process, from an in-memory snapshot, with no network call per check** — and keep serving correct values when the control plane is down.

> Status: design document. Nothing here is built yet. This is the blueprint.
>
> Revision 3 — segment resolution, client-tier fan-out, secure mode, and partition ownership changed materially from r2. See §22 for what changed and why; §21 keeps the r1 → r2 record.

> ### Measured corrections to this document
>
> The implementation has been benchmarked, and three numbers below are wrong.
> They are left in place because the *arguments* they support still hold, but
> the figures themselves must not be quoted:
>
> | Claim in this document | Measured | Detail |
> | :-- | :-- | :-- |
> | 14 ns per evaluation (§1, §9.2) | **50–177 ns** depending on path | `docs/evaluation/benchmarks.md` |
> | Cuckoo filter ~1.25 MB at 500k members (§9.7) | **2.0 MB** — power-of-two bucket counts put achieved α at 0.477 | `docs/decisions.md` §2 |
> | ~70M evaluations/sec/core (§1) | **~6–20M**, single core | `docs/evaluation/benchmarks.md` |
>
> The design conclusions that rest on them are unchanged: a promise per call is
> still disproportionate against a sub-200 ns operation, and a filter is still
> dramatically smaller than the `Set<string>` it replaces.

---

## 1. Positioning

| | |
| :-- | :-- |
| **What it is** | The flag delivery + evaluation layer running inside your own stack. Postgres + Redis + one npm package. |
| **What it isn't** | Not a product analytics suite, not a CDP, not session replay, **and not an experimentation platform in v1** (§18). |
| **The SaaS it replaces** | LaunchDarkly, Split, Flagsmith Cloud, ConfigCat |
| **License** | MIT. Your servers, your data, no per-MAU toll. |

The first flag is easy:

```ts
const NEW_CHECKOUT = process.env.NEW_CHECKOUT === "true";
```

Then reality hits. You need it on for 5% of users. Then for 5% *consistently* — the same user must not flip on every request. Then on for everyone in the `beta` segment but off in the EU. Then off **immediately** at 3am without a deploy, from a phone. Then a flag has been in the codebase for 14 months and nobody knows if it's safe to delete. Then your flag service has an outage and you discover your app hard-fails when it can't reach it.

**featurekit is that machinery, already built.**

```ts
import { featurekit } from "featurekit";

if (featurekit.get("new-checkout", ctx, false)) {
  // ...
}
```

> Targeting rules, segment membership, percentage rollouts with sticky bucketing, prerequisite flags, and evaluation logging all happen behind that call — **synchronously, from an in-memory snapshot, with a hard-coded default if everything is on fire.**

### Measured cost of that call

Benchmarked on the reference implementation of §9 (Node 22, single core):

| Path | ns/op | evals/sec/core |
| :-- | --: | --: |
| Off, target match, or fixed-variation rule (no hash) | 14 | ~70M |
| Percentage rollout (murmur3 over UTF-8 bytes) | 535–976 | ~1–2M |

Two honest notes. First, "microseconds" applies to the whole call; the hash dominates whenever a rollout is involved. Second, these are per-core figures for the evaluator alone — see §9.6 for why the hash function choice is load-bearing and what it cost when this document specified SHA-1.

---

## 2. Philosophy inherited from notifkit

| Principle | How it lands in featurekit |
| :-- | :-- |
| **Self-hosted, bring your own infra** | Postgres for truth, Redis for fan-out and event buffering. Nothing phones home. |
| **Zero-config dev, explicit prod** | No `DATABASE_URL` in dev? Testcontainers spins up throwaway Postgres and Redis. In production, missing config is a hard startup error. |
| **Monolith or distributed, same code** | `services: ["all"]`, or `services: ["api"]` plus `services: ["events", "rollup"]` across a fleet. |
| **Typed contracts everywhere** | Zod at every boundary (`src/contracts/`), `drizzle-zod` derived from the schema. |
| **Plugins are a class with one method** | notifkit had `Transport.send()`. featurekit has `SnapshotStore` and `EventSink`. |
| **Agent-operable** | `@featurekit/mcp`. "Why didn't usr_9182 get their email?" becomes "why is `new-checkout` off for usr_9182?" — answered with the exact rule that matched. |
| **Config-as-code** | notifkit synced templates from your repo. featurekit syncs **flag definitions**, which is what makes flag keys typed. |
| **Chaos-tested** | Kill the control plane mid-traffic. Evaluations keep serving from the last good snapshot. That claim gets its own suite. |

### One deliberate divergence: packaging

> **Superseded.** This section planned four packages and four more to follow.
> Two ship. See [decisions §19](docs/decisions.md) for what changed and why;
> the table below is the current one.

| Package | Contains | Runtime deps |
| :-- | :-- | :-- |
| `featurekit` | Control plane, workers, management client, **and the server-tier evaluator** (`src/sdk/`) | drizzle, postgres, ioredis, pino, prom-client, zod |
| `featurekit-client` | Client-tier SDK (§11.5). One entry, no framework bindings. Browsers, React Native, Node, edge. | none |

The tier split is unchanged and is still the security boundary: the client tier
receives evaluated values, never the ruleset. What changed is that the evaluator
no longer needs a package of its own to keep it free of the control plane's
dependencies — `tools/check-package.mjs` asserts that boundary directly, and
`tests/evaluation/purity.test.ts` asserts the evaluation core's.

Languages other than JavaScript implement [two HTTP endpoints](docs/client-tier/http.md)
rather than waiting for an SDK.

---

## 3. The architecture inverts

The single most important design note. **notifkit is a write-path system. featurekit is a read-path system.**

| | notifkit | featurekit |
| :-- | :-- | :-- |
| Hot path | `notify()` → queue → workers → provider | `boolean()` → in-memory lookup |
| Volume shape | Thousands/day, bursty | Millions/second, constant |
| Latency budget | Seconds are fine | **Sub-microsecond to low-microsecond.** A network call per flag check is a non-starter. |
| Failure to design for | Message lost | **App blocked, or silently wrong-defaulted** |
| Where the logic runs | Server-side workers | **In the customer's process** (server tier) |

Four consequences, which explain nearly every choice below:

1. **The evaluator is a pure function with exactly one implementation.** It runs in-process for server SDKs, and *server-side on behalf of* client SDKs (§11.5 — this is a real architectural split, not a deployment detail). `src/evaluation/` imports nothing, so the same code compiles into a browser bundle, an edge runtime, and eventually a port to another language.
2. **The server's job is distribution, not evaluation** — for the server tier. It compiles Postgres rows into an immutable snapshot and pushes it to every connected SDK. For the client tier it *is* the evaluator.
3. **The SDK must survive the server being gone.** Last-known-good snapshot in memory, optional disk persistence, and a caller-supplied default as the final backstop.
4. **Evaluation events are fire-and-forget and pre-aggregated in the SDK.** Never one HTTP request per flag check. Summarize, flush every few seconds, drop on backpressure.

---

## 4. System architecture

```mermaid
flowchart TD
    subgraph SRV["Your Backend — server tier"]
        CODE["if (fk.get('new-checkout', ctx, false))"] --> SDK
        SDK["@featurekit/sdk<br/>Full ruleset in memory · Pure evaluator<br/>Synchronous · Local default fallback"]
    end

    subgraph BROW["Browser / Mobile — client tier"]
        BSDK["@featurekit/browser<br/>Evaluated values only, no ruleset<br/>Synchronous lookup · identify() re-fetches"]
    end

    SDK <-->|"ruleset snapshot<br/>SSE /v1/stream/:env"| API
    BSDK <-->|"evaluated values<br/>POST /v1/client/state + SSE"| API
    SDK -->|"batched summaries"| API
    BSDK -->|"batched summaries"| API

    API["featurekit API<br/>Snapshot compiler · Server-side evaluator for client tier<br/>SDK-key auth · Management REST"]

    DASH["Dashboard / CLI / MCP agent"] -->|"management API"| API

    API --> PG
    API --> REDIS

    PG[("PostgreSQL — truth<br/>Projects · Environments · Flags<br/>Rules · Segments · Audit log<br/>Rollups (partitioned)")]
    REDIS[("Redis<br/>Snapshot cache · Patch history<br/>Pub/Sub fan-out · Event buffer<br/>Segment membership · Rate limits")]

    subgraph WORKERS["Background workers"]
        direction LR
        EVENTS["Events<br/>(ingest · shard)"] --> ROLLUP["Rollup<br/>(single writer per shard)"]
        SCHED["Scheduler<br/>(timed changes · stale flags · segment imports)"]
    end

    REDIS -->|"consume"| EVENTS
    ROLLUP -.-> PG
    SCHED -.-> PG
    SCHED -->|"publish change"| REDIS
    REDIS -->|"pub/sub"| API

    classDef entry stroke:#6366f1,stroke-width:2px
    classDef store stroke:#0ea5e9,stroke-width:2px
    classDef work stroke:#22c55e,stroke-width:2px
    class SDK,CODE,BSDK,API,DASH entry
    class PG,REDIS store
    class EVENTS,ROLLUP,SCHED work
```

**The server tier's critical path never touches the network.** The client tier's critical path never touches the network *either* — but it pays one round trip per context change instead of holding the ruleset. §11.5 explains why that trade is mandatory.

---

## 5. Repository layout

```
featurekit/
├── src/                         # the `featurekit` package
│   ├── sdk/                     #   server tier. No control-plane imports.
│   │   ├── evaluation/          #     ★ pure evaluator, shared source of truth
│   │   │   ├── evaluate.ts      #       evaluate(flag, ctx, snapshot) → Detail
│   │   │   ├── bucketing.ts     #       murmur3 + integer rollout math
│   │   │   ├── operators.ts     #       clause operators
│   │   │   └── context.ts       #       multi-context normalisation
│   │   ├── client/              #     stream + poll transport, reconnect
│   │   └── events/              #     summarizer
│   ├── index.ts                 #   FeaturekitServer + FeaturekitSDK
│   ├── server.ts                #   FeaturekitServer
│   ├── client.ts                #   FeaturekitClient (management API)
│   ├── config/  contracts/  db/  repositories/
│   ├── snapshot/                #   compile PG rows → payloads (both tiers)
│   ├── streaming/               #   SSE, patch history, resume
│   ├── evaluation-service/      #   server-side eval for the client tier
│   ├── events/                  #   ingest, shard, rollup
│   ├── governance/              #   audit, approvals, scheduled changes
│   ├── services/{api,events,rollup,scheduler}/
│   └── redis/  logger/  metrics/  rate-limiter/  shared/
├── packages/
│   └── client/                  # featurekit-client — client tier. ZERO deps.
│       └── src/index.ts         #   the whole client, no framework bindings
├── dashboard/
├── drizzle/
├── tests/
│   ├── evaluation/              # table-driven, no containers
│   ├── conformance/             # ★ cross-SDK fixture corpus (§9.5)
│   ├── integration/             # real PG + Redis via testcontainers
│   └── chaos/                   # kill the control plane, assert evals continue
└── examples/
```

`src/sdk/evaluation/` is the only directory the control plane and the server SDK both compile. It imports nothing — not zod, not the logger. Enforced by a lint rule, not good intentions.

---

## 6. Runtime topologies

```ts
export interface FeaturekitOptions {
  databaseUrl?: string;
  redisUrl?: string;
  port?: number;
  host?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  nodeEnv?: "development" | "test" | "production";

  services: ("api" | "stream" | "events" | "rollup" | "scheduler" | "all")[];

  snapshotStore?: SnapshotStore;      // defaults to Redis
  eventSinks?: EventSink[];           // defaults to Redis Streams → Postgres

  autoMigrate?: boolean;
  maxStreamConnections?: number;
  snapshotDebounceMs?: number;
  /** Cap on client-tier SSE connections before new ones are shed to polling. §11.5 */
  maxClientConnections?: number;
}
```

- **Single process** — `services: ["all"]`. Fine to a few thousand connected server SDKs.
- **Split** — stateless `["api", "stream"]` nodes behind a load balancer (sticky routing not required; SSE resume uses `Last-Event-ID`), plus a worker pool on `["events", "rollup", "scheduler"]`.
- **Client-tier scaling** is a different problem from server-tier scaling, because the server re-evaluates per connected context on change. §11.5 covers the cost and the mitigation.

---

## 7. Data model

Postgres via Drizzle. Written out concretely, because the schema *is* the design.

**Scope note:** everything in §7 is the v1 migration. Experiments, metrics, and metric events are **not** in v1 — see §20 for why they were removed and what v1 must preserve so they can land later without a rewrite.

### 7.1 Tenancy

```ts
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key").notNull().unique(),
  name: varchar("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(),                  // "production", "staging", "dev"
    name: varchar("name").notNull(),
    color: varchar("color"),
    isProduction: boolean("is_production").notNull().default(false),
    /**
     * Per-environment bucketing salt. Rotating it re-randomises every percentage
     * rollout in the environment — occasionally what you want, usually
     * catastrophic. Rotation is an explicit, audited action, never a side effect.
     *
     * Never leaves the server: the client tier does not bucket (§11.5).
     */
    bucketSalt: varchar("bucket_salt").notNull(),
    eventSampleRatio: doublePrecision("event_sample_ratio").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unq: unique().on(t.projectId, t.key),
    /** Target for the composite FK in §7.6, so a segment's env and project agree. */
    projEnv: unique("env_project_id_id_uq").on(t.projectId, t.id),
  }),
);
```

**Environments are siblings, not a hierarchy.** A flag exists once at the project level; its *configuration* exists once per environment. That is why `flags` and `flag_environments` are separate tables — the most important shape in the schema, and the thing every home-grown flag system gets wrong first.

### 7.2 SDK keys

```ts
export const sdkKeyKindEnum = pgEnum("sdk_key_kind", ["server", "client", "mobile"]);

export const sdkKeys = pgTable("sdk_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  environmentId: uuid("environment_id").notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  kind: sdkKeyKindEnum("kind").notNull(),
  /**
   * Server keys are hashed at rest — they grant the full ruleset, so a database
   * leak must not yield usable keys. Client and mobile keys are public by
   * construction (they ship in a JS bundle or an app binary) and are stored in
   * the clear so the dashboard can display them. A public client key is not a
   * vulnerability here, because a client key buys you evaluated values for a
   * context you can prove, not the ruleset (§11.5, §16).
   */
  keyHash: varchar("key_hash").unique(),
  keyPublic: varchar("key_public").unique(),
  name: varchar("name"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

A revoked key is kept, not deleted — the audit log references it.

### 7.3 Flags and variations

```ts
export const flagKindEnum = pgEnum("flag_kind", ["boolean", "string", "number", "json"]);

export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unq: unique().on(t.projectId, t.key),
    tagIdx: index("flag_tag_idx").using("gin", t.tags),
  }),
);

export const flagVariations = pgTable(
  "flag_variations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagId: uuid("flag_id").notNull().references(() => flags.id, { onDelete: "cascade" }),
    /** Ordinal. Rules reference variations by id; the wire format uses this index. */
    idx: integer("idx").notNull(),
    name: varchar("name"),
    description: text("description"),
    value: jsonb("value").notNull(),
  },
  (t) => ({ unq: unique().on(t.flagId, t.idx) }),
);
```

Variations are a table, not a `jsonb` array, because rules and rollouts reference a specific variation. With an array you get bare integer indices with no referential integrity, and reordering silently rewrites every rule in the project.

### 7.4 Per-environment configuration

```ts
export const flagEnvironments = pgTable(
  "flag_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagId: uuid("flag_id").notNull().references(() => flags.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull()
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid("updated_by").references(() => members.id),
  },
  (t) => ({
    unq: unique().on(t.flagId, t.environmentId),
    envIdx: index("flag_env_env_idx").on(t.environmentId),
    exactlyOneFallthrough: check(
      "fallthrough_xor",
      sql`num_nonnulls(fallthrough_variation_id, fallthrough_rollout) = 1`,
    ),
  }),
);
```

### 7.5 Targeting

```ts
/** Individual overrides. Highest precedence after prerequisites. */
export const flagTargets = pgTable(
  "flag_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id").notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    variationId: uuid("variation_id").notNull().references(() => flagVariations.id),
    contextKind: varchar("context_kind").notNull().default("user"),
    contextKey: text("context_key").notNull(),
  },
  (t) => ({
    unq: unique().on(t.flagEnvironmentId, t.contextKind, t.contextKey),
    lookupIdx: index("flag_target_lookup_idx").on(t.flagEnvironmentId, t.contextKind),
  }),
);

export const targetingRules = pgTable(
  "targeting_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id").notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    /** Evaluated in ascending order; first match wins. Order is meaningful. */
    idx: integer("idx").notNull(),
    description: text("description"),
    variationId: uuid("variation_id").references(() => flagVariations.id),
    rollout: jsonb("rollout").$type<Rollout | null>(),
  },
  (t) => ({
    unq: unique().on(t.flagEnvironmentId, t.idx),
    exactlyOneOutcome: check("rule_outcome_xor", sql`num_nonnulls(variation_id, rollout) = 1`),
  }),
);

export const ruleClauses = pgTable(
  "rule_clauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").notNull().references(() => targetingRules.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    contextKind: varchar("context_kind").notNull().default("user"),
    attribute: text("attribute").notNull(),        // "country", "plan", "org.tier"
    op: varchar("op").notNull(),
    values: jsonb("values").notNull().$type<unknown[]>(),
    negate: boolean("negate").notNull().default(false),
  },
  (t) => ({ unq: unique().on(t.ruleId, t.idx) }),
);
```

**Clauses within a rule are ANDed. Rules are ORed by first-match.** No nested boolean expression tree, deliberately: the UI for one is bad, the semantics are hard to explain at 3am, and every real targeting need is an ordered list of AND-clause rules. Anything genuinely more complex belongs in a segment.

### 7.6 Segments

```ts
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
     * Large imported lists are not inlined into the snapshot. See §9.7 for how
     * the SDK resolves them without a network call on the evaluation path.
     */
    external: boolean("external").notNull().default(false),
    memberCount: integer("member_count"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unq: unique().on(t.environmentId, t.key),
    /** Composite FK: the segment's project must be the environment's project. */
    envFk: foreignKey({
      columns: [t.projectId, t.environmentId],
      foreignColumns: [environments.projectId, environments.id],
    }).onDelete("cascade"),
  }),
);

export const segmentMembers = pgTable(
  "segment_members",
  {
    segmentId: uuid("segment_id").notNull().references(() => segments.id, { onDelete: "cascade" }),
    contextKind: varchar("context_kind").notNull().default("user"),
    contextKey: text("context_key").notNull(),
    /**
     * DERIVED, never assigned: the integer value of `contextKey` when the key is
     * integral (`^\d{1,9}$`), NULL otherwise. It is a generated column precisely so
     * nobody can invent an ordinal that the SDK has no way to reproduce.
     *
     * This is the roaring-bitmap eligibility test (§9.7). An ordinal from a sequence
     * would be denser, but the SDK holds a string key and would need a 500k-entry
     * dictionary to translate it — which costs more heap than the Set the bitmap was
     * meant to replace. If it cannot be computed from the key, it does not exist.
     */
    ordinal: bigint("ordinal", { mode: "number" }).generatedAlwaysAs(
      sql`CASE WHEN context_key ~ '^[0-9]{1,9}$' THEN context_key::bigint END`,
    ),
    /** Excluded wins over included, so a person can be pinned out of a segment. */
    excluded: boolean("excluded").notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.segmentId, t.contextKind, t.contextKey] }),
    /** Partial: lets the compiler ask "is every member of this kind integral?" in one scan. */
    ordIdx: index("segment_member_ordinal_idx")
      .on(t.segmentId, t.contextKind, t.ordinal)
      .where(sql`ordinal IS NOT NULL`),
  }),
);

export const segmentRules = pgTable("segment_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  segmentId: uuid("segment_id").notNull().references(() => segments.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  /** Optional: match only this share of everyone the clauses select. */
  weight: integer("weight"),
  bucketBy: text("bucket_by"),
});

export const segmentRuleClauses = pgTable("segment_rule_clauses", {
  id: uuid("id").primaryKey().defaultRandom(),
  segmentRuleId: uuid("segment_rule_id").notNull()
    .references(() => segmentRules.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  contextKind: varchar("context_kind").notNull().default("user"),
  attribute: text("attribute").notNull(),
  op: varchar("op").notNull(),
  values: jsonb("values").notNull().$type<unknown[]>(),
  negate: boolean("negate").notNull().default(false),
});
```

### 7.7 Prerequisites

```ts
export const prerequisites = pgTable(
  "prerequisites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagEnvironmentId: uuid("flag_environment_id").notNull()
      .references(() => flagEnvironments.id, { onDelete: "cascade" }),
    prerequisiteFlagId: uuid("prerequisite_flag_id").notNull()
      .references(() => flags.id, { onDelete: "restrict" }),
    requiredVariationId: uuid("required_variation_id").notNull()
      .references(() => flagVariations.id),
  },
  (t) => ({ unq: unique().on(t.flagEnvironmentId, t.prerequisiteFlagId) }),
);
```

`onDelete: "restrict"`: you cannot delete a flag another flag depends on. The compiler additionally **rejects cycles at compile time**, so the evaluator never needs cycle detection on the hot path.

### 7.8 Context kinds

```ts
export const contextKinds = pgTable(
  "context_kinds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key").notNull(),                  // "user", "organization", "device"
    name: varchar("name").notNull(),
    description: text("description"),
  },
  (t) => ({ unq: unique().on(t.projectId, t.key) }),
);
```

Multi-context from day one, because retrofitting it is brutal. `"user"` exists implicitly and is the default everywhere, so the simple case stays simple.

### 7.9 Evaluation analytics — partitioned from day one

Never store one row per evaluation. The SDK pre-aggregates; the server stores buckets. This is the **only** high-volume table, which means it is also the only one that will hurt if it is wrong, so it is partitioned and single-writer from the first migration rather than retrofitted while on fire.

```ts
/**
 * PARTITIONED BY RANGE (bucket_at), one partition per day.
 *
 * Drizzle does not emit partitioned DDL, so the CREATE TABLE ... PARTITION BY
 * lives in a hand-written migration, and daily partition creation and retention
 * are owned by `pg_partman` running under `pg_cron` — not by a Node worker.
 * The Drizzle definition below describes the shape for type-safe reads; it is
 * not the authority for the DDL.
 *
 * Postgres requires every unique constraint on a partitioned table to include
 * the partition key. `bucketAt` is in the constraint already — but that is a
 * requirement being satisfied, not a coincidence, and it must survive edits.
 */
export const evaluationSummaries = pgTable(
  "evaluation_summaries",
  {
    environmentId: uuid("environment_id").notNull(),
    flagKey: varchar("flag_key").notNull(),
    variationIdx: integer("variation_idx"),          // null = caller default served
    reason: varchar("reason").notNull(),
    /** Start of the aggregation window, truncated to the minute. Partition key. */
    bucketAt: timestamp("bucket_at", { withTimezone: true }).notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
    /** HLL sketch of distinct context keys, merged in-process before write. */
    uniqueSketch: customType<Uint8Array>({ dataType: () => "bytea" })("unique_sketch"),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.environmentId, t.flagKey, t.variationIdx, t.reason, t.bucketAt],
    }),
    timeIdx: index("eval_summary_time_idx").on(t.environmentId, t.bucketAt),
  }),
);
```

**Write path, designed to avoid the contention this table invites.** The naive design — every ingest worker upserting `(flag, minute)` rows — puts every worker in the fleet on the same row for a hot flag, and the HLL sketch makes each upsert a read-modify-write. Instead:

1. Ingest workers consume `fk:events` and **shard by `hash(environmentId, flagKey) % N`** onto `fk:rollup:{shard}`.
2. Each shard has exactly **one** rollup consumer. A given `(environment, flag)` is therefore touched by one writer, so merges happen in memory and the row is written once per bucket close.
3. The sketch is merged in-process and written whole. No read-modify-write, no row contention, no serialisation failures.
4. Rebalancing shards moves a flag between writers. That is safe because the primary key makes a late write an idempotent upsert of a closed bucket — worst case two writers briefly merge the same bucket and the later write wins with a superset sketch.

**Partition lifecycle belongs to the database, not to the application.** Dropping a partition is a catalog operation while deleting 400M rows is not, so the mechanism was never in question — the *owner* was. An in-house Node `scheduler` job that creates tomorrow's partition is a single point of failure with three well-known ways to fail: two schedulers racing on `CREATE TABLE` during a rolling deploy, a DST shift or timezone mismatch putting the boundary an hour off, and — the one that actually bites — the worker being down at midnight, so the next insert has no partition to land in and the entire ingest path starts throwing check-constraint violations.

v1 uses **`pg_partman`**, configured once in a migration and maintained by **`pg_cron`**:

```sql
SELECT partman.create_parent(
  p_parent_table => 'public.evaluation_summaries',
  p_control      => 'bucket_at',
  p_interval     => '1 day',
  p_premake      => 7                          -- a week of runway, not one night
);
UPDATE partman.part_config
   SET retention = '90 days', retention_keep_table = false, infinite_time_partitions = true
 WHERE parent_table = 'public.evaluation_summaries';

SELECT cron.schedule('partman-maintenance', '@hourly', $$CALL partman.run_maintenance_proc()$$);
```

`p_premake => 7` is the part that matters: maintenance can miss a week of runs and inserts still land. `ROLLUP_RETENTION_DAYS` becomes the value written into `part_config.retention` at migration time rather than a number a worker re-reads every night.

**No `DEFAULT` partition. Ever.** The instinct after removing the Node worker is to add a catch-all partition so a late-arriving row always has somewhere to land. It converts a loud failure into a silent trap: once a single row sits in `DEFAULT` within a range that a future partition will cover, `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO ...` **errors out** — Postgres must scan `DEFAULT` and cannot move rows that would now belong elsewhere. Partition creation stops. `pg_partman` maintenance starts failing on every run, and it fails against a table that is still happily accepting inserts, so nothing looks wrong until the day someone tries to drop old data and discovers a year of rows in one unpartitioned heap. Detaching `DEFAULT`, relocating its rows, and reattaching is a manual recovery under an exclusive lock on the busiest table in the system.

The alternative is the one already specified: `p_premake => 7` gives a week of runway, and `featurekit_partition_runway_days` pages when that runway drops below two days. A missing partition then fails the insert immediately and visibly, which is the correct outcome — analytics ingest is the one path in this system explicitly allowed to drop data (§14), and a loud stop beats a silent one that costs a maintenance window to unwind.

**If an operator cannot install extensions** — managed Postgres with a locked allow-list — the fallback is idempotent declarative DDL (`CREATE TABLE IF NOT EXISTS ... PARTITION OF ... FOR VALUES FROM ... TO ...`) driven by whatever scheduler that operator already runs. The rule is unchanged and is the actual decision: **table lifecycle never runs inside the Node process.** The application's one responsibility is to fail readiness loudly when the newest existing partition is less than two days ahead of now — a cheap `pg_class` query, and the thing that turns a silent misconfiguration into a page instead of an outage at midnight.

### 7.10 Governance

```ts
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    environmentId: uuid("environment_id"),
    actorId: uuid("actor_id"),
    /** "member" | "token" | "system" — a scheduled change has no human. */
    actorKind: varchar("actor_kind").notNull(),
    action: varchar("action").notNull(),             // "flag.toggled", "rule.deleted"
    entityType: varchar("entity_type").notNull(),
    entityId: uuid("entity_id"),
    entityKey: varchar("entity_key"),
    /** Full before/after of the flag-environment config. Enables one-click revert. */
    diff: jsonb("diff").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projTimeIdx: index("audit_proj_time_idx").on(t.projectId, t.createdAt),
    entityIdx: index("audit_entity_idx").on(t.entityType, t.entityId),
  }),
);

export const scheduledChanges = pgTable("scheduled_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  flagEnvironmentId: uuid("flag_environment_id").notNull()
    .references(() => flagEnvironments.id, { onDelete: "cascade" }),
  /** The same patch shape the REST API accepts, so scheduling ≡ a deferred PATCH. */
  patch: jsonb("patch").notNull(),
  executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  failedReason: text("failed_reason"),
  createdBy: uuid("created_by").references(() => members.id),
});

export const changeRequests = pgTable("change_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  flagEnvironmentId: uuid("flag_environment_id").notNull()
    .references(() => flagEnvironments.id, { onDelete: "cascade" }),
  patch: jsonb("patch").notNull(),
  status: varchar("status").notNull().default("pending"),
  requestedBy: uuid("requested_by").references(() => members.id),
  reviewedBy: uuid("reviewed_by").references(() => members.id),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Audit rows store the full before/after, not a field list. Storage is cheap; "restore this flag to exactly how it was at 14:02" during an incident is not.

### 7.11 Members and tokens

```ts
export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email").notNull().unique(),
  name: varchar("name"),
  role: varchar("role").notNull().default("writer"),  // owner | admin | writer | reader
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash").notNull().unique(),
  name: varchar("name"),
  environmentIds: uuid("environment_ids").array(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
```

### 7.12 Schema map

```mermaid
erDiagram
    projects ||--o{ environments : has
    projects ||--o{ flags : has
    projects ||--o{ context_kinds : defines
    environments ||--o{ sdk_keys : issues
    environments ||--o{ segments : scopes
    flags ||--o{ flag_variations : has
    flags ||--o{ flag_environments : "configured per env"
    environments ||--o{ flag_environments : configures
    flag_environments ||--o{ targeting_rules : has
    flag_environments ||--o{ flag_targets : has
    flag_environments ||--o{ prerequisites : requires
    flag_environments ||--o{ scheduled_changes : queues
    flag_environments ||--o{ change_requests : gates
    targeting_rules ||--o{ rule_clauses : ANDs
    segments ||--o{ segment_members : "includes/excludes"
    segments ||--o{ segment_rules : matches
```

---

## 8. Redis key map

Redis is a cache and a bus. **Losing all of Redis must not lose a flag configuration** — Postgres is truth and every key here is rebuildable.

| Key | Type | Purpose | Rebuild cost |
| :-- | :-- | :-- | :-- |
| `fk:snap:{envId}:server` | string | Compiled ruleset snapshot | Recompile from PG |
| `fk:snap:{envId}:ver` | string | Snapshot version, served as `ETag` | Recompile |
| `fk:patches:{envId}` | stream (capped) | **Patch history for SSE resume** (§10.3) | Lossy — reconnects degrade to full `put` |
| `fk:chan:{envId}` | pub/sub | Change broadcast to every API node | n/a |
| `fk:cctx:{connId}` | hash (TTL) | Client-tier connection → context (§11.5) | Client re-identifies |
| `fk:events` | stream | Raw summary batches from SDKs | Lossy by design |
| `fk:rollup:{shard}` | stream | Sharded for single-writer rollup (§7.9) | Lossy by design |
| `fk:dlq` | stream | Rollup failures, replayable | — |
| `fk:rl:{keyId}` | zset | Sliding-window rate limit per SDK key | n/a |
| `fk:seg:{segmentId}` | set | Membership for external segments; also the backing store a remote `SegmentCacheProvider` reads (§9.7) | Reload from PG |
| `fk:cfp:{envId}:{ver}` | hash (TTL) | Client-tier fingerprint → evaluated values (§11.5) | Re-evaluate |
| `fk:lock:snapshot:{envId}` | string | Compile lock; prevents a thundering herd | n/a |

---

## 9. The evaluation engine

Pure, dependency-free, deterministic. One implementation, compiled into every SDK and into the control plane's client-tier evaluator.

### 9.1 Precedence

Fixed, never configurable. Configurable precedence makes flags impossible to reason about.

```
1. Flag not in snapshot .............. → caller's default,   reason FLAG_NOT_FOUND
2. Flag off .......................... → offVariation,       reason OFF
3. Prerequisite unmet ................ → offVariation,       reason PREREQUISITE_FAILED
4. Individual target match ........... → target variation,   reason TARGET_MATCH
5. First matching rule ............... → variation/rollout,  reason RULE_MATCH
6. Fallthrough ....................... → variation/rollout,  reason FALLTHROUGH
```

An error at any step — malformed rule, out-of-range variation index, unusable context — returns the **caller's default** with `reason: ERROR`. **The evaluator never throws.** A flag library that can throw into your request path is worse than no flag library.

### 9.2 Signature — synchronous

```ts
export interface EvaluationDetail<T> {
  value: T;
  variationIndex: number | null;   // null when the caller's default was served
  reason: EvaluationReason;
}

export type EvaluationReason =
  | { kind: "OFF" }
  | { kind: "FLAG_NOT_FOUND" }
  | { kind: "PREREQUISITE_FAILED"; prerequisiteKey: string }
  | { kind: "TARGET_MATCH" }
  | { kind: "RULE_MATCH"; ruleIndex: number; ruleId: string }
  | { kind: "FALLTHROUGH" }
  | { kind: "ERROR"; error: EvaluationErrorKind };

export function evaluate<T>(
  flagKey: string,
  context: EvaluationContext,
  snapshot: Snapshot,
  defaultValue: T,
): EvaluationDetail<T>;                              // ← not a Promise
```

**Nothing on this path awaits.** A promise per call adds a microtask tick to a 14ns operation, poisons every call site, and cannot be used in a React render — which `useFlag` (§11.4) is. Readiness is a separate, explicit concern: `await fk.ready()` once at startup (§11.2). §9.7 covers the one thing that used to justify async — external segments — and how it is resolved without I/O on the evaluation path.

`reason` is not decoration. It is what the dashboard shows, what the MCP agent reads back to answer "why did this user get the old checkout?", and what the SDK aggregates into summaries.

### 9.3 Bucketing — integer math, non-cryptographic hash

The rule that makes percentage rollouts trustworthy: **the same context must always land in the same bucket**, across processes, restarts, deploys, and SDK languages. Getting there requires being exact about three things that are easy to get wrong.

```ts
const HASH_SPACE   = 2 ** 32;    // murmur3 x86_32 output space
const WEIGHT_SCALE = 100_000;    // rollout weights are integers out of 100000

/**
 * murmur3 x86_32 over the UTF-8 BYTES of `${prefix}.${salt}.${value}`.
 *
 * Bytes, not JS string characters. `String.charCodeAt` yields UTF-16 code
 * units, so "usr_josé" hashes as [...,115,233] in a charCodeAt implementation
 * and [...,115,195,169] in any language reading UTF-8. Context keys are
 * routinely non-ASCII — emails, names, unicode ids — and this silently splits
 * such a user across SDKs. The spec is bytes; the JS implementation encodes.
 */
export function bucket(
  contextValue: string,
  flagKey: string,
  salt: string,
  seed?: number,
): number {
  const prefix = seed !== undefined ? String(seed) : flagKey;
  const raw = murmur3Utf8(`${prefix}.${salt}.${contextValue}`);   // uint32
  // Exact integer division. Max intermediate is (2^32-1) * 100000 ≈ 4.29e14,
  // comfortably inside MAX_SAFE_INTEGER (9.01e15) and inside int64 for a Go or
  // Java port — so every implementation computes the identical value with
  // native integers, no BigInt and no floating point anywhere.
  return Math.floor((raw * WEIGHT_SCALE) / HASH_SPACE);           // [0, 99999]
}
```

Three properties the hash inputs buy, each of which someone will otherwise file a bug about:

- **`flagKey` in the hash** — two flags at 10% do not roll out to the *same* 10% of users. Verified: two 10% rollouts over 200k contexts overlapped on 2,019 of them against an expected ~2,026. Without this, your "independent" rollouts are perfectly correlated and you draw conclusions from one population.
- **`salt` from the environment** — the 10% in staging is not the 10% in production.
- **`seed` override** — reserved so a future experiment can freeze its own seed and survive edits to the flag's rollout (§20).

Assignment, with the accumulator kept in integers:

```ts
export interface Rollout {
  contextKind?: string;           // which context kind is bucketed. default "user"
  bucketBy?: string;              // attribute to bucket on instead of the key
  seed?: number;
  variations: { variationIndex: number; weight: number }[];   // weights sum to 100000
}

export function resolveRollout(
  rollout: Rollout,
  context: EvaluationContext,
  flagKey: string,
  salt: string,
): number | null {
  const value = bucketValue(context, rollout.contextKind ?? "user", rollout.bucketBy ?? "key");
  // A context lacking the bucketing attribute cannot be bucketed consistently,
  // so it is excluded rather than silently assigned to the first variation.
  if (value === null) return null;

  const b = bucket(value, flagKey, salt, rollout.seed);          // integer [0, 99999]
  let cursor = 0;                                                // integer, never a float
  for (const v of rollout.variations) {
    cursor += v.weight;
    if (b < cursor) return v.variationIndex;
  }
  return rollout.variations.at(-1)?.variationIndex ?? null;
}
```

**Weights are integers out of 100,000, and the cursor stays an integer.** Accumulating `weight / 100_000` as floats defeats the point: twenty 5,000-unit variations sum to `1.0000000000000002`, and every intermediate boundary is off by an ULP. Integers make the boundary exact and identical in every language.

Measured uniformity for this scheme: a 10% rollout over 1M synthetic contexts landed at 9.9555%, inside the ±0.5% the chaos suite asserts.

### 9.4 What this replaced, and why it matters

Revision 1 specified `parseInt(sha1(...).slice(0, 15), 16) / 0xFFFFFFFFFFFFFFF`. Two defects, measured:

**Precision.** `0xfffffffffffffff` is 1.15e18 — 128× `Number.MAX_SAFE_INTEGER`. **96.5% of hashes** silently round to the nearest double. The rounding is bounded at 5.6e-17 of the range, so contexts actually flipping variation is ~1e-16 per context and would never be seen in production. **The damage is to the fixture contract.** A conformance corpus generated by the JS implementation encodes rounded values as "expected", so an exact-integer Go or Python SDK — doing the arithmetic *correctly* — fails against it. The corpus that exists to prevent cross-SDK divergence would have been the thing enforcing it.

**Cost.** Benchmarked at 2,500 ns/op, ~0.4M evals/sec/core — against a document promising "millions/second". Almost all of it is `createHash` object allocation, measured at 3,245 ns standalone; the hashing itself is negligible. SHA-1 was never doing security work here. It is a uniformity function, and a non-cryptographic hash is the right tool:

| Implementation | ns/op | evals/sec/core |
| :-- | --: | --: |
| SHA-1 via `createHash` (r1 spec) | 2,500 | 0.4M |
| murmur3 over UTF-8 bytes | 976 | 1.0M |
| murmur3, ASCII fast path + UTF-8 fallback | 535 | 1.9M |

The ASCII fast path is byte-identical to the UTF-8 path for ASCII input (verified) and falls back to `TextEncoder` otherwise, so it is an optimization rather than a second spec.

**This choice is frozen before v1 ships.** Changing the hash re-buckets every context in every rollout simultaneously. It is the one decision in this document that cannot be revised later without a coordinated flag-by-flag migration.

### 9.5 The conformance corpus is the spec

`tests/conformance/` holds a language-agnostic JSON corpus: `{ snapshot, context, flagKey, expected: { value, variationIndex, reason } }`, plus a dedicated `bucketing.json` of `{ prefix, salt, value } → expected integer`. Every SDK in every language runs both.

Two rules that give it teeth, both learned from §9.4:

1. **Expected values are computed by hand from the specification**, not captured from the JS implementation. A corpus generated by the reference implementation certifies that implementation against itself.
2. **The corpus includes non-ASCII context keys and boundary-adjacent buckets by construction** — the two cases where implementations diverge and random fixtures never land.

### 9.6 Clause operators

```ts
export type Operator =
  | "in" | "startsWith" | "endsWith" | "contains" | "matches"     // string
  | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual"
  | "before" | "after"                                            // date
  | "semVerEqual" | "semVerLessThan" | "semVerGreaterThan"        // version
  | "segmentMatch";                                               // segment reference
```

- **Type mismatch is `false`** — never a throw, never a coercion. `greaterThan` against a string attribute is simply not a match.
- **`matches` regexes are length-capped and complexity-checked at write time**, in the dashboard, before they can reach an SDK. A rule author with a regex is a rule author with a ReDoS, and this runs inside the customer's request path.
- **Multi-valued attributes match if *any* element matches.** `groups: ["a","b"]` against `in: ["b"]` matches.
- **`negate` inverts *after* evaluation**, so a non-match caused by a missing attribute becomes a match under negation — the semantics people expect from "is not in". **`negate` never inverts an *unresolved* clause**; unresolved is a third state that short-circuits the rule before negation is applied (§9.7).
- **`segmentMatch` recurses** under a depth cap; the compiler has already rejected cycles.

### 9.7 External segments without async

Large imported lists (an enterprise allow-list, a churn-risk cohort) can be too big to inline in a snapshot sent to every SDK. Revision 1 had the SDK ask the API for membership, which put a network call inside the evaluation path and is why `boolean()` was async. That contradicted both the latency claim and the outage story.

Resolved without I/O on the hot path:

1. **A *deletable* membership filter in the snapshot.** A negative is exact and final: not a member, no network, done.
2. **Positives are confirmed against a resolved membership set** — held in-process by default, or behind a `SegmentCacheProvider` when the process cannot afford the heap.
3. **When membership cannot be confirmed, the whole rule fails closed** — not the clause, the rule. This is the subtle one, and it is spelled out below.
4. **During an outage** the resolved set is whatever was last loaded, exactly like the snapshot. §14 has the row.

#### Why not Bloom filters

r2 specified a Bloom filter at a ~0.1% false-positive rate and priced it at ~1.2 KB per 1,000 members. Those two numbers do not describe the same filter. An optimal Bloom filter needs `1.44 · log₂(1/ε)` bits per item: 9.6 bits — 1.2 KB per 1,000 — is **ε = 1%**, while ε = 0.1% costs 14.4 bits per item, or ~1.8 KB per 1,000 and ~900 KB for a 500k segment. r2 quoted the size of the cheap filter and the accuracy of the expensive one. Correcting it matters because every space comparison below is against the real number, not the flattering one.

The false-positive rate itself remains a targeting-accuracy budget rather than a correctness bug, because step 2 confirms every positive.

**But Bloom filters cannot delete.** Removing one person from a 500k-member enterprise allow-list — the single most common operation on exactly this kind of segment — cannot be patched into the bit array. It forces a full re-encode and a re-broadcast of ~900 KB to *every* connected server SDK, on the same SSE stream that carries kill switches. Ten offboardings in an afternoon is ten full-filter broadcasts, and the flag toggle queued behind them is the one that actually mattered. The structure was chosen for its read path and priced only there.

The compiler picks one of two structures per segment, both of which support deletion:

| | When the compiler picks it | Cost at 500k members | False positives |
| :-- | :-- | :-- | :-- |
| **Cuckoo filter** | **The default.** Opaque string keys — uuids, emails, `usr_7f3a…` | ~1.25 MB at the pinned parameters below (≈7% over an equal-accuracy Bloom) — **measured 2.0 MB; see the corrections banner at the top** | **0.012%**, confirmed at step 2 |
| **Roaring bitmap** | Only when the context key is **integral on its own** (§7.6) | Typically **under 100 KB**; far less when ids are clustered | **Zero — exact** |

**The ordinal cannot be a lookup, and this determines everything else.** A roaring bitmap answers `contains(int)`. The evaluator holds `"usr_7f3a91"`. Something has to bridge that, and the obvious bridge — ship a `Record<string, number>` alongside the bitmap — is a 500,000-entry dictionary in the snapshot: roughly 30–40 MB of V8 heap once it is a live `Map`, which is *worse* than the 50–80 MB `Set` that §9.7's whole `SegmentCacheProvider` section exists to avoid. A 90 KB bitmap behind a 35 MB dictionary is not a 90 KB structure. So:

**Roaring is available only when the ordinal is computable from the key with no side table** — the key parses as a non-negative integer under 2^32 (`^\d{1,9}$`). Then the ordinal *is* the key, `contains(Number(ctx.key))` is the whole lookup, and nothing extra ships. Shops on numeric primary keys get exact matching for free. Shops on uuids do not, and no amount of encoding cleverness changes that.

**Rejected: minimal perfect hashing.** An MPHF maps the *known* member set into `[0, n)` in ~3 bits per key — 190 KB for 500k, which sounds like it wins. It does not, for two reasons that compound. An MPHF returns a valid-looking slot for keys that were never in the set, so a non-member lands on an arbitrary bit and matches at roughly the bitmap's fill density — a false-positive rate in the tens of percent, not tenths. Fixing that means storing a fingerprint per slot, at which point the structure *is* a probabilistic filter — an xor or binary-fuse filter, ~14 bits/key at the accuracy pinned below, genuinely smaller than the cuckoo's 20. Those cannot delete, which is the entire reason Bloom was dropped. Trading deletability back for 30% space is a straight loss here. Cuckoo stays.

- **Cuckoo filters** are therefore the workhorse: comparable space to Bloom at the same accuracy, comparable lookup performance, and a real `delete(key)`. "Sizes to a load factor of 0.8 and rebuilds on failure" is not a specification, though — it is the shape of one, and the parameters it leaves unstated are exactly the ones that produce unbounded relocation loops on a large import. They are pinned below.

#### Cuckoo parameters are frozen, for the same reason the hash is

The filter is a **wire format**. The compiler writes it, every SDK reads it, and a future Go or Python SDK must read the same bytes. A disagreement about fingerprint width or alternate-bucket derivation does not throw — it silently answers `false` for members who are in the segment, which surfaces as "the flag didn't turn on for that customer" weeks later. So this is frozen in M1 alongside the bucketing hash (§9.4), and the conformance corpus (§9.5) carries encoded filters with known members and known non-members.

**(2,4) partial-key cuckoo hashing** — 2 candidate buckets, 4 slots per bucket, standard Fan et al. construction:

| Parameter | Value | Why this and not something else |
| :-- | :-- | :-- |
| Slots per bucket `b` | **4** | The load-factor knee. b=2 saturates near 84%, b=4 reaches ~95%, b=8 buys ~1% more for double the probe cost. |
| Fingerprint bits `f` | **16** (default), 12 (space-constrained) | ε ≈ `2b/2^f` = 8/65536 = **0.012%**. 16 bits is byte-aligned: a bucket is four `Uint16` values, 8 bytes, read with no shifting. |
| Bucket count | **`nextPow2(ceil(n / (b · 0.8)))`** | Power of two is **required**, not preferred — see the XOR rule below. |
| Target load factor | **0.8** | Headroom, priced below. |
| Max relocations | **500**, then rebuild | Standard. At α ≤ 0.8 with a correct construction it is not reached. |
| Alternate bucket | `i₂ = i₁ XOR h(fingerprint)` | Partial-key hashing: relocation needs only the fingerprint, never the original key. |
| Hash | murmur3 over UTF-8 bytes, seeded per segment version | Already frozen for bucketing (§9.3). One hash function in the SDK, not two. |

Four implementation details that are the difference between "sizes to 0.8" working and looping:

1. **The bucket count must be a power of two.** `i₂ = i₁ XOR h(fp)` only stays in range when the index space is a power of two. With any other table size the XOR walks off the end, and the usual patch — `i₂ = (i₁ XOR h(fp)) % numBuckets` — quietly breaks the involution, so `alt(alt(i)) ≠ i`, relocated items become unfindable, and inserts loop until the kick limit on a filter that is only half full. This is the single most common cuckoo filter bug and it is invisible until the table gets large.
2. **A fingerprint is never zero.** Zero is the empty-slot sentinel. Remap a computed zero to a fixed constant (`1`); the accuracy cost is one collision class out of 65,536.
3. **Deletion removes one matching fingerprint, not all of them.** Two distinct members can share a fingerprint in the same bucket; clearing both silently evicts someone who is still in the segment. `delete` clears the first match and stops.
4. **No semi-sorting.** It saves ~1 bit per item by compressing four sorted fingerprints per bucket, and costs a decode on **every lookup** — on the hot path, in JS, against a ~14 ns budget (§9.2), to save 6% of a structure that is already off-heap-sized. It also only applies at f=4 sub-widths and complicates the frozen wire format for every future SDK port. Rejected on the read path; the space is bought with `f=12` instead if it is ever needed.

**What the 0.8 target actually costs.** At f=16 the filter is `16/α` bits per item: **20 bits at α=0.8** (1.25 MB for 500k) versus 16.8 bits at α=0.95 (1.05 MB). The headroom costs ~19%. It is worth it because the load factor is not static — `segment-patch` events add members after the filter was sized, and a filter built at 0.95 has no room for the next import. The compiler therefore **sizes from the segment's current member count with the 0.8 target, and refuses to apply an incremental patch that would push α above 0.85**, emitting a full re-encode instead. That converts "insert failure" from a runtime surprise into a scheduled, observable event.

**If an insert fails anyway** — it should not at α ≤ 0.8, and if it does the construction is wrong rather than unlucky — the compiler retries once with the seed incremented, and on a second failure doubles the table and rebuilds. Both paths increment `featurekit_segment_filter_rebuild_total{reason}`, because a rebuild loop that nobody can see is how a compile-time bug becomes a production incident.
- **Roaring bitmaps**, where eligible, are strictly better: exact matching, so step 2's confirmation is unnecessary and the unresolved state cannot arise at all; native `AND`/`OR`/`ANDNOT`, so segment intersections resolve *in the compiler* rather than clause-by-clause in every SDK; and run-length compression that beats a probabilistic filter whenever ids are clustered, which sequential primary keys are by construction.

The compiler decides per `(segment, contextKind)` and records which it chose, so the dashboard can show "this segment is exact" or "this segment matches at 99.9% precision" rather than leaving it to be inferred. `SEGMENT_FILTER=roaring` forces the choice and **fails the compile loudly** if any member key is non-integral — a wrong answer is not an acceptable response to a misconfiguration.

**Membership deltas ride the patch stream.** Because both structures are patchable, `fk:patches:{envId}` carries a `segment-patch` event — `{ segmentKey, version, add: [...], remove: [...] }` — and a one-row membership change ships as a few hundred bytes rather than a full snapshot. The version guard (§10.2) applies unchanged: a segment patch at or below the held version is ignored. Replay exhaustion degrades to a full segment `put`, exactly like flags.

#### Fail-closed is a property of the rule, not of the clause

r2 said a cache miss makes the clause resolve to "not a match", and called that the conservative direction. **Under negation it is precisely the opposite.**

```
Rule: user is NOT in "beta_testers"  →  serve new-checkout

Membership not yet confirmed:
  clause "in beta_testers"  → false      (unresolved, treated as a no-match)
  negate: true              → inverts to TRUE
  → the rule matches, and every unconfirmed user is served the gated feature.
```

The window is real: it is every evaluation between process start and the first segment load, and every evaluation during a `SegmentCacheProvider` blip. A negated segment clause is the ordinary way to write an exclusion list — "everyone except the enterprise accounts", "not in the do-not-disturb cohort" — so this is not a corner case. It is the exclusion list failing open.

The fix is to make unresolved a **third state** that never reaches the negation operator:

```ts
type ClauseResult =
  | { matched: true }
  | { matched: false }
  | { unresolved: true; reason: "SEGMENT_UNRESOLVED" };   // never negated

function evaluateClause(clause: CompiledClause, ctx: Context): ClauseResult {
  if (clause.op === "segmentMatch" && !segments.isResolved(clause.segmentKey)) {
    // Membership cannot be verified. Do NOT produce a boolean here: a boolean is
    // something `negate` can invert, and inverting an unverified miss grants the
    // feature. Propagate the third state instead.
    return { unresolved: true, reason: "SEGMENT_UNRESOLVED" };
  }
  const matched = applyOperator(clause, ctx);
  return { matched: clause.negate ? !matched : matched };   // negate applies only here
}

function evaluateRule(rule: CompiledRule, ctx: Context): RuleResult {
  for (const clause of rule.clauses) {
    const r = evaluateClause(clause, ctx);
    if ("unresolved" in r) return { matches: false, reason: "SEGMENT_UNRESOLVED" };  // fail closed
    if (!r.matched) return { matches: false, reason: "NO_MATCH" };
  }
  return { matches: true };
}
```

Three consequences, and they are the reason to write it this way rather than special-casing `negate`:

- **A rule that cannot be fully evaluated does not match, in either polarity.** Evaluation falls through to the next rule and ultimately to the fallthrough or off variation — the same place a genuinely non-matching context lands.
- **`SEGMENT_UNRESOLVED` is a distinct `reason` on `EvaluationDetail`,** so `POST /v1/debug/evaluate` reports "this rule was skipped because segment membership was unverified" rather than "no match" — the difference between a five-minute diagnosis and an afternoon.
- **The conformance corpus (§9.5) enforces it**, with negated-clause-under-unresolved cases in both directions. This is exactly the bug a well-meaning refactor reintroduces by "simplifying" the third state back into a boolean.

Roaring-bitmap segments never enter this state, which is a second reason to prefer them.

#### `SegmentCacheProvider` — the confirmation set need not live in the heap

The default is an in-process `Set<string>`: synchronous, ~14 ns, and correct for a long-lived microservice. It is also **50–80 MB of V8 heap** for a few large segments, which is fatal in the environments a Node service is most likely to be deployed into — a 128 MB Lambda, a Cloud Run instance sized for cost, a Kubernetes pod whose memory limit was set by someone who benchmarked the app before featurekit was in it. The failure there is not slow evaluation. It is OOMKilled, and it takes the whole service with it.

So the confirmation set is pluggable:

```ts
export interface SegmentCacheProvider {
  /** A sync return keeps evaluation synchronous. Async is allowed and changes the contract — below. */
  has(segmentKey: string, contextKey: string): boolean | Promise<boolean>;
  /** Called when a segment-patch arrives; a shared remote provider may no-op. */
  apply?(segmentKey: string, delta: { add: string[]; remove: string[] }): void | Promise<void>;
}
```

```ts
const fk = new FeaturekitSDK({
  sdkKey: KEY,

  segmentCache: { kind: "memory" },       // default — omit entirely. In-heap Set, fully sync.

  // Memory-constrained: confirmation reads go to Redis/Valkey. The SDK only reads.
  segmentCache: { kind: "redis", client: valkeyReader, keyPrefix: "fk:seg:" },

  // Or a SQLite sidecar file, or anything satisfying the interface above.
  segmentCache: myProvider,
});
```

**What an async provider costs, stated plainly, because this is the one place the synchronous-evaluation promise bends.** `boolean()` stays synchronous — non-negotiable, §9.2 depends on it. An async provider is therefore consulted *out of band*: the SDK keeps a bounded LRU of confirmed `(segment, contextKey)` answers, a synchronous evaluation reads only that LRU, and an LRU miss is **unresolved** — which fails the rule closed by the rule above and enqueues a background fetch, so the next evaluation for that context resolves. The trade:

- **In-memory provider:** always resolved, zero unresolved evaluations, 50–80 MB.
- **Remote provider:** the first evaluation per `(segment, context)` fails closed and warms the cache; every subsequent one is exact. `featurekit_sdk_segment_unresolved_total` is the metric that says the LRU is too small; `SEGMENT_CACHE_LRU_MAX` is the knob.

In request-scoped workloads the same context usually evaluates several flags per request, so warm-up is paid once per context rather than once per evaluation — but a genuinely cold Lambda invocation *will* fail a large-segment rule closed on its first look. A deployment that cannot accept that keeps the in-memory provider and sizes the container for it. Both are defensible. Silently OOMing is not.

Segments above the inline threshold accept eventual consistency on membership changes — now bounded by patch delivery rather than by a refresh interval, documented, and surfaced in the dashboard.

### 9.8 Multi-context

```ts
export type EvaluationContext =
  | { kind?: "user"; key: string; anonymous?: boolean; [attr: string]: unknown }
  | { kind: "multi"; [contextKind: string]: { key: string; [attr: string]: unknown } | "multi" };

// Single-context — the common case, and the only shape most people ever write:
fk.get("new-checkout", { key: "usr_123", plan: "pro", country: "DE" }, false);

// Multi-context — on for everyone in a beta org, on a supported device:
fk.get("new-checkout", {
  kind: "multi",
  user: { key: "usr_123", plan: "pro" },
  organization: { key: "org_9", tier: "enterprise" },
  device: { key: "dev_abc", os: "ios", osVersion: "17.2" },
}, false);
```

A clause names its `contextKind`; if that kind is absent, the clause does not match. A rollout buckets on the key of *its* context kind — which is what lets you roll out to 10% of **organizations** (everyone in an org flips together) rather than 10% of users (a broken, half-migrated org that files a support ticket).

---

## 10. Distribution — server tier

### 10.1 The ruleset snapshot

Compiled from Postgres, cached in Redis, sent to **server SDKs only**.

```ts
export interface Snapshot {
  version: number;                 // monotonic per environment
  environmentKey: string;
  salt: string;                    // server tier only — the client tier never buckets
  flags: Record<string, CompiledFlag>;
  segments: Record<string, CompiledSegment>;
}

export interface CompiledFlag {
  key: string;
  version: number;                 // per-flag, for patch ordering
  kind: "boolean" | "string" | "number" | "json";
  on: boolean;
  variations: unknown[];           // positional; rules reference by index
  offVariation: number | null;
  fallthrough: { variation: number } | { rollout: Rollout };
  prerequisites: { key: string; variation: number }[];
  targets: { contextKind: string; variation: number; keys: string[] }[];
  rules: CompiledRule[];
}
```

```ts
export type CompiledSegment =
  | { kind: "inline"; version: number; members: string[]; excluded: string[] }
  /** Exact, and only when every member key is integral — the ordinal IS the key (§9.7). */
  | { kind: "roaring"; version: number; bitmap: Uint8Array; contextKind: string }
  /** Probabilistic but deletable. Positives are confirmed against the resolved set. */
  | { kind: "cuckoo"; version: number; filter: Uint8Array; fpRate: number; loadFactor: number };
```

Compilation does the work the SDK shouldn't: resolves variation uuids to indices, inlines small segments and builds deletable membership filters for large ones (§9.7), topologically orders prerequisites, rejects cycles, drops archived flags, and — for the client tier — **emits the referenced-attribute set of every flag** (§11.5), which is what makes fingerprint fan-out possible.

### 10.2 Wire protocol

`GET /v1/stream/:environmentKey` — SSE, authenticated by a **server** SDK key.

| Event | Payload | When |
| :-- | :-- | :-- |
| `put` | full `Snapshot` | On connect, and whenever patch replay is unavailable |
| `patch` | `{ path: "/flags/new-checkout", flag: CompiledFlag }` | A single flag changed |
| `delete` | `{ path, version }` | Flag archived or deleted |
| `ping` | — | Every 30s, so proxies don't reap the connection |

- **Version-guarded application.** The SDK ignores any patch at or below the version it holds. Duplicate broadcasts and out-of-order delivery become non-events rather than corruption.
- **Reconnect with jittered exponential backoff.** Without jitter, a control-plane restart is followed by every SDK reconnecting in the same millisecond.
- **Polling is a first-class fallback,** not a degraded mode: `GET /v1/snapshot/:env` with `If-None-Match`. Corporate proxies eat SSE, and some runtimes have no long-lived connections.

### 10.3 Patch replay has storage and a documented floor

`id:` on every SSE event is the snapshot version, and a reconnecting SDK sends `Last-Event-ID`. Replay needs history, which lives in `fk:patches:{envId}` — a Redis stream capped at `PATCH_HISTORY_DEPTH` (default 200) entries, each `{ version, op, flagKey, payload }`, written in the same step that publishes to `fk:chan:{envId}`.

Resume logic, and what each outcome means:

| `Last-Event-ID` vs history | Action |
| :-- | :-- |
| ≥ oldest retained version | Replay patches from that version, then stream live |
| < oldest retained version | Send a full `put`. The SDK was disconnected across more than `PATCH_HISTORY_DEPTH` changes |
| History empty (Redis restarted) | Send a full `put` |
| Ahead of current version | Send a full `put`. Should not happen; indicates a rolled-back database |

Retention is depth, not time, because what matters is how many *changes* were missed. At 200 entries a fleet reconnecting after a 10-minute network partition resumes cleanly unless someone toggled flags 200 times during it — in which case a full `put` is both correct and cheaper than replay. The depth is configurable and exposed as `featurekit_stream_patch_replay_ratio` so a deployment that keeps falling back to `put` can see it and raise the cap.

Losing this stream entirely is safe: every reconnect degrades to a full `put`, which is why §8 marks it lossy.

### 10.4 Change propagation

```
PATCH /v1/flags/:key/environments/:env
  → transaction: write config, bump version, write audit row
  → recompile snapshot (debounced ~200ms, guarded by fk:lock:snapshot:{envId})
  → SET fk:snap:{envId}:server, XADD fk:patches:{envId}, PUBLISH fk:chan:{envId}
  → each API node: push `patch` to its server-tier connections,
                   re-evaluate + push changed values to its client-tier connections (§11.5)
  → next evaluation reflects it
```

Target: **p99 under 300ms** from dashboard toggle to the flag flipping in a production process. That number is the product. A flag system whose kill switch takes 30 seconds is not a kill switch.

---

## 11. Public API surface

### 11.1 Server

```ts
import { FeaturekitServer } from "featurekit";

const server = new FeaturekitServer({ services: ["all"], port: 3000 });
await server.start();       // dev: Postgres + Redis containers start automatically
```

### 11.2 Server-tier SDK — synchronous

```ts
import { FeaturekitSDK } from "@featurekit/sdk";

const fk = new FeaturekitSDK({
  sdkKey: process.env.FEATUREKIT_SDK_KEY!,
  baseUrl: "https://flags.internal.acme.com",

  /**
   * Bootstrap from a snapshot committed to the repo. The SDK is usable at
   * import time, before the first network round-trip — the difference between a
   * cold start serving correct flags and one serving defaults.
   */
  bootstrap: snapshotJson,

  /** Survive a restart that happens during a control-plane outage. */
  persist: { kind: "file", path: ".featurekit/snapshot.json" },

  /**
   * Where large-segment membership is confirmed (§9.7). Defaults to an in-heap
   * Set — right for a long-lived service, fatal in a 128 MB container.
   */
  segmentCache: { kind: "memory" },

  mode: "streaming",                  // "streaming" | "polling" | "offline"
  events: { enabled: true, flushIntervalMs: 5_000, maxBatch: 1_000 },
});

/**
 * Readiness is explicit and happens once, at startup — not per call.
 * Resolves when a snapshot is in hand from any source: stream, poll,
 * persisted file, or bootstrap. Rejects nothing; times out into "serving
 * defaults", which is a legitimate state to run in.
 */
await fk.ready({ timeoutMs: 5_000 });

// Every evaluation is synchronous. The default is required — not optional.
const on: boolean   = fk.get("new-checkout", ctx, false);
const copy: string  = fk.get("hero-headline", ctx, "Ship faster");
const limit: number = fk.get("upload-limit-mb", ctx, 25);
const cfg: Pricing  = fk.json<Pricing>("pricing-config", ctx, DEFAULT_PRICING);

const detail = fk.detail("new-checkout", ctx, false);
// { value: true, variationIndex: 1, reason: { kind: "RULE_MATCH", ruleIndex: 0, ... } }

fk.on("change", ({ flagKey }) => cache.invalidate(flagKey));
fk.on("state", (s) => log.info({ state: s }));   // connected | reconnecting | offline
```

**Why the default value is a required argument.** Optional defaults produce `undefined` in production during an outage, and `if (undefined)` is a silent wrong answer nobody notices for a week. Requiring it forces every call site to state what happens when featurekit is unavailable — the one decision a flag SDK must not make on your behalf.

### 11.3 Config-as-code and typed keys

```ts
// flags.config.ts — lives in your repo, reviewed in PRs
import { defineFlags } from "@featurekit/sdk";

export const flags = defineFlags({
  "new-checkout": {
    kind: "boolean",
    name: "New checkout flow",
    temporary: true,
    tags: ["checkout", "q3"],
    variations: [false, true],
    defaults: { off: 0, fallthrough: 0 },
  },
  "upload-limit-mb": {
    kind: "number",
    name: "Upload limit",
    temporary: false,
    variations: [25, 100, 500],
    defaults: { off: 0, fallthrough: 0 },
  },
});

export type Flags = typeof flags;
```

```ts
const fk = new FeaturekitSDK<Flags>({ ... });

fk.get("new-checkout", ctx, false);        // ✅
fk.get("new-chekcout", ctx, false);        // ❌ compile error: unknown flag
fk.get("upload-limit-mb", ctx, false);     // ❌ compile error: not a boolean flag
```

Sync runs in CI, not at runtime:

```bash
npx featurekit sync --config flags.config.ts --project acme --env production
npx featurekit diff --config flags.config.ts     # what would change
```

Sync is **additive and non-destructive by default**: it creates missing flags and updates metadata, but never touches targeting rules or on/off state — those are operational state owned by whoever is on call, not by the last person to merge to main. Deletions require `--prune` and a confirmation.

### 11.4 React

```tsx
import { FeaturekitProvider, useFlag } from "@featurekit/react";

<FeaturekitProvider clientKey={KEY} context={{ key: user.id, plan: user.plan }}>
  <App />
</FeaturekitProvider>;

function Checkout() {
  const newCheckout = useFlag("new-checkout", false);   // synchronous, no Suspense
  return newCheckout ? <NewCheckout /> : <LegacyCheckout />;
}
```

`useFlag` is a synchronous `useSyncExternalStore` subscription over the client SDK's local value map. It never suspends and never returns `undefined`.

**SSR.** The server evaluates for the request's context and inlines the resulting **values** (not the ruleset) as the client's bootstrap. No flag flicker, because the client's first paint uses the same values the server rendered — and the payload is smaller and leaks nothing. This is strictly better than shipping a ruleset, which is one of several reasons the client tier works the way §11.5 describes.

### 11.5 Client tier — evaluated values, not rules

**The client tier does not receive the ruleset.** This is the single largest correction to revision 1, which specified one snapshot for everyone.

Shipping rules to a browser leaks the business, not just the values. A rule reading `plan == "enterprise" → new-pricing` tells anyone with devtools that an unreleased pricing tier exists and what it's called. Segment definitions name your churn-risk cohort. Rollout percentages disclose release plans. None of that is fixed by minification, and the r1 design compounded it: §10.1 omitted `salt` from client payloads, but §9.3 needs the salt to bucket — so browser SDKs either could not do percentage rollouts at all, or the salt shipped and was not a secret. The design was internally inconsistent, and both ways of resolving it were wrong.

**The client tier receives evaluated values for one context.**

```ts
export interface FlagState {
  /** Hash of the context this state was evaluated for. Echoed back on every response. */
  contextHash: string;
  /** Monotonic per SDK instance, echoed from the request. Guards against out-of-order application. */
  seq: number;
  version: number;
  values: Record<string, { value: unknown; variationIndex: number | null; reason: string }>;
}
```

```ts
import { FeaturekitBrowser } from "@featurekit/browser";

const fk = new FeaturekitBrowser({
  clientKey: PUBLIC_KEY,
  baseUrl: "https://flags.acme.com",
  context: { key: user.id, plan: user.plan },
  contextSignature: serverIssuedHmac,     // HMAC(`${key}:${expiresAt}`) — §16
  contextSignatureExpiresAt: expiresAt,   // unix seconds; the server rejects stale ones
  onSignatureExpiring: refreshSignature,  // called before expiry; returns a fresh pair
  bootstrap: ssrInlinedState,             // from §11.4
});

await fk.ready({ timeoutMs: 2_000 });

fk.get("new-checkout", false);            // synchronous map lookup, no context arg
await fk.identify({ key: newUser.id, plan: "pro" });   // the one async operation
```

Note the signature difference: no context argument, because the connection *is* the context.

**What this costs, honestly.**

- **One round trip per context change,** not per evaluation. `identify()` is the only async call.
- **On a context-key change, previous values are discarded, not reused.** Serving user A's flags to user B after a login is a real bug class and a privacy leak. Between `identify()` and its response, every lookup returns the caller's default. Attribute-only changes on the same key keep serving the old values, since those are stale but not misattributed.
- **Concurrent `identify()` calls apply in call order, not response order.** Discarding on change is necessary but not sufficient — two rapid calls reintroduce the same bug through the network:

  ```ts
  fk.identify({ key: "user_A" });   // request 1 — slow response
  fk.identify({ key: "user_B" });   // request 2 — fast response, applied
                                    // request 1 lands late and overwrites B with A
  ```

  An account switcher, a React effect that fires twice, or a login immediately after an anonymous identify all produce this, and the result is the exact failure the previous bullet exists to prevent — user A's flags in user B's session — arriving by a route that bullet does not cover. The SDK therefore holds a monotonically increasing `seq`, sends it with every `/v1/client/state` request, and **drops any response whose `seq` is below the highest already applied, or whose `contextHash` does not match the current context.** Both checks, not either: `seq` catches reordering, `contextHash` catches a stale response for a context that was re-identified back to an equal value. The superseded call's promise resolves rather than hanging — it was superseded, not failed — and the SSE stream is re-subscribed only on the winning response, so a late reply cannot resurrect a closed connection's context.
- **The server re-evaluates per connected context on change,** which is O(connected contexts × changed flags). r2 called the fix an optimization and deferred it to "if the load demands it". That was wrong about *when* the load demands it — see **Fan-out is fingerprint-keyed** below, which makes it part of the tier rather than something bolted on after.
- **What still leaks:** the keys of flags marked `clientAvailable`, and the values *this* context receives. Inherent to any client-side flag system. `clientAvailable` defaulting to `false` (§7.3) is what keeps unreleased work out of it entirely.

**Fan-out is fingerprint-keyed, from M2.**

The naive fan-out is a thundering herd pointed at your own control plane. Toggle one flag with 50,000 connected browsers and the control plane immediately owes 50,000 evaluations and 50,000 distinct SSE writes — a self-inflicted load spike, triggered by the single most routine action in the product, at exactly the moment an operator is most likely to be flipping a kill switch during an incident. Sharding the API tier does not fix it; it distributes the same total work while multiplying the connection state.

The observation that collapses it: **an evaluation is a function of the attributes the flag's rules actually reference, and nothing else.** The compiler already computes that set (§10.1). So before evaluating, normalize each connected context down to the changed flags' referenced attributes:

```ts
// The compiler emitted: referencedAttributes("new-checkout") = ["country", "plan"]
// Connection ctx: { key: "usr_9f3", country: "US", plan: "pro", email: ..., signupAt: ... }
// Fingerprint:    sha256("country=US|plan=pro")            // the key is NOT included

const buckets = new Map<Fingerprint, ConnectionId[]>();      // maintained incrementally
for (const [fp, conns] of buckets) {
  const values = cache.get(fp) ?? cache.set(fp, evaluate(changedFlags, representativeCtx(fp)));
  fanout(conns, values);                                     // one payload, N sockets
}
```

50,000 contexts collapse to the few hundred distinct `(country, plan)` pairs that exist. The evaluation count drops from *connections* to *distinct attribute combinations* — typically under 500 for a real user base, and bounded above by the cross-product of the referenced attributes' cardinalities, which the dashboard can show before anyone ships a rule.

Three details that make it correct rather than approximately correct:

- **Percentage rollouts break the collapse, and are handled separately.** A rollout buckets on the context *key*, so a flag with a rollout has a per-context answer by construction and cannot share a fingerprint. The compiler marks those flags, and their fan-out computes the bucket per connection — but only the bucket, against a variation set resolved once per fingerprint. That is an integer hash per connection (§9.3, ~14 ns), not a rule evaluation, so 50,000 of them is under a millisecond of CPU.
- **Individual targets break it too**, in the same way and with the same handling: `targets` is a key lookup, so a fingerprint bucket resolves the rule outcome once and the target check runs per connection.
- **The fingerprint excludes the context key** — that is the entire point — which means the LRU is safe to share across users but must be invalidated on any snapshot version bump. It is keyed `(environmentVersion, flagKey, fingerprint)`, so a version bump invalidates by construction rather than by an explicit sweep.

**Why M2 and not M5.** The cache itself is M5 work and small. What is *not* small is the compiler emitting referenced-attribute sets, the wire format carrying them, and the evaluator being structured so a rule outcome can be computed once and specialised per connection. Retrofitting that into a shipped evaluator is the rewrite r2 was worried about; emitting the sets in M2 costs almost nothing and makes M5 an afternoon. The compiler ships referenced-attribute sets in **M2**. The cache turns on in **M5**.

The second mitigation stands unchanged and is orthogonal: shed connections above `MAX_CLIENT_CONNECTIONS` to short-TTL polling, so the tier degrades on a curve instead of a cliff.

`@featurekit/edge` runs in whichever tier fits: with a server key in a trusted worker it holds the ruleset and evaluates locally; in front of untrusted clients it is a client-tier consumer.

### 11.6 OpenFeature

`@featurekit/openfeature` implements the OpenFeature provider spec. Adopting featurekit shouldn't mean rewriting call sites, and it shouldn't be a one-way door.

---

## 12. REST API

### SDK-facing (SDK key auth)

```
# server tier
GET    /v1/stream/:envKey          SSE ruleset stream (server keys only)
GET    /v1/snapshot/:envKey        Poll fallback (ETag / 304)
GET    /v1/segments/:key/members   External segment set + membership filter (§9.7)
GET    /v1/segments/:key/delta     Membership delta since a version (§9.7)

# client tier
POST   /v1/client/state            Context in → evaluated values out
GET    /v1/client/stream           SSE value updates for the connection's context

# both
POST   /v1/events                  Batched evaluation summaries
POST   /v1/evaluate                Server-side evaluation for languages with no SDK
```

### Management (personal access token auth)

```
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/:p/environments
POST   /v1/projects/:p/environments

GET    /v1/projects/:p/flags
POST   /v1/projects/:p/flags
GET    /v1/projects/:p/flags/:key
PATCH  /v1/projects/:p/flags/:key                       metadata: name, tags, temporary
DELETE /v1/projects/:p/flags/:key

PATCH  /v1/projects/:p/flags/:key/environments/:env     ★ targeting config
POST   /v1/projects/:p/flags/:key/environments/:env/toggle
POST   /v1/projects/:p/flags/:key/environments/:env/schedule

GET    /v1/projects/:p/environments/:env/segments
PUT    /v1/projects/:p/environments/:env/segments/:key

GET    /v1/projects/:p/audit
POST   /v1/projects/:p/audit/:id/revert                 one-click rollback

GET    /v1/projects/:p/flags/:key/insights              eval counts, split, staleness
POST   /v1/debug/evaluate                               ★ "why did X get Y?"
```

### Operational

```
GET /health   GET /live   GET /ready   GET /metrics
```

`POST /v1/debug/evaluate` takes a flag key, an environment, and a context, and returns the full `EvaluationDetail` plus the rule that matched and the computed bucket integer. The single most useful endpoint for support, and what backs the MCP agent's answers.

---

## 13. Agent operation (MCP)

`npx -y @featurekit/mcp`, the same shape as `@notifkit/mcp`.

```text
You: Why is new-checkout still off for usr_9182? They're on the pro plan.

Agent: It's on for them at the flag level — but new-checkout has a prerequisite,
       `payments-v2`, requiring variation "enabled". usr_9182 evaluates
       payments-v2 to "disabled" because rule 0 excludes country=DE.
       So new-checkout returns its off variation, reason PREREQUISITE_FAILED.
```

- **Read** — `list_flags`, `get_flag`, `explain_evaluation`, `get_flag_insights`, `list_stale_flags`
- **Change** — `toggle_flag`, `update_targeting`, `set_rollout`, `add_target`, `schedule_change`
- **Safety** — `list_audit`, `revert_change`, `kill_switch` (off in every environment, one call)
- **Segments** — `list_segments`, `update_segment`

Guardrails: writes to production environments are **dry-run by default**, returning the diff plus an estimate of the affected population; applying requires an explicit confirm argument. Every agent-initiated change writes an audit row with `actorKind: "token"` and the agent's identity, so "who turned this off at 3am" always has an answer.

---

## 14. Reliability and failure modes

The property being sold: **featurekit failing should be invisible to your users.**

| Failure | Server tier | Client tier |
| :-- | :-- | :-- |
| Control plane down at startup | Bootstrap → persisted snapshot → caller defaults. Never blocks, never throws. | SSR bootstrap → caller defaults |
| Control plane down mid-run | Last good snapshot serves indefinitely. Jittered reconnect. No user impact. | Last received values serve indefinitely |
| `identify()` during an outage | n/a | Times out; values stay invalidated and defaults serve. **A login must not inherit the previous user's flags.** |
| Out-of-order `identify()` responses | n/a | Responses below the highest applied `seq`, or whose `contextHash` no longer matches, are dropped. The last *call* wins, never the last *response* |
| External segment not yet loaded (§9.7) | **The whole rule fails closed** with `reason: SEGMENT_UNRESOLVED`, negated clauses included; `segment_unresolved_total` increments | Server-side, so unaffected |
| `SegmentCacheProvider` (Redis/sidecar) unreachable | Provider errors are caught, not thrown: treated as unresolved, so the rule fails closed. Evaluation never blocks and never rejects. | Unaffected |
| Client signature expired | n/a | 401 `SIGNATURE_EXPIRED`. **Last values keep serving** while `onSignatureExpiring` fetches a fresh pair — an expired signature is not an identity change, so nothing is invalidated |
| Client signature invalid or missing in production | n/a | 401, connection refused, caller defaults serve. Never a silent downgrade to unsigned |
| External segment stale during outage | Last loaded set serves; membership changes are not seen | Unaffected |
| Postgres down | Snapshots serve from Redis. Reads fine, writes 503. | Values serve from connection state; `identify()` 503s |
| Redis down | Snapshots recompiled from Postgres per node. Patch replay unavailable → reconnects get full `put`. | Re-evaluation still works; connection registry rebuilt on reconnect |
| Patch history exhausted | Full `put`. Correct, just larger. | n/a |
| Malformed rule reaches an SDK | That flag returns the caller's default, `reason: ERROR`. Others unaffected. | Same, server-side |
| Snapshot version regression | Rejected by the version guard | Rejected by the version guard |
| Event backlog | Bounded buffer, drop-oldest, `events_dropped_total`. **Analytics loss is acceptable; blocking an evaluation is not.** | Same |
| Clock skew | Only date operators and scheduled changes depend on time; scheduling is server-side, so SDK skew cannot fire a change early | Same |

### Chaos suite (`tests/chaos/`)

- **`control-plane-down.test.ts`** — SIGKILL the API under live evaluation load. Assert zero evaluation errors and zero changed values across the outage.
- **`stream-flap.test.ts`** — Sever and restore SSE repeatedly, including across more than `PATCH_HISTORY_DEPTH` changes. Assert convergence, no missed patches, and correct `put` fallback.
- **`storm.test.ts`** — 1,000 concurrent SDKs, one flag toggled 100 times in 10 seconds. Assert every SDK converges, the debounce holds, the compile lock prevents a herd.
- **`bucketing-stability.test.ts`** — 1M synthetic contexts through a 10% rollout. Assert 10% ±0.5%, and **zero** contexts change variation when an unrelated flag is edited, when the SDK restarts, or when a node joins.
- **`client-identify.test.ts`** — Kill the control plane mid-`identify()`. Assert defaults serve and that no value from the previous context key is ever returned. Then, with the control plane healthy, fire `identify(A)` and `identify(B)` back to back with A's response artificially delayed past B's: assert the late response is dropped on `seq`, that the resolved state is B's, and that the stream is subscribed to B.
- **`rollup-contention.test.ts`** — N ingest workers, one hot flag. Assert single-writer sharding holds and no bucket loses counts under shard rebalance.
- **`segment-fail-closed.test.ts`** — Evaluate a rule with a **negated** segment clause before membership loads, and again with the `SegmentCacheProvider` unreachable. Assert the rule does not match in either case and the reason is `SEGMENT_UNRESOLVED`. This is the r2 leak (§9.7); it gets a chaos test, not just a unit test, because the bug only appears in the window between start and load.
- **`segment-delta.test.ts`** — Remove one member from a 500k-member segment. Assert a delta patch is broadcast, not a full filter, and that every connected SDK stops matching that member within the propagation budget.
- **`client-fanout.test.ts`** — 50,000 client connections spanning ~300 distinct attribute fingerprints; toggle one flag. Assert evaluation count tracks fingerprints rather than connections, that every connection receives the correct value, and that a rollout flag still buckets per connection.
- **`signature-expiry.test.ts`** — Let a client signature expire mid-session. Assert 401 `SIGNATURE_EXPIRED`, that previously received values keep serving through the refresh, and that a signature replayed after `expiresAt` is refused.
- **`degraded.test.ts`** — Kill Redis, then Postgres, then both. Assert evaluations continue at every stage.

---

## 15. Observability

**Server**

```
featurekit_snapshot_compile_duration_seconds{environment}
featurekit_snapshot_version{environment}
featurekit_stream_connections{environment,tier}
featurekit_stream_patch_replay_ratio{environment}     # low => raise PATCH_HISTORY_DEPTH
featurekit_client_eval_duration_seconds{environment}  # client-tier re-eval cost (§11.5)
featurekit_client_eval_cache_hit_ratio{environment}
featurekit_client_fingerprints{environment}           # distinct attribute combos resident (§11.5)
featurekit_client_fanout_evaluations_total{environment}  # should track fingerprints, not connections
featurekit_client_signature_rejected_total{reason}    # expired | invalid | missing (§16)
featurekit_segment_filter_bytes{segment,encoding}     # roaring | cuckoo (§9.7)
featurekit_segment_filter_load_factor{segment}        # approaching PATCH_CEILING => re-encode due
featurekit_segment_filter_rebuild_total{reason}       # seed_retry | table_growth | patch_ceiling
featurekit_partition_runway_days                      # ★ pages before inserts have nowhere to land
featurekit_change_propagation_seconds{environment}    # toggle → SDK applied
featurekit_rollup_lag_seconds{shard}
featurekit_events_dropped_total{reason}
```

**SDK** (exported for the host app to scrape)

```
featurekit_sdk_evaluations_total{flag,variation,reason}
featurekit_sdk_evaluation_duration_seconds{path}      # hashed vs non-hashed (§1)
featurekit_sdk_snapshot_age_seconds
featurekit_sdk_stream_state{state}                    # connected|reconnecting|offline
featurekit_sdk_segment_unresolved_total{segment}      # §9.7 — rules failing closed
featurekit_sdk_segment_cache_duration_seconds{provider}  # remote SegmentCacheProvider latency
featurekit_sdk_default_served_total{flag,reason}      # ★ the alert that matters
```

`featurekit_sdk_default_served_total` rising means your app is silently running on hard-coded defaults. **It should page.** It is the metric most flag deployments don't have and wish they did.

**Flag insights**, per flag: evaluation volume over time, live variation split, last-evaluated timestamp, age. These drive stale-flag detection — *temporary, older than 60 days, returning one variation for 100% of evaluations over 14 days* → "this flag is done; here's the PR to delete it."

---

## 16. Security

- **Server SDK keys** are hashed at rest and grant the full ruleset. Treat as a secret.
- **Client / mobile keys** are public by construction and grant only evaluated values for a context the holder can prove. **The tier split is the security boundary** — §11.5 — not a filter applied at serialisation time, which is a filter someone eventually forgets on a new endpoint.
- **Secure mode is required by default in production environments, and signatures expire.** Because the server evaluates *as* a claimed identity, an unsigned context key would let anyone evaluate as anyone — including reading flags targeted at a specific named account. Production environments reject unsigned contexts unless explicitly opted out, and the dashboard says so loudly.

  r2 signed the key alone — `HMAC_SHA256(userId, SECRET)` — which makes the signature **a bearer credential that never expires**. Captured once, from a proxy log, an error report carrying request headers, an APM trace, a shared or stolen browser session, it grants permanent ability to poll `/v1/client/state` as that user. The only revocation is rotating `SECURE_MODE_SECRET`, which invalidates *every* user simultaneously and so is never done in response to one leak. A credential whose only revocation mechanism is a global outage is not revocable.

  The signed payload therefore carries an expiry:

  ```ts
  // On the customer's own server, wherever the session is already trusted:
  const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const signature = hmacSha256(`${user.id}:${expiresAt}`, SECURE_MODE_SECRET);
  return { key: user.id, expiresAt, signature };            // both fields go to the browser
  ```

  The server recomputes over the same `${key}:${expiresAt}` pair and additionally rejects: an `expiresAt` already past; an `expiresAt` further out than `SECURE_MODE_MAX_TTL_SECONDS` (default 24h), so a caller cannot mint a decade-long token and reintroduce the problem; and any comparison that is not constant-time. Expiry returns **401 `SIGNATURE_EXPIRED`** — a distinct code from `SIGNATURE_INVALID`, because the SDK's response differs: expired triggers `onSignatureExpiring` and a re-identify while the last known values keep serving, whereas invalid drops to caller defaults.

  **This bounds replay rather than preventing it.** A captured signature is usable until `expiresAt`, and closing that window entirely would need a server-side nonce per connection — per-connection write state on a tier explicitly designed not to have any, to defend a payload that is already only *this* user's flag values. A bounded, rotatable window matching ordinary session-token lifecycles is the right trade, and it is stated here so nobody mistakes it for something stronger.

  **Rotation without a flag day:** `SECURE_MODE_SECRET` accepts a comma-separated list. Signing uses the first; verification tries all. Rotation becomes two ordinary deploys.
- **`clientAvailable` defaults to `false`.** A flag's *existence* is not disclosed to browsers until someone decides it should be.
- **Rate limits** per SDK key, sliding window in Redis, with a much tighter budget for `/v1/client/state` (it costs a server-side evaluation) than for `/v1/snapshot`.
- **Regex clauses** are length-capped and complexity-checked at write time.
- **Production environments** require explicit confirmation on destructive management calls, and can require approval via `change_requests`.
- **Audit everything**, including changes made by scheduled jobs and agents.

---

## 17. Configuration

```ts
export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace","silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().url().default("postgres://featurekit:featurekit@localhost:5432/featurekit"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  ADMIN_TOKEN: z.string().min(24).optional(),
  /** Signs client-tier context HMACs. Comma-separated for rotation: sign with the first,
   *  verify against all. Required in production (§16). */
  SECURE_MODE_SECRET: z.string().min(32).optional(),
  /** Longest signature lifetime the server will honour, regardless of what was signed. */
  SECURE_MODE_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),

  SNAPSHOT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(200),
  PATCH_HISTORY_DEPTH: z.coerce.number().int().min(0).default(200),
  MAX_STREAM_CONNECTIONS: z.coerce.number().int().min(1).default(10_000),
  MAX_CLIENT_CONNECTIONS: z.coerce.number().int().min(1).default(50_000),
  STREAM_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),

  SEGMENT_INLINE_MAX: z.coerce.number().int().min(0).default(50_000),
  SEGMENT_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Membership encoding for large segments (§9.7). "auto" prefers roaring when ordinals are dense. */
  SEGMENT_FILTER: z.enum(["auto", "roaring", "cuckoo"]).default("auto"),
  /** Cuckoo fingerprint width. 16 is byte-aligned (ε≈0.012%); 12 trades accuracy for ~25% space. */
  SEGMENT_CUCKOO_FINGERPRINT_BITS: z.union([z.literal(12), z.literal(16)]).default(16),
  /** Sizing target. Buckets = nextPow2(ceil(n / (4 * this))). */
  SEGMENT_CUCKOO_LOAD_FACTOR: z.coerce.number().min(0.5).max(0.9).default(0.8),
  /** Above this, an incremental patch is refused and a full re-encode is emitted instead. */
  SEGMENT_CUCKOO_PATCH_CEILING: z.coerce.number().min(0.5).max(0.95).default(0.85),
  /** SDK-side: confirmed-membership LRU when a remote SegmentCacheProvider is used. */
  SEGMENT_CACHE_LRU_MAX: z.coerce.number().int().min(1_000).default(100_000),

  /** Client-tier fingerprint fan-out (§11.5). */
  CLIENT_EVAL_CACHE_MAX: z.coerce.number().int().min(100).default(50_000),
  CLIENT_FANOUT_BATCH: z.coerce.number().int().min(1).default(500),

  EVENT_BUFFER_MAX: z.coerce.number().int().min(1000).default(100_000),
  EVENT_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  ROLLUP_SHARDS: z.coerce.number().int().min(1).default(8),
  ROLLUP_BUCKET_SECONDS: z.coerce.number().int().min(60).default(60),
  /** Written into partman.part_config at migration time — not read at runtime (§7.9). */
  ROLLUP_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  ROLLUP_PARTITION_PREMAKE_DAYS: z.coerce.number().int().min(2).default(7),

  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
});
```

Production start fails loudly on a missing `DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN`, or — if any client key exists — `SECURE_MODE_SECRET`. Development starts containers instead. **The defaults are for laptops, never for prod.**

---

## 18. Milestones

**M1 — Evaluation core.** `packages/sdk/evaluation/` complete and dependency-free: operators, murmur3 bucketing with integer math, precedence, multi-context, prerequisites, segments over roaring bitmaps and cuckoo filters, and the three-state clause result that makes an unresolved rule fail closed under negation (§9.7).
*Exit criteria:* hand-computed conformance corpus (§9.5) including non-ASCII keys, boundary buckets, and **negated clauses against unresolved segments in both polarities**; published benchmark for hashed and non-hashed paths; **the hash function is frozen** (§9.4); **the cuckoo wire format is frozen** (§9.7) — `(2,4)`, 16-bit fingerprints, power-of-two buckets, XOR alternate index — with corpus fixtures carrying pre-encoded filters plus known members and known non-members, so a future non-JS SDK is verified against bytes rather than against a description of bytes.

*Also in M1, because they are the failure modes that only appear at scale:* a property test asserting `alt(alt(i)) === i` across the whole index space for every table size the compiler can emit, and a **1M-member import test asserting zero relocation failures and zero rebuilds** at α = 0.8. A construction bug here is silent at 10k members and a rebuild loop at 1M.

**M2 — Storage and compile.** Drizzle schema, migrations including the partitioned DDL and its `pg_partman` / `pg_cron` configuration (§7.9), segment ordinals, repositories, snapshot compiler with cycle detection and membership-filter generation. **The compiler emits referenced-attribute sets here** — cheap now, a rewrite later (§11.5). Integration tests on real containers.

**M3 — Control plane.** Management REST, SDK-key auth, audit log, Redis snapshot cache, patch history, pub/sub. Change propagation end to end.

**M4 — Server-tier delivery.** SSE with patch replay and documented resume floor, segment delta patches, polling fallback, `@featurekit/sdk` with bootstrap, persistence, synchronous evaluation, `ready()`, and the `SegmentCacheProvider` interface with its in-memory and Redis implementations (§9.7). **Chaos suite lands here** — this is where the reliability claim becomes true or false.

**M5 — Client tier.** Server-side evaluation service, `/v1/client/state` and stream, `@featurekit/browser`, secure mode with expiring signatures and rotation (§16), `@featurekit/react` with SSR bootstrap, and **fingerprint-keyed fan-out** (§11.5) — part of the tier, not a later optimisation.

**M6 — Analytics.** SDK summarizer, sharded ingest, single-writer rollup, flag insights, stale-flag detection. Partition maintenance is `pg_partman`'s job (§7.9); the application's only contribution is the readiness check that pages when partition runway drops below two days.

**M7 — Surface.** Dashboard, `@featurekit/cli`, config-as-code sync with typed flags.

**M8 — Reach.** `@featurekit/edge`, `@featurekit/openfeature`, `@featurekit/mcp`, `llms-full.txt`.

**M1–M5 is v1.** Everything after is leverage on a core that already works. Shipping M4 without the chaos suite would be shipping the marketing copy without the thing it describes.

---

## 19. Decisions still open

1. **When `auto` picks cuckoo over roaring.** Roaring is exact and usually smaller, but degenerates on sparse ordinals — a segment of 1,000 members whose ordinals span 10M is worse as a bitmap than as a cuckoo filter. The threshold is a density ratio nobody has measured yet, and `SEGMENT_FILTER` exists so an operator can override whatever the heuristic decides. The cuckoo FP rate (0.1%, ~1.2 KB/1,000 members) is a bandwidth question rather than a correctness one, since every positive is confirmed (§9.7).
2. **HLL implementation.** Postgres has no native HLL without an extension. Ship `postgresql-hll` as a requirement, implement the sketch in TS and store `bytea`, or accept sampled approximate counts? The single-writer design (§7.9) makes the TS option cheaper than it would otherwise be.
3. **Whether a segment may nominate an ordinal *attribute*.** Roaring eligibility currently requires the context *key* to be integral (§9.7), which excludes anyone on uuid keys even when their contexts already carry a numeric `accountId`. Allowing `ordinalAttribute: "accountId"` would extend exact matching to them at the cost of a rule that only works when that attribute is present — and an absent attribute is unresolved, which fails the rule closed and would make an optimisation into a targeting change. Probably worth it; definitely not before there is a real segment that wants it.
4. **Mobile SDKs.** Native iOS/Android are client-tier consumers, which means a real port of nothing — no evaluator, just an HTTP client. That is now a much smaller project than r1 implied. Worth doing in v1?
5. **Multi-region.** Logical replication with regional read replicas, or a single write region with edge-cached snapshots? Out of scope for v1, but the client tier's per-context evaluation makes regional placement matter more than it would have.

---

## 20. Deferred: experiments

Revision 1 put `experiments`, `metrics`, `metric_events`, `experiment_exposures`, and `experiment_results` in the v1 schema. They are removed, for three reasons.

**It contradicted the positioning.** §1 says featurekit does not want your event firehose, while §7.10 ingested arbitrary valued events keyed by subject. Both cannot be true.

**It is a second product.** Flag delivery plus experimentation is LaunchDarkly plus Statsig. The experimentation half needs metric definition, attribution windows, sequential statistics, guardrail alerting, and a results UI — none of which shares machinery with flag delivery beyond the assignment itself.

**It would have constrained v1 before anyone learned anything.** Committing `metric_events` to the schema fixes the event pipeline's shape around a workload nobody has run yet, and `experiment_exposures` forces a per-subject write path into a system whose entire analytics design (§7.9) is built on *not* having one.

**What v1 preserves so experiments land later without a rewrite:**

- `Rollout.seed` is already in the wire format and honoured by the evaluator (§9.3). An experiment freezes its seed at start, so editing a flag's rollout afterwards cannot re-randomise a running test. This is the one thing that is genuinely painful to retrofit, and it costs nothing now.
- `EvaluationDetail.reason` already carries `ruleIndex` and `ruleId`, enough to reconstruct which rule assigned a subject.
- The event pipeline (§7.9) is shard-keyed and single-writer, so a per-subject exposure stream can be added as a second consumer group on `fk:events` rather than as a change to the existing one.
- `fk.track()` is **not** in v1. When experiments arrive it will live in a separate entry point with its own buffer, so metric ingestion can never contend with flag delivery.

---

## 21. What changed in revision 2 (kept for the record)

| # | Change | Why |
| :-- | :-- | :-- |
| 1 | **Client tier receives evaluated values, not rules** (§11.5) | r1 was internally inconsistent — `salt` was withheld from client payloads but required to bucket, so browsers either couldn't roll out or the salt wasn't secret. Shipping rules also leaks unreleased features, segment definitions, and release plans to anyone with devtools. |
| 2 | **murmur3 over UTF-8 bytes, integer rollout math** (§9.3–9.4) | `parseInt(sha1.slice(0,15),16)` rounded 96.5% of hashes past `MAX_SAFE_INTEGER`, which would have baked JS float artifacts into the conformance corpus. SHA-1 also cost 2,500 ns/op — 0.4M/sec against a "millions/second" claim. Float weight accumulation defeated the integer weight scale. |
| 3 | **Synchronous evaluation, explicit `ready()`** (§9.2, §11.2) | A promise per call adds a microtask to a 14ns operation and cannot be used in a React render, which `useFlag` already was. |
| 4 | **External segments resolved via Bloom filter, no I/O on the eval path** (§9.7) | The async signature existed to allow a network call mid-evaluation, contradicting both the latency claim and the outage story. r1 had no failure-mode row for it. *Filter choice superseded in r3 — §22.2.* |
| 5 | **`fk:patches:{envId}` capped stream + documented resume floor** (§8, §10.3) | r1 promised patch replay with nothing storing patch history. |
| 6 | **`evaluation_summaries` partitioned, sharded, single-writer** (§7.9) | r1 gave the only high-volume table a unique constraint forcing cross-worker upserts on hot rows, plus an HLL sketch requiring read-modify-write. |
| 7 | **Experiments deferred; `featurekit` split from `@featurekit/sdk`** (§2, §20) | r1 said "M1–M4 is the whole product" and then committed five experimentation tables to the v1 schema. And a flag SDK must not drag Drizzle and ioredis into every service. |
| 8 | **`segments` composite FK** (§7.6) | `projectId` was derivable from `environmentId` with nothing enforcing agreement. |

---

## 22. What changed in revision 3

r2 was structurally sound; every item below is a distributed-systems or operational edge it left open rather than a design it got backwards. Most are cheap now and expensive after v1 freezes.

| # | Change | Why |
| :-- | :-- | :-- |
| 1 | **Fingerprint-keyed client fan-out, specified in M2 and shipped in M5** (§11.5) | r2 deferred it to "if the load demands it". One toggle against 50k connections is 50k evaluations and 50k SSE writes — a self-inflicted load spike triggered by the most routine action in the product, often during an incident. Collapsing contexts to the attributes the changed flags reference takes that to a few hundred evaluations. The compiler work is the part that cannot be retrofitted. |
| 2 | **Cuckoo filters replace Bloom filters; roaring bitmaps where keys are integral** (§9.7, §7.6, §10.1) | Bloom filters cannot delete. Removing one member from a 500k allow-list forced a ~900 KB re-encode broadcast to every SDK, on the stream that carries kill switches. Cuckoo is the default because roaring needs an ordinal the SDK can compute from the key alone — a translation dictionary would cost more heap than the Set it replaces, so roaring is scoped to integral keys and MPHF is rejected with reasons. Cuckoo parameters are frozen as a wire format in M1, and r2's Bloom sizing (1.2 KB/1,000 at 0.1%) is corrected — that was 1% accuracy priced as 0.1%. |
| 3 | **Unresolved segments fail the rule closed, never the clause** (§9.6, §9.7, §14) | r2's "cache miss → clause is false" **inverts under `negate`**. `NOT in beta_testers` with an unloaded cache evaluated to *true* and served the gated feature to everyone unconfirmed. Exclusion lists are the ordinary use of negated segment clauses, so this was the feature failing open, in a window that exists on every cold start. |
| 4 | **`SegmentCacheProvider` makes the confirmation set pluggable** (§9.7, §11.2, §17) | 50–80 MB of V8 heap is fine in a long-lived service and fatal in a 128 MB Lambda or a memory-limited pod. The failure there is OOMKilled, not slow. A remote provider costs one fail-closed evaluation per cold `(segment, context)`, which is stated rather than hidden. |
| 5 | **Client HMAC signs `${key}:${expiresAt}`, with rotation** (§16, §11.5, §14) | `HMAC(userId)` alone is a bearer credential that never expires: captured once from a log or a trace, it polls as that user forever, and the only revocation is a global secret rotation. A bounded window plus a distinct `SIGNATURE_EXPIRED` code — and the honest note that this bounds replay rather than preventing it. |
| 6 | **Partition lifecycle moves to `pg_partman` + `pg_cron`, with no `DEFAULT` partition** (§7.9, §17, §18) | An in-house Node partition worker fails three well-known ways — deploy races on `CREATE TABLE`, DST/timezone drift, and a missed midnight run that leaves inserts with no partition. `p_premake => 7` survives a week of missed maintenance. A `DEFAULT` partition looks like belt-and-braces and instead deadlocks future partition creation the moment one row lands in it. The app keeps one job: page when runway drops below two days. |
| 7 | **`identify()` responses apply in call order, not response order** (§11.5, §14) | Discarding values on a key change does not cover the network. `identify(A); identify(B)` with A responding late re-creates exactly the leak that rule exists to prevent — A's flags in B's session. Responses now carry `seq` and `contextHash`, and a superseded one is dropped. |

---

## 23. What "done" looks like for v1

```bash
npm install @featurekit/sdk        # in your services
npm install featurekit             # wherever you run the control plane
```

```ts
import { FeaturekitServer } from "featurekit";
import { FeaturekitSDK } from "@featurekit/sdk";

const server = new FeaturekitServer({ services: ["all"], port: 3000 });
await server.start();                    // Postgres + Redis auto-started in dev

const fk = new FeaturekitSDK({ sdkKey: KEY, baseUrl: "http://localhost:3000" });
await fk.ready();

if (fk.get("new-checkout", { key: user.id, plan: user.plan }, false)) {
  renderNewCheckout();
}
```

Toggle it in the dashboard. It flips in **under 300ms**, everywhere, without a deploy.

Kill the server. It keeps working.

**That's the product.**
