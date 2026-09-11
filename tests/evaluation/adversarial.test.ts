/**
 * The evaluator against hostile input (review §3).
 *
 * The evaluator is documented as never throwing, never hanging, and always
 * returning the caller's default on error. Those are the three properties an
 * application owner is trusting when they put this in a request path, and the
 * existing suite tests them against *plausible* inputs. This one tests them
 * against inputs designed to break them.
 *
 * Two categories are deliberately mixed:
 *
 * 1. **Corrupt snapshots.** The compiler rejects cycles, dangling variation
 *    references and malformed rules — but a snapshot is a wire format that
 *    arrived over a network, and the SDK does not get to assume the compiler
 *    that produced it was this one, or was working. Every structure here
 *    bypasses the compiler entirely and is handed straight to `evaluate`.
 * 2. **Hostile contexts.** Values a browser can put in a context, which the
 *    server tier does not cap the way the client tier does.
 */

import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/sdk/evaluation/evaluate.js";
import { SegmentIndex } from "../../src/sdk/evaluation/segments.js";
import type { Snapshot } from "../../src/sdk/evaluation/types.js";

const DEFAULT = "caller-default";

/** A deliberately minimal, valid snapshot to mutate into invalid shapes. */
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    environmentKey: "production",
    salt: "salt",
    flags: {
      f: {
        key: "f",
        version: 1,
        kind: "string",
        on: true,
        variations: ["off", "on"],
        offVariation: 0,
        fallthrough: { variation: 1 },
        prerequisites: [],
        targets: [],
        rules: [],
      },
    },
    segments: {},
    ...over,
  } as Snapshot;
}

/** Every evaluation in this file must complete well inside a frame. */
function within(ms: number, run: () => unknown): unknown {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(ms);
  return result;
}

describe("corrupt snapshots never throw", () => {
  it("survives a snapshot that is not an object at all", () => {
    for (const bad of [null, undefined, 42, "snapshot", [], true]) {
      const detail = evaluate("f", { key: "u" }, bad as unknown as Snapshot, DEFAULT);
      expect(detail.value).toBe(DEFAULT);
    }
  });

  it("survives flags being the wrong shape", () => {
    for (const flags of [null, "flags", 42, []]) {
      const detail = evaluate("f", { key: "u" }, snapshot({ flags } as never), DEFAULT);
      expect(detail.value).toBe(DEFAULT);
    }
  });

  it("survives a flag whose variations are missing or not an array", () => {
    for (const variations of [undefined, null, "vals", 42, {}]) {
      const s = snapshot();
      (s.flags["f"] as Record<string, unknown>)["variations"] = variations;
      const detail = evaluate("f", { key: "u" }, s, DEFAULT);
      expect(detail.value).toBe(DEFAULT);
      expect(detail.reason.kind).toBe("ERROR");
    }
  });

  it("survives rules that are not arrays, and clauses that are not objects", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      null,
      42,
      { clauses: "not-an-array", variation: 1 },
      { clauses: [null, 42, "x"], variation: 1 },
    ];
    const detail = evaluate("f", { key: "u" }, s, DEFAULT);
    expect(detail.value).not.toBe(undefined);
  });

  it("survives a fallthrough that is neither a variation nor a rollout", () => {
    for (const fallthrough of [null, undefined, {}, 42, { variation: "one" }]) {
      const s = snapshot();
      (s.flags["f"] as Record<string, unknown>)["fallthrough"] = fallthrough;
      const detail = evaluate("f", { key: "u" }, s, DEFAULT);
      expect(detail.value).toBe(DEFAULT);
    }
  });

  it("refuses a variation index outside the array", () => {
    for (const index of [2, 99, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const s = snapshot();
      (s.flags["f"] as Record<string, unknown>)["fallthrough"] = { variation: index };
      const detail = evaluate("f", { key: "u" }, s, DEFAULT);
      expect(detail.value).toBe(DEFAULT);
      expect(detail.reason).toMatchObject({ kind: "ERROR" });
    }
  });

  it("refuses a variation whose type contradicts the flag kind", () => {
    // A boolean flag must never hand a string to `if (fk.get(...))`.
    const s = snapshot();
    const flag = s.flags["f"] as Record<string, unknown>;
    flag["kind"] = "boolean";
    flag["variations"] = ["not-a-boolean", 42];
    const detail = evaluate("f", { key: "u" }, s, false);
    expect(detail.value).toBe(false);
    expect(detail.reason).toMatchObject({ kind: "ERROR", error: "WRONG_TYPE" });
  });
});

describe("prerequisite chains cannot hang the evaluator", () => {
  it("terminates on a direct self-cycle injected past the compiler", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["prerequisites"] = [{ key: "f", variation: 1 }];
    const detail = within(100, () => evaluate("f", { key: "u" }, s, DEFAULT));
    expect(detail).toBeDefined();
  });

  it("terminates on a two-flag cycle", () => {
    const s = snapshot();
    s.flags["g"] = { ...s.flags["f"]!, key: "g" };
    (s.flags["f"] as Record<string, unknown>)["prerequisites"] = [{ key: "g", variation: 1 }];
    (s.flags["g"] as Record<string, unknown>)["prerequisites"] = [{ key: "f", variation: 1 }];
    within(100, () => evaluate("f", { key: "u" }, s, DEFAULT));
  });

  it("terminates on a long chain past the depth cap", () => {
    const s = snapshot({ flags: {} });
    // 500 flags, each requiring the next. The cap is 20.
    for (let i = 0; i < 500; i++) {
      s.flags[`f${i}`] = {
        key: `f${i}`,
        version: 1,
        kind: "string",
        on: true,
        variations: ["off", "on"],
        offVariation: 0,
        fallthrough: { variation: 1 },
        prerequisites: i < 499 ? [{ key: `f${i + 1}`, variation: 1 }] : [],
        targets: [],
        rules: [],
      } as never;
    }
    const detail = within(100, () => evaluate("f0", { key: "u" }, s, DEFAULT)) as {
      value: string;
    };
    expect(detail.value).toBe(DEFAULT);
  });
});

describe("segment recursion cannot hang the evaluator", () => {
  it("terminates on a segment that includes itself", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      { id: "r0", clauses: [{ op: "segmentMatch", values: ["loop"] }], variation: 1 },
    ];
    const segments = new SegmentIndex({
      loop: {
        key: "loop",
        version: 1,
        rules: [{ clauses: [{ op: "segmentMatch", values: ["loop"] }] }],
      },
    } as never);
    within(100, () => evaluate("f", { key: "u" }, s, DEFAULT, { segments }));
  });

  it("terminates on mutually recursive segments", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      { id: "r0", clauses: [{ op: "segmentMatch", values: ["a"] }], variation: 1 },
    ];
    const segments = new SegmentIndex({
      a: { key: "a", version: 1, rules: [{ clauses: [{ op: "segmentMatch", values: ["b"] }] }] },
      b: { key: "b", version: 1, rules: [{ clauses: [{ op: "segmentMatch", values: ["a"] }] }] },
    } as never);
    within(100, () => evaluate("f", { key: "u" }, s, DEFAULT, { segments }));
  });
});

describe("pathological rule sets stay bounded", () => {
  it("evaluates 5,000 rules against a cold segment index without unbounded allocation", () => {
    // Every rule is unresolved, which is the shape that used to allocate one
    // diagnostic object per rule, per evaluation (PR-B14).
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `r${i}`,
      clauses: [{ op: "segmentMatch", values: [`seg-${i}`] }],
      variation: 1,
    }));
    const detail = within(500, () => evaluate("f", { key: "u" }, s, DEFAULT)) as {
      unresolved?: unknown[];
    };
    expect(detail.unresolved?.length ?? 0).toBeLessThanOrEqual(20);
  });

  it("evaluates a rule with 10,000 clause values quickly", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      {
        id: "r0",
        clauses: [
          {
            op: "in",
            attribute: "country",
            values: Array.from({ length: 10_000 }, (_, i) => `c${i}`),
          },
        ],
        variation: 1,
      },
    ];
    within(200, () => evaluate("f", { key: "u", country: "zz" }, s, DEFAULT));
  });
});

describe("hostile regex patterns", () => {
  /** The classic catastrophic shapes, each with an input that maximises backtracking. */
  const catastrophic: Array<[string, string]> = [
    ["^(a+)+$", `${"a".repeat(40)}!`],
    ["^(a*)*$", `${"a".repeat(40)}!`],
    ["^(a|a)*$", `${"a".repeat(40)}!`],
    ["^(\\d+)+$", `${"1".repeat(40)}x`],
    ["^((ab)+)*$", `${"ab".repeat(25)}!`],
    ["(x+x+)+y", `${"x".repeat(40)}z`],
  ];

  for (const [pattern, input] of catastrophic) {
    it(`does not hang on ${pattern}`, () => {
      const s = snapshot();
      (s.flags["f"] as Record<string, unknown>)["rules"] = [
        { id: "r0", clauses: [{ op: "matches", attribute: "email", values: [pattern] }], variation: 1 },
      ];
      // Without the structural guard this is minutes, not milliseconds.
      const detail = within(250, () =>
        evaluate("f", { key: "u", email: input }, s, DEFAULT),
      ) as { value: string };
      // Rejected patterns make the clause false, so the flag falls through.
      expect(detail.value).toBe("on");
    });
  }

  it("still runs ordinary patterns correctly", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      {
        id: "r0",
        clauses: [{ op: "matches", attribute: "email", values: ["^.+@example\\.com$"] }],
        variation: 0,
      },
    ];
    expect(evaluate("f", { key: "u", email: "a@example.com" }, s, DEFAULT).value).toBe("off");
    expect(evaluate("f", { key: "u", email: "a@other.com" }, s, DEFAULT).value).toBe("on");
  });

  it("refuses to match an absurdly long attribute", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      { id: "r0", clauses: [{ op: "matches", attribute: "bio", values: ["^a+$"] }], variation: 0 },
    ];
    const bio = "a".repeat(100_000);
    const detail = within(250, () => evaluate("f", { key: "u", bio }, s, DEFAULT)) as {
      value: string;
    };
    expect(detail.value).toBe("on");
  });
});

describe("hostile contexts", () => {
  it("handles unicode, RTL overrides, lone surrogates and emoji keys", () => {
    const keys = [
      "用户-1",
      "user‮evil",
      "\uD800", // lone surrogate
      "🎉".repeat(100),
      "user\u0000null",
      "a".repeat(10_000), // absurdly long, but not blank
    ];
    for (const key of keys) {
      const detail = evaluate("f", { key }, snapshot(), DEFAULT);
      expect(detail.value).toBe("on");
    }
  });

  it("treats a blank key as malformed rather than evaluating as nobody", () => {
    // `context.ts` requires a non-blank key: it is hashed, indexed and
    // displayed, so an all-whitespace key is a caller bug. The documented
    // outcome is the caller's default — not a silent evaluation for `"   "`,
    // which would drop every such caller into one shared bucket.
    const blank = ["", " ", " ".repeat(1_000), String.fromCharCode(9, 10)];
    for (const key of blank) {
      const detail = evaluate("f", { key }, snapshot(), DEFAULT);
      expect(detail.value).toBe(DEFAULT);
      expect(detail.reason).toMatchObject({ kind: "ERROR", error: "MALFORMED_CONTEXT" });
    }
  });

  it("handles an enormous context without hanging", () => {
    const context: Record<string, unknown> = { key: "u" };
    for (let i = 0; i < 5_000; i++) context[`attr${i}`] = `value-${i}`;
    within(250, () => evaluate("f", context, snapshot(), DEFAULT));
  });

  it("handles deeply nested attribute values", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 5_000; i++) deep = { next: deep };
    const detail = within(250, () =>
      evaluate("f", { key: "u", deep }, snapshot(), DEFAULT),
    ) as { value: string };
    expect(detail.value).toBe("on");
  });

  it("handles a context whose attributes collide with prototype names", () => {
    // Prototype pollution shaped input: these must be data, never behaviour.
    const context = JSON.parse(
      '{"key":"u","__proto__":{"polluted":true},"constructor":{"x":1},"toString":"nope"}',
    ) as Record<string, unknown>;
    const detail = evaluate("f", context, snapshot(), DEFAULT);
    expect(detail.value).toBe("on");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("handles NaN, Infinity and -0 in numeric comparisons", () => {
    const s = snapshot();
    (s.flags["f"] as Record<string, unknown>)["rules"] = [
      { id: "r0", clauses: [{ op: "greaterThan", attribute: "age", values: [18] }], variation: 0 },
    ];
    for (const age of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      const detail = evaluate("f", { key: "u", age }, s, DEFAULT);
      expect([DEFAULT, "off", "on"]).toContain(detail.value);
    }
  });

  it("never returns undefined, whatever it is given", () => {
    const contexts: unknown[] = [
      null,
      undefined,
      42,
      "user",
      [],
      {},
      { key: null },
      { key: 42 },
      { kind: "multi" },
      { kind: "multi", user: null },
      { kind: "multi", user: { key: null } },
    ];
    for (const context of contexts) {
      const detail = evaluate("f", context as never, snapshot(), DEFAULT);
      expect(detail.value).toBeDefined();
      expect(detail).toHaveProperty("reason");
    }
  });
});
