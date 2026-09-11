import { describe, expect, it } from "vitest";
import { buildCuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";
import { evaluate } from "../../src/sdk/evaluation/evaluate.js";
import { RoaringBitmap } from "../../src/sdk/evaluation/roaring.js";
import { InMemorySegmentCache, SegmentIndex } from "../../src/sdk/evaluation/segments.js";
import type {
  CompiledClause,
  CompiledFlag,
  CompiledRule,
  CompiledSegment,
  EvaluationContext,
  Snapshot,
} from "../../src/sdk/evaluation/types.js";

/* ─────────────────────────────── builders ───────────────────────────── */

const flag = (over: Partial<CompiledFlag> = {}): CompiledFlag => ({
  key: "f",
  version: 1,
  kind: "boolean",
  on: true,
  variations: [false, true],
  offVariation: 0,
  fallthrough: { variation: 0 },
  prerequisites: [],
  targets: [],
  rules: [],
  ...over,
});

const snapshot = (
  flags: Record<string, CompiledFlag>,
  segments: Record<string, CompiledSegment> = {},
): Snapshot => ({ version: 1, environmentKey: "production", salt: "s4lt", flags, segments });

const clause = (over: Partial<CompiledClause> = {}): CompiledClause => ({
  contextKind: "user",
  attribute: "country",
  op: "in",
  values: ["DE"],
  negate: false,
  ...over,
});

const rule = (over: Partial<CompiledRule> = {}): CompiledRule => ({
  id: "r0",
  clauses: [clause()],
  variation: 1,
  ...over,
});

const ctx: EvaluationContext = { key: "usr_1", country: "DE", plan: "pro" };
const evalIn = (snap: Snapshot, c: EvaluationContext = ctx, def: unknown = "DEFAULT", opts = {}) =>
  evaluate("f", c, snap, def, opts);

/* ───────────────────────────── precedence ───────────────────────────── */

describe("precedence step 1 - flag not in snapshot", () => {
  it("serves the caller's default with FLAG_NOT_FOUND", () => {
    const d = evaluate("absent", ctx, snapshot({}), "DEFAULT");
    expect(d).toEqual({ value: "DEFAULT", variationIndex: null, reason: { kind: "FLAG_NOT_FOUND" } });
  });
});

describe("precedence step 2 - flag off", () => {
  it("serves the off variation", () => {
    const d = evalIn(snapshot({ f: flag({ on: false, offVariation: 1 }) }));
    expect(d).toEqual({ value: true, variationIndex: 1, reason: { kind: "OFF" } });
  });

  it("serves the caller's default when there is no off variation", () => {
    const d = evalIn(snapshot({ f: flag({ on: false, offVariation: null }) }));
    expect(d).toEqual({ value: "DEFAULT", variationIndex: null, reason: { kind: "OFF" } });
  });

  it("beats a matching target and a matching rule", () => {
    const d = evalIn(
      snapshot({
        f: flag({
          on: false,
          targets: [{ contextKind: "user", variation: 1, keys: ["usr_1"] }],
          rules: [rule()],
        }),
      }),
    );
    expect(d.reason).toEqual({ kind: "OFF" });
  });
});

describe("precedence step 3 - prerequisites", () => {
  const withPrereq = (prereqOn: boolean, prereqVariation: number) =>
    snapshot({
      f: flag({ prerequisites: [{ key: "payments-v2", variation: 1 }], fallthrough: { variation: 1 } }),
      "payments-v2": flag({
        key: "payments-v2",
        on: prereqOn,
        offVariation: 0,
        fallthrough: { variation: prereqVariation },
      }),
    });

  it("passes when the prerequisite serves the required variation", () => {
    const d = evalIn(withPrereq(true, 1));
    expect(d.reason).toEqual({ kind: "FALLTHROUGH" });
    expect(d.value).toBe(true);
  });

  it("fails when the prerequisite serves a different variation", () => {
    const d = evalIn(withPrereq(true, 0));
    expect(d.reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisiteKey: "payments-v2" });
    expect(d.variationIndex).toBe(0); // the off variation
  });

  it("fails when the prerequisite flag is off, even if its off variation matches", () => {
    // An off prerequisite is unmet by definition: "off" is not "serving
    // variation 1 because someone targeted it".
    const d = evalIn(withPrereq(false, 1));
    expect(d.reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisiteKey: "payments-v2" });
  });

  it("fails when the prerequisite is missing from the snapshot", () => {
    const d = evalIn(snapshot({ f: flag({ prerequisites: [{ key: "gone", variation: 1 }] }) }));
    expect(d.reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisiteKey: "gone" });
  });

  it("reports the FIRST unmet prerequisite, which is what the agent reads back", () => {
    const snap = snapshot({
      f: flag({ prerequisites: [{ key: "a", variation: 1 }, { key: "b", variation: 1 }] }),
      a: flag({ key: "a", on: false }),
      b: flag({ key: "b", on: false }),
    });
    expect(evalIn(snap).reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisiteKey: "a" });
  });

  it("resolves a prerequisite chain", () => {
    const snap = snapshot({
      f: flag({ prerequisites: [{ key: "a", variation: 1 }], fallthrough: { variation: 1 } }),
      a: flag({ key: "a", prerequisites: [{ key: "b", variation: 1 }], fallthrough: { variation: 1 } }),
      b: flag({ key: "b", fallthrough: { variation: 1 } }),
    });
    expect(evalIn(snap).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("propagates a deep failure up the chain", () => {
    const snap = snapshot({
      f: flag({ prerequisites: [{ key: "a", variation: 1 }], fallthrough: { variation: 1 } }),
      a: flag({ key: "a", prerequisites: [{ key: "b", variation: 1 }], fallthrough: { variation: 1 } }),
      b: flag({ key: "b", on: false }),
    });
    expect(evalIn(snap).reason).toEqual({ kind: "PREREQUISITE_FAILED", prerequisiteKey: "a" });
  });

  it("stops at a depth cap rather than recursing forever on a cyclic snapshot", () => {
    // The compiler rejects cycles at compile time, so the evaluator never
    // needs cycle detection on the hot path. This is defence against a
    // corrupt snapshot, not the primary mechanism.
    const snap = snapshot({
      f: flag({ prerequisites: [{ key: "a", variation: 1 }] }),
      a: flag({ key: "a", prerequisites: [{ key: "f", variation: 1 }] }),
    });
    const d = evalIn(snap);
    expect(d.value).toBe("DEFAULT");
    expect(d.reason).toEqual({ kind: "ERROR", error: "PREREQUISITE_DEPTH_EXCEEDED" });
  });
});

describe("precedence step 4 - individual targets", () => {
  const targeted = flag({
    targets: [
      { contextKind: "user", variation: 1, keys: ["usr_1", "usr_2"] },
      { contextKind: "organization", variation: 0, keys: ["org_9"] },
    ],
    rules: [rule({ variation: 0 })],
    fallthrough: { variation: 0 },
  });

  it("matches a listed key", () => {
    const d = evalIn(snapshot({ f: targeted }));
    expect(d).toEqual({ value: true, variationIndex: 1, reason: { kind: "TARGET_MATCH" } });
  });

  it("does not match an unlisted key", () => {
    expect(evalIn(snapshot({ f: targeted }), { key: "usr_99", country: "DE" }).reason).toEqual({
      kind: "RULE_MATCH",
      ruleIndex: 0,
      ruleId: "r0",
    });
  });

  it("matches only within its own context kind", () => {
    // usr_1 is targeted as a user, not as an organization.
    const orgOnly = flag({
      targets: [{ contextKind: "organization", variation: 1, keys: ["usr_1"] }],
      fallthrough: { variation: 0 },
    });
    expect(evalIn(snapshot({ f: orgOnly })).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("beats a matching rule", () => {
    expect(evalIn(snapshot({ f: targeted })).reason).toEqual({ kind: "TARGET_MATCH" });
  });
});

describe("precedence step 5 - rules", () => {
  it("matches the first rule in order and reports its index and id", () => {
    const snap = snapshot({
      f: flag({
        variations: [false, true, "third"],
        kind: "string",
        rules: [
          rule({ id: "r_a", clauses: [clause({ attribute: "country", values: ["FR"] })], variation: 1 }),
          rule({ id: "r_b", clauses: [clause({ attribute: "country", values: ["DE"] })], variation: 2 }),
          rule({ id: "r_c", clauses: [clause({ attribute: "plan", values: ["pro"] })], variation: 1 }),
        ],
      }),
    });
    const d = evalIn(snap);
    expect(d.value).toBe("third");
    expect(d.reason).toEqual({ kind: "RULE_MATCH", ruleIndex: 1, ruleId: "r_b" });
  });

  it("ANDs the clauses within a rule", () => {
    const both = rule({
      clauses: [clause({ attribute: "country", values: ["DE"] }), clause({ attribute: "plan", values: ["free"] })],
    });
    expect(evalIn(snapshot({ f: flag({ rules: [both] }) })).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("applies negate to a matched clause", () => {
    const notDE = rule({ clauses: [clause({ negate: true })] });
    expect(evalIn(snapshot({ f: flag({ rules: [notDE] }) })).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("makes a missing attribute match under negation", () => {
    // The semantics people expect from "is not in": a non-match caused by a
    // missing attribute becomes a match under negation.
    const notMissing = rule({ clauses: [clause({ attribute: "absent", negate: true })] });
    expect(evalIn(snapshot({ f: flag({ rules: [notMissing] }) })).reason).toMatchObject({
      kind: "RULE_MATCH",
    });
  });

  it("resolves a rule rollout", () => {
    const rolled = rule({
      variation: undefined,
      rollout: { variations: [{ variationIndex: 1, weight: 100_000 }] },
    });
    const d = evalIn(snapshot({ f: flag({ rules: [rolled] }) }));
    expect(d.value).toBe(true);
    expect(d.reason).toMatchObject({ kind: "RULE_MATCH", ruleIndex: 0 });
  });

  it("skips a rule whose rollout cannot bucket the context", () => {
    // Excluded from the rollout, so the rule does not match and evaluation
    // continues - rather than silently assigning variation 0.
    const rolled = rule({
      variation: undefined,
      rollout: { bucketBy: "absentAttribute", variations: [{ variationIndex: 1, weight: 100_000 }] },
    });
    expect(evalIn(snapshot({ f: flag({ rules: [rolled] }) })).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("matches a clause against a non-user context kind", () => {
    const orgRule = rule({
      clauses: [clause({ contextKind: "organization", attribute: "tier", values: ["enterprise"] })],
    });
    const multi: EvaluationContext = {
      kind: "multi",
      user: { key: "usr_1" },
      organization: { key: "org_9", tier: "enterprise" },
    };
    expect(evalIn(snapshot({ f: flag({ rules: [orgRule] }) }), multi).reason).toMatchObject({
      kind: "RULE_MATCH",
    });
  });

  it("does not match when the clause's context kind is absent", () => {
    const deviceRule = rule({ clauses: [clause({ contextKind: "device", attribute: "os", values: ["ios"] })] });
    expect(evalIn(snapshot({ f: flag({ rules: [deviceRule] }) })).reason).toEqual({ kind: "FALLTHROUGH" });
  });
});

describe("precedence step 6 - fallthrough", () => {
  it("serves the fallthrough variation", () => {
    const d = evalIn(snapshot({ f: flag({ fallthrough: { variation: 1 } }) }));
    expect(d).toEqual({ value: true, variationIndex: 1, reason: { kind: "FALLTHROUGH" } });
  });

  it("serves a fallthrough rollout", () => {
    const d = evalIn(
      snapshot({ f: flag({ fallthrough: { rollout: { variations: [{ variationIndex: 1, weight: 100_000 }] } } }) }),
    );
    expect(d).toEqual({ value: true, variationIndex: 1, reason: { kind: "FALLTHROUGH" } });
  });

  it("serves the caller's default when a fallthrough rollout cannot bucket", () => {
    // The flag is on, the context cannot be placed, and there is no defined
    // answer. The caller's default is the honest backstop, and ERROR is what
    // makes featurekit_sdk_default_served_total rise so someone notices.
    const d = evalIn(
      snapshot({
        f: flag({
          fallthrough: { rollout: { bucketBy: "absent", variations: [{ variationIndex: 1, weight: 100_000 }] } },
        }),
      }),
    );
    expect(d.value).toBe("DEFAULT");
    expect(d.reason).toEqual({ kind: "ERROR", error: "MALFORMED_CONTEXT" });
  });
});

/* ─────────────────────── errors: never throw (§9.1) ─────────────────── */

describe("the evaluator never throws", () => {
  it("reports a malformed context rather than throwing", () => {
    const d = evaluate("f", { plan: "pro" } as EvaluationContext, snapshot({ f: flag() }), "DEFAULT");
    expect(d).toEqual({ value: "DEFAULT", variationIndex: null, reason: { kind: "ERROR", error: "MALFORMED_CONTEXT" } });
  });

  it("reports an out-of-range variation index", () => {
    const d = evalIn(snapshot({ f: flag({ fallthrough: { variation: 7 } }) }));
    expect(d).toEqual({
      value: "DEFAULT",
      variationIndex: null,
      reason: { kind: "ERROR", error: "VARIATION_OUT_OF_RANGE" },
    });
  });

  it("reports a value that does not match the flag's declared kind", () => {
    // A boolean flag must never hand a string to `if (fk.get(...))`.
    const d = evalIn(snapshot({ f: flag({ kind: "boolean", variations: ["not a boolean"], fallthrough: { variation: 0 } }) }));
    expect(d.reason).toEqual({ kind: "ERROR", error: "WRONG_TYPE" });
    expect(d.value).toBe("DEFAULT");
  });

  it("accepts any JSON value for a json flag", () => {
    const d = evalIn(
      snapshot({ f: flag({ kind: "json", variations: [{ tier: "pro" }], fallthrough: { variation: 0 } }) }),
      ctx,
      null,
    );
    expect(d.value).toEqual({ tier: "pro" });
  });

  it("survives a structurally broken flag", () => {
    const broken = { key: "f", version: 1, kind: "boolean", on: true } as unknown as CompiledFlag;
    const d = evalIn(snapshot({ f: broken }));
    expect(d.value).toBe("DEFAULT");
    expect(d.reason).toMatchObject({ kind: "ERROR" });
  });

  it("isolates a broken flag from a healthy one", () => {
    const snap = snapshot({
      f: { key: "f", version: 1, kind: "boolean", on: true } as unknown as CompiledFlag,
      healthy: flag({ key: "healthy", fallthrough: { variation: 1 } }),
    });
    expect(evaluate("f", ctx, snap, "DEFAULT").reason).toMatchObject({ kind: "ERROR" });
    expect(evaluate("healthy", ctx, snap, false).value).toBe(true);
  });

  it("survives a clause with a non-array values field", () => {
    const bad = rule({ clauses: [{ ...clause(), values: "DE" as unknown as unknown[] }] });
    expect(() => evalIn(snapshot({ f: flag({ rules: [bad] }) }))).not.toThrow();
  });
});

/* ───────────── segments: unresolved fails the RULE closed (§9.7) ─────── */

describe("segmentMatch", () => {
  const inlineSeg: CompiledSegment = { kind: "inline", version: 1, members: ["usr_1"] };
  const segRule = (negate: boolean) =>
    rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["beta"], negate })] });

  it("matches a member of an inline segment", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(false)] }) }, { beta: inlineSeg });
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, ctx, "DEFAULT", { segments: index }).reason).toMatchObject({ kind: "RULE_MATCH" });
  });

  it("does not match a non-member", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(false)] }) }, { beta: inlineSeg });
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, { key: "usr_99" }, "DEFAULT", { segments: index }).reason).toEqual({
      kind: "FALLTHROUGH",
    });
  });

  it("inverts a resolved segment miss under negate", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(true)] }) }, { beta: inlineSeg });
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, { key: "usr_99" }, "DEFAULT", { segments: index }).reason).toMatchObject({
      kind: "RULE_MATCH",
    });
  });
});

describe("an UNRESOLVED segment fails the whole rule closed, in BOTH polarities (§22.3)", () => {
  const members = Array.from({ length: 2_000 }, (_, i) => `usr_${i}`);
  const bigSeg = (): CompiledSegment => ({
    kind: "cuckoo",
    version: 1,
    filter: buildCuckooFilter(members).filter.encode(),
    fpRate: 0.00012,
    loadFactor: 0.8,
  });
  const segRule = (negate: boolean) =>
    rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["enterprise"], negate })] });
  const member: EvaluationContext = { key: "usr_1" };

  it("does not match a POSITIVE segment clause while membership is unconfirmed", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(false)] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments); // no cache loaded yet
    const d = evalIn(snap, member, "DEFAULT", { segments: index });
    expect(d.reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("does NOT match a NEGATED segment clause while membership is unconfirmed", () => {
    // This is the r2 leak. "NOT in enterprise -> serve the gated feature" with
    // an unloaded cache evaluated the clause to false, negate flipped it to
    // TRUE, and every unconfirmed user was served the feature. Exclusion lists
    // are the ordinary use of negated segment clauses, so this was the feature
    // failing OPEN on every cold start.
    const snap = snapshot({ f: flag({ rules: [segRule(true)] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments);
    const d = evalIn(snap, member, "DEFAULT", { segments: index });
    expect(d.reason).toEqual({ kind: "FALLTHROUGH" });
    expect(d.value).toBe(false); // the fallthrough variation, not the gated one
  });

  it("annotates the skipped rule so debug/evaluate can explain it", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(true)] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments);
    const d = evalIn(snap, member, "DEFAULT", { segments: index });
    expect(d.unresolved).toEqual([
      { ruleIndex: 0, ruleId: "r0", segmentKey: "enterprise", reason: "SEGMENT_UNRESOLVED" },
    ]);
  });

  it("counts the unresolved lookup for the metric that says the LRU is too small", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(false)] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments);
    evalIn(snap, member, "DEFAULT", { segments: index });
    expect(index.unresolvedCount).toBeGreaterThan(0);
  });

  it("matches normally once the confirmation set is loaded", () => {
    const snap = snapshot({ f: flag({ rules: [segRule(false)] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments);
    index.setCache(new InMemorySegmentCache({ enterprise: members }));
    const d = evalIn(snap, member, "DEFAULT", { segments: index });
    expect(d.reason).toMatchObject({ kind: "RULE_MATCH" });
    expect(d.unresolved).toBeUndefined();
  });

  it("short-circuits the rule before later clauses, and before negation", () => {
    // The unresolved state must not be turned into a boolean by ANY clause
    // ordering. A resolvable clause after an unresolved one must not rescue it.
    const mixed = rule({
      clauses: [
        clause({ op: "segmentMatch", attribute: "key", values: ["enterprise"], negate: true }),
        clause({ attribute: "key", op: "in", values: ["usr_1"] }),
      ],
    });
    const snap = snapshot({ f: flag({ rules: [mixed] }) }, { enterprise: bigSeg() });
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, member, "DEFAULT", { segments: index }).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("falls through to a LATER rule that is fully resolvable", () => {
    const snap = snapshot(
      {
        f: flag({
          rules: [segRule(true), rule({ id: "r1", clauses: [clause({ attribute: "key", values: ["usr_1"] })], variation: 1 })],
        }),
      },
      { enterprise: bigSeg() },
    );
    const index = new SegmentIndex(snap.segments);
    const d = evalIn(snap, member, "DEFAULT", { segments: index });
    expect(d.reason).toMatchObject({ kind: "RULE_MATCH", ruleIndex: 1 });
    expect(d.unresolved).toHaveLength(1); // rule 0 was still skipped, and says so
  });

  it("is unaffected for roaring segments, which cannot be unresolved", () => {
    // A second reason to prefer roaring where the key is integral.
    const snap = snapshot(
      { f: flag({ rules: [segRule(true)] }) },
      {
        enterprise: {
          kind: "roaring",
          version: 1,
          contextKind: "user",
          // members 1..100, as integral keys
          bitmap: RoaringBitmap.from(Array.from({ length: 100 }, (_, i) => i + 1)).serialize(),
        },
      },
    );
    const index = new SegmentIndex(snap.segments);
    // "500" is not in the bitmap, so NOT-in-segment is a definite match.
    expect(evalIn(snap, { key: "500" }, "DEFAULT", { segments: index }).reason).toMatchObject({
      kind: "RULE_MATCH",
    });
  });
});

describe("segmentMatch recursion", () => {
  it("resolves a segment whose rule references another segment", () => {
    const snap = snapshot(
      { f: flag({ rules: [rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["outer"] })] })] }) },
      {
        outer: {
          kind: "inline",
          version: 1,
          members: [],
          rules: [{ id: "sr0", clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["inner"] })] }],
        },
        inner: { kind: "inline", version: 1, members: ["usr_1"] },
      },
    );
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, ctx, "DEFAULT", { segments: index }).reason).toMatchObject({ kind: "RULE_MATCH" });
  });

  it("stops at the depth cap instead of recursing forever", () => {
    const snap = snapshot(
      { f: flag({ rules: [rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["a"] })] })] }) },
      {
        a: { kind: "inline", version: 1, members: [], rules: [{ id: "s", clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["b"] })] }] },
        b: { kind: "inline", version: 1, members: [], rules: [{ id: "s", clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["a"] })] }] },
      },
    );
    const index = new SegmentIndex(snap.segments);
    expect(() => evalIn(snap, ctx, "DEFAULT", { segments: index })).not.toThrow();
    expect(evalIn(snap, ctx, "DEFAULT", { segments: index }).reason).toEqual({ kind: "FALLTHROUGH" });
  });

  it("matches a segment rule with clauses over context attributes", () => {
    const snap = snapshot(
      { f: flag({ rules: [rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["eu-pro"] })] })] }) },
      {
        "eu-pro": {
          kind: "inline",
          version: 1,
          members: [],
          rules: [{ id: "sr0", clauses: [clause({ attribute: "country", values: ["DE"] }), clause({ attribute: "plan", values: ["pro"] })] }],
        },
      },
    );
    const index = new SegmentIndex(snap.segments);
    expect(evalIn(snap, ctx, "DEFAULT", { segments: index }).reason).toMatchObject({ kind: "RULE_MATCH" });
  });

  it("honours a segment rule's weight, so a segment can be a share of a population", () => {
    const build = (weight: number) =>
      snapshot(
        { f: flag({ rules: [rule({ clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["half"] })] })] }) },
        {
          half: {
            kind: "inline",
            version: 1,
            members: [],
            rules: [{ id: "sr0", weight, clauses: [clause({ attribute: "country", values: ["DE"] })] }],
          },
        },
      );
    const matched = (weight: number) =>
      Array.from({ length: 4_000 }, (_, i) => i).filter((i) => {
        const snap = build(weight);
        return (
          evalIn(snap, { key: `usr_${i}`, country: "DE" }, "DEFAULT", { segments: new SegmentIndex(snap.segments) })
            .reason.kind === "RULE_MATCH"
        );
      }).length;

    expect(matched(100_000)).toBe(4_000);
    expect(matched(0)).toBe(0);
    const half = matched(50_000);
    expect(half).toBeGreaterThan(1_800);
    expect(half).toBeLessThan(2_200);
  });
});

describe("a missing SegmentIndex", () => {
  it("makes every segment clause unresolved, so rules fail closed", () => {
    // Evaluating without segment state is a legitimate cold-start condition.
    // It must not throw, and it must not grant the feature under negation.
    const segRule = rule({
      clauses: [clause({ op: "segmentMatch", attribute: "key", values: ["beta"], negate: true })],
    });
    const snap = snapshot({ f: flag({ rules: [segRule] }) }, { beta: { kind: "inline", version: 1, members: [] } });
    expect(evalIn(snap).reason).toEqual({ kind: "FALLTHROUGH" });
  });
});

describe("flag lookup never reaches Object.prototype", () => {
  /**
   * `snapshot.flags` is a plain object decoded from JSON, so a plain lookup
   * finds inherited members: `flags["constructor"]` is a function and
   * `flags["__proto__"]` is the prototype. Both are truthy, so a *missing* flag
   * with one of those keys reported `OFF` — indistinguishable from a flag
   * somebody deliberately turned off, and it never raised the not-found signal
   * an operator watches for a typo'd key.
   */
  const empty = snapshot({});

  it.each(["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"])(
    "reports FLAG_NOT_FOUND for a missing %s flag",
    (key) => {
      const detail = evaluate(key, { key: "usr_1" }, empty, "the-default");
      expect(detail.reason.kind).toBe("FLAG_NOT_FOUND");
      expect(detail.value).toBe("the-default");
    },
  );

  it("still finds a real flag that happens to be named that", () => {
    // An own property shadows the prototype, so this always worked — the guard
    // must not break it.
    const s = snapshot({
      constructor: flag({ key: "constructor", on: true, fallthrough: { variation: 1 } }),
    });
    const detail = evaluate("constructor", { key: "usr_1" }, s, false);
    expect(detail.reason.kind).toBe("FALLTHROUGH");
    expect(detail.value).toBe(true);
  });

  it("treats a prerequisite pointing at one as missing, not as an off flag", () => {
    const s = snapshot({
      gated: flag({
        key: "gated",
        on: true,
        prerequisites: [{ key: "toString", variation: 1 }],
        offVariation: 0,
        fallthrough: { variation: 1 },
      }),
    });
    const detail = evaluate("gated", { key: "usr_1" }, s, false);
    // Either way the prerequisite is unmet; what matters is that it resolves
    // through the missing-flag path rather than treating a function as a flag.
    expect(detail.reason.kind).toBe("PREREQUISITE_FAILED");
    expect(detail.value).toBe(false);
  });
});
