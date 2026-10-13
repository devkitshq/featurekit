/**
 * The evaluation core's type surface.
 *
 * This file — and every file in `evaluation/` — imports nothing. Not zod, not
 * the logger, nothing. It is the only source compiled into both the control
 * plane and every SDK, so it must survive being bundled into a browser, an
 * edge runtime, and eventually ported to another language.
 * `tests/evaluation/purity.test.ts` enforces that.
 */

/* ─────────────────────────── Context ─────────────────────────── */

/** One context kind's identity and attributes. `key` is mandatory. */
export interface ContextAttributes {
  key: string;
  anonymous?: boolean;
  [attribute: string]: unknown;
}

/** The common case, and the only shape most callers ever write. */
export interface SingleContext extends ContextAttributes {
  kind?: string;
}

/** Several kinds at once: a user, in an org, on a device. */
export interface MultiContext {
  kind: "multi";
  [contextKind: string]: ContextAttributes | "multi";
}

export type EvaluationContext = SingleContext | MultiContext;

/**
 * `kind -> attributes`, after normalisation.
 *
 * An interface rather than `ReadonlyMap` so the single-context case — which is
 * most of them — can be served without allocating a Map. `Map` satisfies it
 * structurally, so the multi-context path still just uses one.
 */
export interface NormalizedContext {
  get(contextKind: string): ContextAttributes | undefined;
}

/* ────────────────────────── Results ─────────────────────────── */

export type EvaluationErrorKind =
  | "MALFORMED_FLAG"
  | "MALFORMED_CONTEXT"
  | "VARIATION_OUT_OF_RANGE"
  | "WRONG_TYPE"
  | "PREREQUISITE_CYCLE"
  | "PREREQUISITE_DEPTH_EXCEEDED";

export type EvaluationReason =
  | { kind: "OFF" }
  | { kind: "FLAG_NOT_FOUND" }
  | { kind: "PREREQUISITE_FAILED"; prerequisiteKey: string }
  | { kind: "TARGET_MATCH" }
  | { kind: "RULE_MATCH"; ruleIndex: number; ruleId: string }
  | { kind: "FALLTHROUGH" }
  | { kind: "ERROR"; error: EvaluationErrorKind };

/**
 * A rule that could not be fully evaluated because segment membership was
 * unverifiable. The rule failed closed and evaluation continued past
 * it, so this is an *annotation*, not the outcome: `reason` still reports what
 * was actually served. Without it, `POST /v1/debug/evaluate` could only say
 * "no match", which is the difference between a five-minute diagnosis and an
 * afternoon. It is also what `featurekit_sdk_segment_unresolved_total` counts.
 */
export interface UnresolvedRule {
  ruleIndex: number;
  ruleId: string;
  segmentKey: string;
  reason: "SEGMENT_UNRESOLVED";
}

export interface EvaluationDetail<T> {
  value: T;
  /** `null` when the caller's default was served. */
  variationIndex: number | null;
  reason: EvaluationReason;
  /** Present only when at least one rule failed closed. Absent on the hot path. */
  unresolved?: UnresolvedRule[];
}

/* ───────────────────────── Targeting ───────────────────── */

export type Operator =
  | "in"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "matches"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "before"
  | "after"
  | "semVerEqual"
  | "semVerLessThan"
  | "semVerGreaterThan"
  | "segmentMatch";

export interface CompiledClause {
  contextKind: string;
  /** Dot-separated for nested attributes: `"address.country"`. `"key"` is the key. */
  attribute: string;
  op: Operator;
  values: readonly unknown[];
  negate: boolean;
}

export interface RolloutVariation {
  variationIndex: number;
  /** Integer out of `WEIGHT_SCALE` (100,000). Weights sum to 100,000. */
  weight: number;
}

export interface Rollout {
  /** Which context kind is bucketed. Default `"user"`. */
  contextKind?: string;
  /** Attribute to bucket on instead of the key. Default `"key"`. */
  bucketBy?: string;
  /** Frozen seed, replacing the flag key in the hash prefix. */
  seed?: number;
  variations: readonly RolloutVariation[];
}

export interface CompiledRule {
  id: string;
  /** ANDed. A rule matches only if every clause matches. */
  clauses: readonly CompiledClause[];
  /** Exactly one of these is set — enforced by `rule_outcome_xor` in Postgres. */
  variation?: number;
  rollout?: Rollout;
}

export interface CompiledTarget {
  contextKind: string;
  variation: number;
  keys: readonly string[];
}

export interface CompiledPrerequisite {
  key: string;
  variation: number;
}

export type FlagKind = "boolean" | "string" | "number" | "json";

export interface CompiledFlag {
  key: string;
  /** Per-flag, per-environment. Patches at or below the held version are dropped. */
  version: number;
  kind: FlagKind;
  on: boolean;
  /** Positional; rules reference variations by index, never by id. */
  variations: readonly unknown[];
  offVariation: number | null;
  fallthrough: { variation: number } | { rollout: Rollout };
  prerequisites: readonly CompiledPrerequisite[];
  targets: readonly CompiledTarget[];
  rules: readonly CompiledRule[];
  /**
   * Every attribute this flag's rules read, emitted by the compiler,
   * kind-qualified as `"user.country"`. Client-tier fan-out collapses 50,000
   * connections to the few hundred distinct value combinations of this set
   *. Unused by the server tier.
   */
  referencedAttributes?: readonly string[];
  /**
   * True when this flag's value depends on the context *key* and not only on
   * its attributes — a percentage rollout, an individual target, or a segment
   * clause. Such a flag cannot share a fan-out fingerprint and is specialised
   * per connection. Emitted by the compiler alongside
   * `referencedAttributes`; it would be a painful retrofit later.
   */
  perContext?: boolean;
  /**
   * Whether the client tier may see this flag at all. Defaults false, so
   * an unreleased feature's *existence* stays private, not just its value.
   */
  clientAvailable?: boolean;
}

/* ───────────────────────── Segments ───────────────────── */

export interface CompiledSegmentBase {
  version: number;
  /**
   * Pinned-out members. **Excluded wins over included**, in every encoding —
   * which is why it lives on the base rather than only on the inline
   * variant. An exclusion list that only worked for small
   * segments would fail exactly where it matters.
   */
  excluded?: readonly string[];
  /**
   * Rule-based membership (`segment_rules`). ORed with the membership
   * structure: a context is a member if it is listed OR any rule matches.
   */
  rules?: readonly CompiledSegmentRule[];
}

/** A segment rule. Clauses are ANDed, exactly as in a targeting rule. */
export interface CompiledSegmentRule {
  id: string;
  clauses: readonly CompiledClause[];
  /** Match only this share of everyone the clauses select. Out of WEIGHT_SCALE. */
  weight?: number;
  bucketBy?: string;
  contextKind?: string;
}

export type CompiledSegment = CompiledSegmentBase &
  (
    | { kind: "inline"; members: readonly string[] }
    /** Exact, and only when every member key is integral — the ordinal IS the key. */
    | { kind: "roaring"; bitmap: Uint8Array; contextKind: string }
    /** Probabilistic but deletable. Positives are confirmed against the resolved set. */
    | { kind: "cuckoo"; filter: Uint8Array; fpRate: number; loadFactor: number }
  );

/* ───────────────────────────── Snapshot ─────────────────────────────── */

export interface Snapshot {
  /** Monotonic per environment. */
  version: number;
  environmentKey: string;
  /** Server tier only — the client tier never buckets. */
  salt: string;
  flags: Readonly<Record<string, CompiledFlag>>;
  segments: Readonly<Record<string, CompiledSegment>>;
}
