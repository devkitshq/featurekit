import { describe, expect, it } from "vitest";
import { applyOperator, compareSemVer, parseSemVer } from "../../src/sdk/evaluation/operators.js";
import type { Operator } from "../../src/sdk/evaluation/types.js";

const op = (attr: unknown, o: Operator, values: unknown[]) => applyOperator(o, attr, values);

describe("in", () => {
  it("matches on strict equality against any listed value", () => {
    expect(op("DE", "in", ["US", "DE"])).toBe(true);
    expect(op("FR", "in", ["US", "DE"])).toBe(false);
    expect(op(42, "in", [7, 42])).toBe(true);
    expect(op(true, "in", [true])).toBe(true);
    expect(op(null, "in", [null])).toBe(true);
  });

  it("does not coerce across types", () => {
    expect(op("42", "in", [42])).toBe(false);
    expect(op(1, "in", [true])).toBe(false);
    expect(op(0, "in", [""])).toBe(false);
  });

  it("matches deep-equal objects and arrays by value", () => {
    expect(op({ a: 1 }, "in", [{ a: 1 }])).toBe(true);
    expect(op({ a: 1 }, "in", [{ a: 2 }])).toBe(false);
  });

  it("returns false for an empty value list", () => {
    expect(op("DE", "in", [])).toBe(false);
  });
});

describe("string operators", () => {
  it.each([
    ["startsWith", "acme-corp", ["acme"], true],
    ["startsWith", "acme-corp", ["corp"], false],
    ["endsWith", "user@acme.com", ["@acme.com"], true],
    ["endsWith", "user@acme.com", ["@other.com"], false],
    ["contains", "user@acme.com", ["acme"], true],
    ["contains", "user@acme.com", ["zzz"], false],
  ] as [Operator, unknown, unknown[], boolean][])("%s over %s is %s", (o, a, v, expected) => {
    expect(op(a, o, v)).toBe(expected);
  });

  it("matches if ANY listed value matches", () => {
    expect(op("acme-corp", "startsWith", ["zzz", "acme"])).toBe(true);
  });

  it("is false when the attribute is not a string (type mismatch, never a throw)", () => {
    for (const o of ["startsWith", "endsWith", "contains"] as Operator[]) {
      expect(op(42, o, ["4"])).toBe(false);
      expect(op(null, o, ["4"])).toBe(false);
      expect(op(undefined, o, ["4"])).toBe(false);
    }
  });

  it("is false when the listed value is not a string", () => {
    expect(op("acme", "startsWith", [42])).toBe(false);
  });
});

describe("matches - regex", () => {
  it("matches a well-formed pattern", () => {
    expect(op("usr_7f3a91", "matches", ["^usr_[0-9a-f]+$"])).toBe(true);
    expect(op("adm_7f3a91", "matches", ["^usr_[0-9a-f]+$"])).toBe(false);
  });

  it("is unanchored, like every other regex engine", () => {
    expect(op("prefix-usr_1", "matches", ["usr_"])).toBe(true);
  });

  it("returns false for an invalid pattern instead of throwing", () => {
    // A rule author can write a broken regex. It must not take down the
    // customer's request path.
    expect(op("anything", "matches", ["([unclosed"])).toBe(false);
  });

  it("returns false for a non-string attribute", () => {
    expect(op(42, "matches", ["4"])).toBe(false);
  });

  it("refuses patterns over the length cap", () => {
    // Defence in depth: the dashboard caps these at write time, but a snapshot
    // is a wire format and the SDK does not get to assume it was checked.
    expect(op("aaaa", "matches", ["a".repeat(1001)])).toBe(false);
  });
});

describe("numeric comparison operators", () => {
  it.each([
    ["lessThan", 5, [10], true],
    ["lessThan", 10, [10], false],
    ["lessThanOrEqual", 10, [10], true],
    ["greaterThan", 15, [10], true],
    ["greaterThan", 10, [10], false],
    ["greaterThanOrEqual", 10, [10], true],
  ] as [Operator, unknown, unknown[], boolean][])("%s over %s is %s", (o, a, v, expected) => {
    expect(op(a, o, v)).toBe(expected);
  });

  it("is false against a string attribute - never coerced", () => {
    expect(op("15", "greaterThan", [10])).toBe(false);
    expect(op(15, "greaterThan", ["10"])).toBe(false);
  });

  it("is false for NaN and Infinity on either side", () => {
    expect(op(NaN, "lessThan", [10])).toBe(false);
    expect(op(10, "lessThan", [NaN])).toBe(false);
    expect(op(Infinity, "greaterThan", [10])).toBe(false);
  });

  it("is false for booleans, which are not numbers here", () => {
    expect(op(true, "greaterThan", [0])).toBe(false);
  });
});

describe("date operators", () => {
  it("compares ISO-8601 strings", () => {
    expect(op("2026-01-01T00:00:00Z", "before", ["2026-06-01T00:00:00Z"])).toBe(true);
    expect(op("2026-09-01T00:00:00Z", "before", ["2026-06-01T00:00:00Z"])).toBe(false);
    expect(op("2026-09-01T00:00:00Z", "after", ["2026-06-01T00:00:00Z"])).toBe(true);
  });

  it("compares epoch milliseconds", () => {
    expect(op(1_700_000_000_000, "before", [1_800_000_000_000])).toBe(true);
    expect(op(1_800_000_000_000, "after", [1_700_000_000_000])).toBe(true);
  });

  it("compares a number against an ISO string and vice versa", () => {
    expect(op(Date.parse("2026-01-01T00:00:00Z"), "before", ["2026-06-01T00:00:00Z"])).toBe(true);
  });

  it("treats equal instants as neither before nor after", () => {
    expect(op("2026-01-01T00:00:00Z", "before", ["2026-01-01T00:00:00Z"])).toBe(false);
    expect(op("2026-01-01T00:00:00Z", "after", ["2026-01-01T00:00:00Z"])).toBe(false);
  });

  it("is false for unparseable dates on either side", () => {
    expect(op("not-a-date", "before", ["2026-06-01T00:00:00Z"])).toBe(false);
    expect(op("2026-01-01T00:00:00Z", "after", ["not-a-date"])).toBe(false);
    expect(op(null, "before", ["2026-06-01T00:00:00Z"])).toBe(false);
    expect(op(true, "before", [0])).toBe(false);
  });
});

describe("parseSemVer", () => {
  it.each([
    ["1.2.3", [1, 2, 3, undefined]],
    ["1.2", [1, 2, 0, undefined]],
    ["1", [1, 0, 0, undefined]],
    ["1.2.3-beta.1", [1, 2, 3, "beta.1"]],
    ["1.2.3+build.5", [1, 2, 3, undefined]],
    ["1.2.3-rc.1+build.5", [1, 2, 3, "rc.1"]],
  ])("parses %s", (input, expected) => {
    const v = parseSemVer(input as string)!;
    expect([v.major, v.minor, v.patch, v.prerelease]).toEqual(expected);
  });

  it.each(["", "x", "1.2.3.4", "-1.0.0", "1.2.3-", "01.2.3", "1.b.3"])(
    "rejects %s",
    (input) => {
      expect(parseSemVer(input)).toBeNull();
    },
  );
});

describe("compareSemVer - precedence per the semver spec", () => {
  const cmp = (a: string, b: string) => compareSemVer(parseSemVer(a)!, parseSemVer(b)!);

  it("orders by major, then minor, then patch", () => {
    expect(cmp("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(cmp("2.1.0", "2.0.9")).toBeGreaterThan(0);
    expect(cmp("2.1.3", "2.1.3")).toBe(0);
    expect(cmp("2.1.10", "2.1.9")).toBeGreaterThan(0); // not a string compare
  });

  it("orders a prerelease below its release", () => {
    expect(cmp("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(cmp("1.0.0", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  it("orders prerelease identifiers numerically then lexically", () => {
    expect(cmp("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
    expect(cmp("1.0.0-alpha.9", "1.0.0-alpha.10")).toBeLessThan(0); // numeric, not lexical
    expect(cmp("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(cmp("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0); // shorter set is lower
    expect(cmp("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0); // numeric < alphanumeric
  });

  it("ignores build metadata for precedence", () => {
    expect(cmp("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });
});

describe("semver operators", () => {
  it.each([
    ["semVerEqual", "1.2.3", ["1.2.3"], true],
    ["semVerEqual", "1.2.3", ["1.2.4"], false],
    ["semVerEqual", "1.2.3+b", ["1.2.3"], true],
    ["semVerLessThan", "1.2.3", ["1.3.0"], true],
    ["semVerLessThan", "1.3.0", ["1.2.3"], false],
    ["semVerGreaterThan", "2.0.0", ["1.9.9"], true],
    ["semVerGreaterThan", "1.0.0-rc.1", ["1.0.0-rc.2"], false],
  ] as [Operator, unknown, unknown[], boolean][])("%s over %s is %s", (o, a, v, expected) => {
    expect(op(a, o, v)).toBe(expected);
  });

  it("is false when either side is not a valid version", () => {
    expect(op("not-a-version", "semVerLessThan", ["1.0.0"])).toBe(false);
    expect(op("1.0.0", "semVerLessThan", ["not-a-version"])).toBe(false);
    expect(op(1, "semVerEqual", ["1.0.0"])).toBe(false);
  });
});

describe("multi-valued attributes match if ANY element matches", () => {
  it("matches an array attribute against `in`", () => {
    expect(op(["a", "b"], "in", ["b"])).toBe(true);
    expect(op(["a", "b"], "in", ["c"])).toBe(false);
  });

  it("applies elementwise for every operator, not just `in`", () => {
    expect(op(["acme-eu", "other"], "startsWith", ["acme"])).toBe(true);
    expect(op([1, 50], "greaterThan", [10])).toBe(true);
    expect(op([1, 5], "greaterThan", [10])).toBe(false);
    expect(op(["1.0.0", "2.0.0"], "semVerGreaterThan", ["1.5.0"])).toBe(true);
  });

  it("is false for an empty array attribute", () => {
    expect(op([], "in", ["a"])).toBe(false);
  });

  it("does not recurse into nested arrays", () => {
    expect(op([["b"]], "in", ["b"])).toBe(false);
  });
});

describe("missing attributes", () => {
  it("never match, for any operator", () => {
    const ops: Operator[] = [
      "in", "startsWith", "endsWith", "contains", "matches",
      "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual",
      "before", "after", "semVerEqual", "semVerLessThan", "semVerGreaterThan",
    ];
    for (const o of ops) expect(op(undefined, o, ["anything", 1])).toBe(false);
  });
});

describe("unknown operators", () => {
  it("are false, so an SDK older than a rule degrades instead of throwing", () => {
    expect(op("x", "notAnOperator" as Operator, ["x"])).toBe(false);
  });
});
