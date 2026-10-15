/**
 * The snapshot compiler.
 *
 * Compiles Postgres rows into the immutable snapshot every server SDK holds.
 * It does the work the SDK shouldn't: resolves variation uuids to positional
 * indices, inlines small segments and builds deletable membership filters for
 * large ones, topologically orders prerequisites, **rejects cycles**, drops
 * archived flags, and emits the referenced-attribute set of every flag.
 *
 * **This module is pure.** It takes plain rows and returns a `Snapshot`; it
 * opens no connections and reads no configuration. That is what makes the
 * hardest part of M2 unit-testable without a container, and it is why the
 * repositories are a separate layer.
 *
 * Errors are thrown, never swallowed. A compile that cannot be done correctly
 * must not publish a snapshot — the evaluator's job is to survive a *stale*
 * snapshot, not a wrong one.
 *
 * @see docs/storage/compiler.md
 */

import {
  buildCuckooFilter,
  FINGERPRINT_BITS,
  ordinalOf,
  SLOTS_PER_BUCKET,
  RoaringBitmap,
  type CompiledClause,
  type CompiledFlag,
  type CompiledPrerequisite,
  type CompiledRule,
  type CompiledSegment,
  type CompiledSegmentRule,
  type CompiledTarget,
  type FlagKind,
  type Operator,
  type Rollout,
  type Snapshot,
} from "../sdk/index.js";

/* ────────────────────────────── input rows ─────────────────────────── */

export interface EnvironmentRow {
  id: string;
  key: string;
  bucketSalt: string;
}

export interface FlagRow {
  id: string;
  key: string;
  kind: FlagKind;
  archivedAt: Date | null;
  clientAvailable: boolean;
}

export interface VariationRow {
  id: string;
  flagId: string;
  idx: number;
  value: unknown;
}

export interface FlagEnvironmentRow {
  id: string;
  flagId: string;
  environmentId: string;
  enabled: boolean;
  offVariationId: string | null;
  fallthroughVariationId: string | null;
  fallthroughRollout: Rollout | null;
  version: number;
}

export interface TargetRow {
  flagEnvironmentId: string;
  variationId: string;
  contextKind: string;
  contextKey: string;
}

export interface RuleRow {
  id: string;
  flagEnvironmentId: string;
  idx: number;
  variationId: string | null;
  rollout: Rollout | null;
}

export interface ClauseRow {
  ruleId: string;
  idx: number;
  contextKind: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
}

export interface PrerequisiteRow {
  flagEnvironmentId: string;
  prerequisiteFlagId: string;
  requiredVariationId: string;
}

export interface SegmentRow {
  id: string;
  key: string;
  environmentId: string;
  version: number;
}

export interface SegmentMemberRow {
  segmentId: string;
  contextKind: string;
  contextKey: string;
  excluded: boolean;
}

export interface SegmentRuleRow {
  id: string;
  segmentId: string;
  idx: number;
  weight: number | null;
  bucketBy: string | null;
  contextKind: string;
}

export interface SegmentRuleClauseRow {
  segmentRuleId: string;
  idx: number;
  contextKind: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
}

export interface CompilerInput {
  environment: EnvironmentRow;
  flags: FlagRow[];
  variations: VariationRow[];
  flagEnvironments: FlagEnvironmentRow[];
  targets: TargetRow[];
  rules: RuleRow[];
  clauses: ClauseRow[];
  prerequisites: PrerequisiteRow[];
  segments: SegmentRow[];
  segmentMembers: SegmentMemberRow[];
  segmentRules: SegmentRuleRow[];
  segmentRuleClauses: SegmentRuleClauseRow[];
}

export interface CompileOptions {
  /** Monotonic per environment. The caller owns allocation. */
  version: number;
  /** Above this member count a segment gets a membership filter. */
  segmentInlineMax?: number;
  /**
   * `"auto"` prefers roaring when every member key is integral. The other two
   * force an encoding, for tests.
   */
  segmentFilter?: "auto" | "roaring" | "cuckoo";
}

export type CompileErrorCode =
  | "PREREQUISITE_CYCLE"
  | "UNKNOWN_VARIATION"
  | "MISSING_FALLTHROUGH"
  | "ROARING_NON_INTEGRAL";

export class CompileError extends Error {
  constructor(
    readonly code: CompileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompileError";
  }
}

/* ─────────────────────────────── helpers ───────────────────────────── */

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket === undefined) out.set(k, [row]);
    else bucket.push(row);
  }
  return out;
}

const byIdx = <T extends { idx: number }>(a: T, b: T) => a.idx - b.idx;

function compileClause(row: ClauseRow | SegmentRuleClauseRow): CompiledClause {
  return {
    contextKind: row.contextKind,
    attribute: row.attribute,
    op: row.op as Operator,
    values: row.values,
    negate: row.negate,
  };
}

/* ──────────────────────────── the compiler ─────────────────────────── */

export function compileSnapshot(input: CompilerInput, options: CompileOptions): Snapshot {
  const { environment } = input;

  // Variation id -> positional index, scoped per flag so a variation cannot be
  // borrowed across flags.
  const variationIndex = new Map<string, { flagId: string; idx: number }>();
  for (const v of input.variations) variationIndex.set(v.id, { flagId: v.flagId, idx: v.idx });

  const variationsByFlag = groupBy(input.variations, (v) => v.flagId);
  const flagById = new Map(input.flags.map((f) => [f.id, f]));
  const liveFlags = input.flags.filter((f) => f.archivedAt === null);
  const liveFlagIds = new Set(liveFlags.map((f) => f.id));

  const configByFlagId = new Map<string, FlagEnvironmentRow>();
  for (const fe of input.flagEnvironments) {
    if (fe.environmentId === environment.id) configByFlagId.set(fe.flagId, fe);
  }

  const targetsByFe = groupBy(input.targets, (t) => t.flagEnvironmentId);
  const rulesByFe = groupBy(input.rules, (r) => r.flagEnvironmentId);
  const clausesByRule = groupBy(input.clauses, (c) => c.ruleId);
  const prereqsByFe = groupBy(input.prerequisites, (p) => p.flagEnvironmentId);

  /** Resolve a variation id to its index, asserting it belongs to this flag. */
  function indexOf(variationId: string, flagId: string, where: string): number {
    const found = variationIndex.get(variationId);
    if (found === undefined || found.flagId !== flagId) {
      throw new CompileError(
        "UNKNOWN_VARIATION",
        `${where}: variation ${variationId} does not belong to flag ${flagId}`,
      );
    }
    return found.idx;
  }

  const compiled = new Map<string, CompiledFlag>();

  for (const flag of liveFlags) {
    const config = configByFlagId.get(flag.id);
    // A flag exists once at the project level; its configuration exists once
    // per environment. With no config row there is nothing to serve, and
    // inventing one would be the compiler guessing.
    if (config === undefined) continue;

    const variations = (variationsByFlag.get(flag.id) ?? []).slice().sort(byIdx).map((v) => v.value);

    const targets: CompiledTarget[] = [];
    const grouped = groupBy(
      targetsByFe.get(config.id) ?? [],
      (t) => `${t.contextKind}\0${t.variationId}`,
    );
    for (const rows of grouped.values()) {
      const first = rows[0]!;
      targets.push({
        contextKind: first.contextKind,
        variation: indexOf(first.variationId, flag.id, `flag ${flag.key} target`),
        keys: rows.map((r) => r.contextKey).sort(),
      });
    }
    // Deterministic order, so an unchanged flag compiles to identical bytes.
    targets.sort((a, b) => a.contextKind.localeCompare(b.contextKind) || a.variation - b.variation);

    const rules: CompiledRule[] = (rulesByFe.get(config.id) ?? [])
      .slice()
      .sort(byIdx)
      .map((r) => {
        const clauses = (clausesByRule.get(r.id) ?? []).slice().sort(byIdx).map(compileClause);
        const rule: CompiledRule = { id: r.id, clauses };
        if (r.rollout !== null) rule.rollout = r.rollout;
        else if (r.variationId !== null) {
          rule.variation = indexOf(r.variationId, flag.id, `flag ${flag.key} rule ${r.idx}`);
        }
        return rule;
      });

    const prerequisites: CompiledPrerequisite[] = [];
    for (const p of prereqsByFe.get(config.id) ?? []) {
      // A prerequisite pointing at an archived flag is dropped rather than left
      // dangling: a dangling key would make the evaluator report
      // PREREQUISITE_FAILED forever, silently disabling the dependent flag.
      if (!liveFlagIds.has(p.prerequisiteFlagId)) continue;
      const prereqFlag = flagById.get(p.prerequisiteFlagId);
      if (prereqFlag === undefined) continue;
      prerequisites.push({
        key: prereqFlag.key,
        variation: indexOf(
          p.requiredVariationId,
          p.prerequisiteFlagId,
          `flag ${flag.key} prerequisite ${prereqFlag.key}`,
        ),
      });
    }

    let fallthrough: CompiledFlag["fallthrough"];
    if (config.fallthroughRollout !== null) {
      fallthrough = { rollout: config.fallthroughRollout };
    } else if (config.fallthroughVariationId !== null) {
      fallthrough = {
        variation: indexOf(config.fallthroughVariationId, flag.id, `flag ${flag.key} fallthrough`),
      };
    } else {
      // The `fallthrough_xor` check constraint makes this unreachable from a
      // healthy database. Refusing to compile beats publishing a flag whose
      // fallthrough is undefined.
      throw new CompileError(
        "MISSING_FALLTHROUGH",
        `flag ${flag.key} has neither a fallthrough variation nor a rollout`,
      );
    }

    compiled.set(flag.key, {
      key: flag.key,
      version: config.version,
      kind: flag.kind,
      on: config.enabled,
      variations,
      offVariation:
        config.offVariationId === null
          ? null
          : indexOf(config.offVariationId, flag.id, `flag ${flag.key} offVariation`),
      fallthrough,
      prerequisites,
      targets,
      rules,
      referencedAttributes: referencedAttributes(rules, fallthrough),
      // A prerequisite is evaluated against the full context, and its inputs
      // are not in this flag's fingerprint, so a gated flag cannot share one.
      perContext: prerequisites.length > 0 || isPerContext(rules, targets, fallthrough),
      clientAvailable: flag.clientAvailable,
    });
  }

  return {
    version: options.version,
    environmentKey: environment.key,
    salt: environment.bucketSalt,
    flags: topologicallyOrder(compiled),
    segments: compileSegments(input, options),
  };
}

/* ─────────────────── referenced attributes ─────────────────── */

/**
 * Every attribute this flag's rules read, kind-qualified and sorted.
 *
 * This is what lets the client tier collapse 50,000 connections down to the few
 * hundred distinct attribute combinations that actually exist. The
 * *cache* is M5 work and small; emitting the set is the part that cannot be
 * retrofitted into a shipped evaluator, which is why it is here.
 */
function referencedAttributes(
  rules: readonly CompiledRule[],
  fallthrough: CompiledFlag["fallthrough"],
): string[] {
  const out = new Set<string>();
  const addRollout = (rollout: Rollout) => {
    const kind = rollout.contextKind ?? "user";
    out.add(`${kind}.${rollout.bucketBy ?? "key"}`);
  };

  for (const rule of rules) {
    for (const clause of rule.clauses) {
      out.add(`${clause.contextKind ?? "user"}.${clause.attribute}`);
    }
    if (rule.rollout !== undefined) addRollout(rule.rollout);
  }
  if ("rollout" in fallthrough) addRollout(fallthrough.rollout);

  return [...out].sort();
}

/**
 * True when the flag's value depends on the context *key*, not only on its
 * attributes — so it cannot share a fan-out fingerprint and must be
 * specialised per connection.
 *
 * Sources: a rollout buckets on the key; an individual target is a key
 * lookup; a segment clause resolves membership by key; a clause on the `key`
 * attribute reads it directly (the fan-out fingerprint deliberately omits it).
 * A dotted context kind is also treated as per-context, because the fingerprint
 * encodes kind and attribute as one dot-joined path and cannot recover it.
 */
function isPerContext(
  rules: readonly CompiledRule[],
  targets: readonly CompiledTarget[],
  fallthrough: CompiledFlag["fallthrough"],
): boolean {
  if (targets.length > 0) return true;
  if ("rollout" in fallthrough) return true;
  for (const rule of rules) {
    if (rule.rollout !== undefined) return true;
    for (const clause of rule.clauses) {
      if (clause.op === "segmentMatch") return true;
      if (clause.attribute === "key") return true;
      if ((clause.contextKind ?? "user").includes(".")) return true;
    }
  }
  return false;
}

/* ────────────────── prerequisite ordering and cycles ───────────────── */

/**
 * Order flags so every prerequisite precedes its dependent, and **reject
 * cycles**.
 *
 * The compiler is the mechanism here — the evaluator's depth cap is only
 * defence against a corrupt snapshot. A snapshot that requires cycle detection
 * at evaluation time must never be published.
 */
function topologicallyOrder(flags: Map<string, CompiledFlag>): Record<string, CompiledFlag> {
  const out: Record<string, CompiledFlag> = {};
  const state = new Map<string, "visiting" | "done">();

  const visit = (key: string, path: string[]): void => {
    const status = state.get(key);
    if (status === "done") return;
    if (status === "visiting") {
      throw new CompileError(
        "PREREQUISITE_CYCLE",
        `prerequisite cycle: ${[...path, key].join(" -> ")}`,
      );
    }
    const flag = flags.get(key);
    if (flag === undefined) return; // archived or unconfigured; already dropped

    state.set(key, "visiting");
    for (const prerequisite of flag.prerequisites) visit(prerequisite.key, [...path, key]);
    state.set(key, "done");
    out[key] = flag;
  };

  for (const key of flags.keys()) visit(key, []);
  return out;
}

/* ───────────────────────── segment compilation ─────────────────────── */

function compileSegments(
  input: CompilerInput,
  options: CompileOptions,
): Record<string, CompiledSegment> {
  const inlineMax = options.segmentInlineMax ?? 50_000;
  const filterChoice = options.segmentFilter ?? "auto";

  const membersBySegment = groupBy(input.segmentMembers, (m) => m.segmentId);
  const rulesBySegment = groupBy(input.segmentRules, (r) => r.segmentId);
  const clausesByRule = groupBy(input.segmentRuleClauses, (c) => c.segmentRuleId);

  const out: Record<string, CompiledSegment> = {};

  for (const segment of input.segments) {
    if (segment.environmentId !== input.environment.id) continue;

    const rows = membersBySegment.get(segment.id) ?? [];
    const included: string[] = [];
    const excluded: string[] = [];
    for (const row of rows) (row.excluded ? excluded : included).push(row.contextKey);
    included.sort();
    excluded.sort();

    const rules: CompiledSegmentRule[] = (rulesBySegment.get(segment.id) ?? [])
      .slice()
      .sort(byIdx)
      .map((r) => {
        const rule: CompiledSegmentRule = {
          id: r.id,
          clauses: (clausesByRule.get(r.id) ?? []).slice().sort(byIdx).map(compileClause),
          contextKind: r.contextKind,
        };
        if (r.weight !== null) rule.weight = r.weight;
        if (r.bucketBy !== null) rule.bucketBy = r.bucketBy;
        return rule;
      });

    const base = { version: segment.version, excluded, rules };

    // Roaring is eligible only when the ordinal IS the key — no side table, no
    // dictionary. `ordinalOf` is the SDK's own test, imported rather than
    // re-implemented, so the two cannot drift.
    const allIntegral = included.length > 0 && included.every((key) => ordinalOf(key) !== null);

    if (filterChoice === "roaring" && !allIntegral) {
      // A wrong answer is not an acceptable response to a misconfiguration.
      const offender = included.find((key) => ordinalOf(key) === null);
      throw new CompileError(
        "ROARING_NON_INTEGRAL",
        `segment ${segment.key}: segmentFilter is roaring but member key ${JSON.stringify(offender)} is non-integral`,
      );
    }

    if (included.length <= inlineMax && filterChoice === "auto") {
      out[segment.key] = { ...base, kind: "inline", members: included };
      continue;
    }

    if (allIntegral && filterChoice !== "cuckoo") {
      const bitmap = RoaringBitmap.from(included.map((key) => ordinalOf(key)!));
      out[segment.key] = {
        ...base,
        kind: "roaring",
        bitmap: bitmap.serialize(),
        // Members of a segment share one context kind for bitmap purposes; the
        // first row's kind is the segment's kind by construction.
        contextKind: rows[0]?.contextKind ?? "user",
      };
      continue;
    }

    const built = buildCuckooFilter(included);
    out[segment.key] = {
      ...base,
      kind: "cuckoo",
      filter: built.filter.encode(),
      // Two candidate buckets of four slots, each a 1-in-2^32 fingerprint match.
      fpRate: (2 * SLOTS_PER_BUCKET) / 2 ** FINGERPRINT_BITS,
      loadFactor: built.filter.loadFactor,
    };
  }

  return out;
}

/**
 * The flag keys the client tier may see.
 *
 * This is the *entire* client-visible surface at compile time. There is no
 * second "client snapshot": the client tier receives evaluated values,
 * produced per-context by the evaluation service from this same snapshot.
 */
export function clientFlagKeys(snapshot: Snapshot): string[] {
  return Object.values(snapshot.flags)
    .filter((f) => f.clientAvailable === true)
    .map((f) => f.key)
    .sort();
}
