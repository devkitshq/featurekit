/**
 * The evaluator (§9.1, §9.2).
 *
 * A pure, synchronous, dependency-free function with exactly one
 * implementation. It runs in-process for server SDKs and server-side on behalf
 * of client SDKs, so the same code compiles into a browser bundle, an edge
 * runtime, and eventually a port to another language.
 *
 * **Nothing on this path awaits.** A promise per call adds a microtask tick to
 * a 14 ns operation, poisons every call site, and cannot be used in a React
 * render. Readiness is a separate, explicit concern (`ready()`).
 *
 * **The evaluator never throws.** A flag library that can throw into your
 * request path is worse than no flag library. Every failure — malformed rule,
 * out-of-range variation index, unusable context — returns the caller's
 * default with `reason: ERROR`.
 *
 * @see docs/evaluation/evaluator.md
 */

import { WEIGHT_SCALE, bucket, resolveRollout } from "./bucketing.js";
import { bucketValue, getAttribute, normalizeContext } from "./context.js";
import { applyOperator } from "./operators.js";
import type { SegmentIndex } from "./segments.js";
import type {
  CompiledClause,
  CompiledFlag,
  CompiledRule,
  CompiledSegmentRule,
  EvaluationContext,
  EvaluationDetail,
  EvaluationErrorKind,
  EvaluationReason,
  FlagKind,
  NormalizedContext,
  Snapshot,
  UnresolvedRule,
} from "./types.js";

/** The compiler rejects cycles; these are defence against a corrupt snapshot. */
const DEFAULT_MAX_PREREQUISITE_DEPTH = 20;
const DEFAULT_MAX_SEGMENT_DEPTH = 10;

/**
 * Most `unresolved` entries one evaluation will report.
 *
 * The list exists so a caller can see *why* a rule was skipped, which is a
 * diagnostic. It is also one allocation per unresolved rule, on the hot path,
 * for a flag whose rule count a customer chooses: 5,000 segment rules against a
 * cold segment index allocates 5,000 objects per evaluation, per request, and
 * the diagnostic value of entries 21 through 5,000 is nil. Past the cap the
 * evaluation proceeds identically and only the reporting stops.
 */
const MAX_UNRESOLVED_REPORTED = 20;

export interface EvaluateOptions {
  /** Resident segment state. Absent means every segment clause is unresolved. */
  segments?: SegmentIndex;
  maxPrerequisiteDepth?: number;
  maxSegmentDepth?: number;
}

/**
 * A clause result is three-valued, and `unresolved` is **not** a boolean.
 *
 * A boolean is something `negate` can invert, and inverting an unverified miss
 * grants the gated feature to everyone unconfirmed. Collapsing this back into
 * a boolean is precisely the bug a well-meaning refactor reintroduces (§22.3).
 */
type ClauseResult =
  | { matched: true }
  | { matched: false }
  | { unresolved: true; segmentKey: string };

interface RuleOutcome {
  matches: boolean;
  /** Set when the rule was skipped because membership was unverifiable. */
  unresolvedSegmentKey?: string;
}

/** Per-evaluation scratch, so the hot path allocates at most one object. */
interface EvalState {
  context: NormalizedContext;
  snapshot: Snapshot;
  segments: SegmentIndex | undefined;
  maxSegmentDepth: number;
  maxPrerequisiteDepth: number;
  /** Allocated lazily — an evaluation with nothing unresolved allocates none. */
  unresolved: UnresolvedRule[] | null;
}

/**
 * The reasons carrying no payload are constants, frozen and shared.
 * Allocating a fresh `{ kind: "OFF" }` per call is a measurable share of a
 * sub-100ns budget, and freezing means a caller cannot corrupt the shared one.
 */
const REASON_OFF = Object.freeze({ kind: "OFF" }) as EvaluationReason;
const REASON_FLAG_NOT_FOUND = Object.freeze({ kind: "FLAG_NOT_FOUND" }) as EvaluationReason;
const REASON_TARGET_MATCH = Object.freeze({ kind: "TARGET_MATCH" }) as EvaluationReason;
const REASON_FALLTHROUGH = Object.freeze({ kind: "FALLTHROUGH" }) as EvaluationReason;

const hasOwnProperty = Object.prototype.hasOwnProperty;

/** A flag from the snapshot, never one inherited from `Object.prototype`. */
function hasOwnFlag(snapshot: Snapshot | undefined, flagKey: string): CompiledFlag | undefined {
  const flags = snapshot?.flags;
  if (flags === undefined || flags === null) return undefined;
  return hasOwnProperty.call(flags, flagKey) ? flags[flagKey] : undefined;
}

function err<T>(error: EvaluationErrorKind, defaultValue: T): EvaluationDetail<T> {
  return { value: defaultValue, variationIndex: null, reason: { kind: "ERROR", error } };
}

/** Does a variation's value match the flag's declared kind? */
function matchesKind(value: unknown, kind: FlagKind): boolean {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "json":
      // Any JSON value is legitimate for a json flag, including null.
      return true;
    default:
      return false;
  }
}

/**
 * Resolve a variation index to a served value.
 *
 * A boolean flag must never hand a string to `if (fk.get(k, ctx, false))`, so the
 * declared kind is checked here rather than trusted from the snapshot.
 */
function serve<T>(
  flag: CompiledFlag,
  index: number,
  reason: EvaluationReason,
  defaultValue: T,
  state: EvalState,
): EvaluationDetail<T> {
  if (!Array.isArray(flag.variations) || index < 0 || index >= flag.variations.length) {
    return withUnresolved(err("VARIATION_OUT_OF_RANGE", defaultValue), state);
  }
  const value = flag.variations[index];
  if (!matchesKind(value, flag.kind)) {
    return withUnresolved(err("WRONG_TYPE", defaultValue), state);
  }
  return withUnresolved({ value: value as T, variationIndex: index, reason }, state);
}

function withUnresolved<T>(detail: EvaluationDetail<T>, state: EvalState): EvaluationDetail<T> {
  if (state.unresolved !== null) detail.unresolved = state.unresolved;
  return detail;
}

/* ─────────────────────────────── clauses ────────────────────────────── */

function evaluateClause(clause: CompiledClause, state: EvalState, depth: number): ClauseResult {
  if (clause.op === "segmentMatch") {
    return evaluateSegmentClause(clause, state, depth);
  }
  const attr = getAttribute(state.context, clause.contextKind ?? "user", clause.attribute);
  const values = Array.isArray(clause.values) ? clause.values : [];
  const matched = applyOperator(clause.op, attr, values);
  // `negate` applies only here, to a resolved boolean.
  return { matched: clause.negate ? !matched : matched };
}

function evaluateSegmentClause(
  clause: CompiledClause,
  state: EvalState,
  depth: number,
): ClauseResult {
  const contextKind = clause.contextKind ?? "user";
  const attrs = state.context.get(contextKind);
  // A clause naming an absent context kind does not match, and that is a
  // resolved answer — nothing about membership is in doubt.
  if (attrs === undefined) return { matched: clause.negate };

  const values = Array.isArray(clause.values) ? clause.values : [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const result = segmentMembership(value, attrs.key, state, depth);
    if (result === "unresolved") {
      // Propagate the third state. Do NOT produce a boolean here.
      return { unresolved: true, segmentKey: value };
    }
    if (result === "member") return { matched: !clause.negate };
  }
  return { matched: clause.negate };
}

/**
 * Is this context in this segment? Membership structure first, then the
 * segment's own rules (§7.6) — a context is a member if it is listed OR any
 * segment rule matches it.
 */
function segmentMembership(
  segmentKey: string,
  contextKey: string,
  state: EvalState,
  depth: number,
): "member" | "not-member" | "unresolved" {
  if (state.segments === undefined) {
    // Evaluating with no segment state is a legitimate cold start. It must not
    // throw, and it must not grant the feature under negation.
    return "unresolved";
  }
  if (depth >= state.maxSegmentDepth) return "not-member";

  const direct = state.segments.membership(segmentKey, contextKey);
  if (direct !== "not-member") return direct;

  const compiled = state.segments.get(segmentKey);
  if (compiled?.rules === undefined) return "not-member";
  for (const segmentRule of compiled.rules) {
    const outcome = evaluateSegmentRule(segmentRule, segmentKey, state, depth + 1);
    if (outcome === "unresolved") return "unresolved";
    if (outcome === "member") return "member";
  }
  return "not-member";
}

function evaluateSegmentRule(
  segmentRule: CompiledSegmentRule,
  segmentKey: string,
  state: EvalState,
  depth: number,
): "member" | "not-member" | "unresolved" {
  for (const clause of segmentRule.clauses ?? []) {
    const r = evaluateClause(clause, state, depth);
    if ("unresolved" in r) return "unresolved";
    if (!r.matched) return "not-member";
  }
  if (segmentRule.weight === undefined) return "member";

  // A weighted segment rule matches only this share of everyone its clauses
  // select. Bucketed on the segment key, so it is independent of any flag.
  const value = bucketValue(
    state.context,
    segmentRule.contextKind ?? "user",
    segmentRule.bucketBy ?? "key",
  );
  if (value === null) return "not-member";
  const b = bucket(value, segmentKey, state.snapshot.salt);
  return b < Math.min(segmentRule.weight, WEIGHT_SCALE) ? "member" : "not-member";
}

/**
 * A rule matches only if **every** clause matches. An unresolved clause fails
 * the whole rule closed — in either polarity — and evaluation falls through to
 * the next rule, which is the same place a genuinely non-matching context
 * lands.
 */
function evaluateRule(rule: CompiledRule, state: EvalState): RuleOutcome {
  for (const clause of rule.clauses ?? []) {
    const r = evaluateClause(clause, state, 0);
    if ("unresolved" in r) return { matches: false, unresolvedSegmentKey: r.segmentKey };
    if (!r.matched) return { matches: false };
  }
  return { matches: true };
}

/* ────────────────────────────── the flag ────────────────────────────── */

/**
 * Evaluate one flag's precedence chain, given an already-normalised context.
 * Returns `null` when a prerequisite chain exceeded its depth cap.
 */
function evaluateFlag<T>(
  flag: CompiledFlag,
  defaultValue: T,
  state: EvalState,
  depth: number,
): EvaluationDetail<T> {
  if (depth > state.maxPrerequisiteDepth) {
    return err("PREREQUISITE_DEPTH_EXCEEDED", defaultValue);
  }

  const off = (reason: EvaluationReason): EvaluationDetail<T> =>
    flag.offVariation === null || flag.offVariation === undefined
      ? withUnresolved({ value: defaultValue, variationIndex: null, reason }, state)
      : serve(flag, flag.offVariation, reason, defaultValue, state);

  // 2. Flag off.
  if (flag.on !== true) return off(REASON_OFF);

  // 3. Prerequisites.
  for (const prerequisite of flag.prerequisites ?? []) {
    const failed = { kind: "PREREQUISITE_FAILED", prerequisiteKey: prerequisite.key } as const;
    const prereqFlag = hasOwnFlag(state.snapshot, prerequisite.key);
    if (prereqFlag === undefined) return off(failed);
    // An off prerequisite is unmet by definition, whatever its off variation
    // happens to be: "off" is not "serving variation 1".
    if (prereqFlag.on !== true) return off(failed);

    const prereqDetail = evaluateFlag(prereqFlag, null as unknown, state, depth + 1);
    if (prereqDetail.reason.kind === "ERROR") {
      return withUnresolved(err(prereqDetail.reason.error, defaultValue), state);
    }
    if (prereqDetail.variationIndex !== prerequisite.variation) return off(failed);
  }

  // 4. Individual targets.
  for (const target of flag.targets ?? []) {
    const attrs = state.context.get(target.contextKind ?? "user");
    if (attrs === undefined) continue;
    if (target.keys?.includes(attrs.key) === true) {
      return serve(flag, target.variation, REASON_TARGET_MATCH, defaultValue, state);
    }
  }

  // 5. First matching rule.
  const rules = flag.rules ?? [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const outcome = evaluateRule(rule, state);
    if (outcome.unresolvedSegmentKey !== undefined) {
      state.unresolved ??= [];
      // Bounded: the diagnostic is worth one allocation per rule only up to the
      // point a human would read it. Skipping the rule is unaffected.
      if (state.unresolved.length < MAX_UNRESOLVED_REPORTED) {
        state.unresolved.push({
          ruleIndex: i,
          ruleId: rule.id,
          segmentKey: outcome.unresolvedSegmentKey,
          reason: "SEGMENT_UNRESOLVED",
        });
      }
      continue;
    }
    if (!outcome.matches) continue;

    const reason = { kind: "RULE_MATCH", ruleIndex: i, ruleId: rule.id } as const;
    if (rule.rollout !== undefined) {
      const index = resolveRollout(rule.rollout, state.context, flag.key, state.snapshot.salt);
      // Excluded from the rollout: the rule does not match, and evaluation
      // continues rather than silently assigning variation 0.
      if (index === null) continue;
      return serve(flag, index, reason, defaultValue, state);
    }
    if (rule.variation === undefined) continue; // malformed: no outcome
    return serve(flag, rule.variation, reason, defaultValue, state);
  }

  // 6. Fallthrough.
  const fallthrough = flag.fallthrough;
  if (fallthrough === undefined || fallthrough === null) {
    return withUnresolved(err("MALFORMED_FLAG", defaultValue), state);
  }
  if ("rollout" in fallthrough) {
    const index = resolveRollout(fallthrough.rollout, state.context, flag.key, state.snapshot.salt);
    if (index === null) {
      // The flag is on, the context cannot be placed, and there is no defined
      // answer. The caller's default is the honest backstop — and ERROR is
      // what makes `featurekit_sdk_default_served_total` rise so someone sees it.
      return withUnresolved(err("MALFORMED_CONTEXT", defaultValue), state);
    }
    return serve(flag, index, REASON_FALLTHROUGH, defaultValue, state);
  }
  return serve(flag, fallthrough.variation, REASON_FALLTHROUGH, defaultValue, state);
}

/**
 * Evaluate a flag for a context.
 *
 * Precedence is fixed and never configurable — configurable precedence makes
 * flags impossible to reason about:
 *
 * ```
 * 1. Flag not in snapshot  -> caller's default,  FLAG_NOT_FOUND
 * 2. Flag off              -> offVariation,      OFF
 * 3. Prerequisite unmet    -> offVariation,      PREREQUISITE_FAILED
 * 4. Individual target     -> target variation,  TARGET_MATCH
 * 5. First matching rule   -> variation/rollout, RULE_MATCH
 * 6. Fallthrough           -> variation/rollout, FALLTHROUGH
 * ```
 *
 * The default value is required, not optional: an optional default produces
 * `undefined` in production during an outage, and `if (undefined)` is a silent
 * wrong answer nobody notices for a week.
 */
export function evaluate<T>(
  flagKey: string,
  context: EvaluationContext,
  snapshot: Snapshot,
  defaultValue: T,
  options: EvaluateOptions = {},
): EvaluationDetail<T> {
  try {
    // 1. Flag not in snapshot.
    //
    // `hasOwn`, not a plain lookup: `flags` is a plain object decoded from
    // JSON, so `flags["constructor"]` finds `Object.prototype.constructor` and
    // `flags["__proto__"]` finds the prototype itself. Both are truthy, so a
    // *missing* flag whose key happens to collide with one reports `OFF`
    // instead of `FLAG_NOT_FOUND` — a typo that looks like a deliberately
    // disabled flag, and one that never raises the not-found signal an
    // operator watches. `getAttribute` guards the same hazard on the context;
    // this is the other half.
    const flag = hasOwnFlag(snapshot, flagKey);
    if (flag === undefined) {
      return { value: defaultValue, variationIndex: null, reason: REASON_FLAG_NOT_FOUND };
    }

    const normalized = normalizeContext(context);
    if (normalized === null) return err("MALFORMED_CONTEXT", defaultValue);

    const state: EvalState = {
      context: normalized,
      snapshot,
      segments: options.segments,
      maxSegmentDepth: options.maxSegmentDepth ?? DEFAULT_MAX_SEGMENT_DEPTH,
      maxPrerequisiteDepth: options.maxPrerequisiteDepth ?? DEFAULT_MAX_PREREQUISITE_DEPTH,
      unresolved: null,
    };
    return evaluateFlag(flag, defaultValue, state, 0);
  } catch {
    // The belt to the braces above. Anything that reaches here is a bug in this
    // file, and a bug in this file must still not throw into a request path.
    return err("MALFORMED_FLAG", defaultValue);
  }
}
