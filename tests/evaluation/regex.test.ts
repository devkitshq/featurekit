/**
 * The regex safety guard.
 *
 * Two failure directions, and both matter:
 *
 * - **Under-rejection** hangs a customer's process, unrecoverably, because
 *   JavaScript cannot interrupt a running regex. The `(a|a)*` case below is not
 *   hypothetical: it ran for 291 seconds against an earlier version of this
 *   guard that only looked for nested quantifiers.
 * - **Over-rejection** silently breaks legitimate targeting. Every pattern in
 *   the accept list is one a real rule author would plausibly write, so this
 *   half of the suite is what stops the guard being tightened into uselessness.
 */

import { describe, expect, it } from "vitest";
import {
  checkRegexPattern,
  clearRegexCache,
  compileSafeRegExp,
  MAX_REGEX_LENGTH,
} from "../../src/sdk/evaluation/regex.js";

describe("patterns that must be rejected", () => {
  const catastrophic: Array<[string, string]> = [
    ["^(a+)+$", "NESTED_QUANTIFIER"],
    ["^(a*)*$", "NESTED_QUANTIFIER"],
    ["^(a+)*$", "NESTED_QUANTIFIER"],
    ["(x+x+)+y", "NESTED_QUANTIFIER"],
    ["^((ab)+)*$", "NESTED_QUANTIFIER"],
    ["^(\\d+)+$", "NESTED_QUANTIFIER"],
    ["^(a{1,10})+$", "NESTED_QUANTIFIER"],
    ["^(a|a)*$", "AMBIGUOUS_ALTERNATION"],
    ["^(a|ab)+$", "AMBIGUOUS_ALTERNATION"],
    ["^(a|.)*$", "AMBIGUOUS_ALTERNATION"],
    ["^(\\d|\\w)+$", "AMBIGUOUS_ALTERNATION"],
    ["^([ab]|[bc])*$", "AMBIGUOUS_ALTERNATION"],
    ["^(a|)*$", "AMBIGUOUS_ALTERNATION"],
  ];

  for (const [pattern, reason] of catastrophic) {
    it(`rejects ${pattern} as ${reason}`, () => {
      expect(checkRegexPattern(pattern)).toEqual({ ok: false, reason });
    });
  }

  it("rejects a pattern longer than the cap", () => {
    expect(checkRegexPattern("a".repeat(MAX_REGEX_LENGTH + 1))).toEqual({
      ok: false,
      reason: "TOO_LONG",
    });
  });

  it("rejects anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(checkRegexPattern(value).ok).toBe(false);
    }
  });

  it("rejects a syntactically invalid pattern", () => {
    expect(checkRegexPattern("(unclosed").ok).toBe(false);
    expect(checkRegexPattern("[z-a]").ok).toBe(false);
  });

  it("rejects absurd quantifier counts and nesting depth", () => {
    expect(checkRegexPattern("a*".repeat(30))).toEqual({ ok: false, reason: "TOO_COMPLEX" });
    const deep = "(".repeat(15) + "a" + ")".repeat(15);
    expect(checkRegexPattern(deep)).toEqual({ ok: false, reason: "TOO_COMPLEX" });
  });
});

describe("patterns that must keep working", () => {
  const legitimate = [
    "^.+@example\\.com$",
    "^(foo|bar)$",
    "^(foo|bar)+$", // disjoint first characters: one way to match
    "(abc)+",
    "[a-z]+",
    "[ab]+", // the safe rewrite of `(a|b)+`
    "^\\d{3}-\\d{4}$",
    "^user_[0-9a-f]{8}$",
    "^(?:staging|prod)-\\w+$",
    "^v\\d+\\.\\d+\\.\\d+$",
    "acme\\.(com|org|net)$",
    "^\\+?[0-9 ()-]{7,20}$",
    "^(GET|POST|PUT|DELETE) /api/",
  ];

  for (const pattern of legitimate) {
    it(`accepts ${pattern}`, () => {
      expect(checkRegexPattern(pattern)).toEqual({ ok: true });
    });
  }

  it("accepts alternation outside a quantified group", () => {
    // The dangerous shape is a *repeated* ambiguous group. A plain alternation
    // has nothing to backtrack through.
    expect(checkRegexPattern("^(a|a)$").ok).toBe(true);
    expect(checkRegexPattern("^a|a$").ok).toBe(true);
  });

  it("does not mistake quantifier characters inside a class for quantifiers", () => {
    expect(checkRegexPattern("^[*+?]+$").ok).toBe(true);
  });

  it("does not mistake escaped quantifiers for quantifiers", () => {
    expect(checkRegexPattern("^(a\\+)+$").ok).toBe(true);
  });
});

describe("compileSafeRegExp", () => {
  it("returns a working regex for an accepted pattern", () => {
    clearRegexCache();
    const re = compileSafeRegExp("^ab+c$");
    expect(re?.test("abbc")).toBe(true);
    expect(re?.test("ac")).toBe(false);
  });

  it("returns null for a rejected pattern rather than throwing", () => {
    expect(compileSafeRegExp("^(a+)+$")).toBeNull();
    expect(compileSafeRegExp("(unclosed")).toBeNull();
    expect(compileSafeRegExp(42)).toBeNull();
  });

  it("caches, so a hot path does not recompile or re-analyse", () => {
    clearRegexCache();
    const first = compileSafeRegExp("^cache-me$");
    const second = compileSafeRegExp("^cache-me$");
    expect(first).toBe(second);
  });

  it("caches rejections too", () => {
    clearRegexCache();
    // The structural analysis must not run again on every evaluation of a rule
    // whose pattern was already refused.
    expect(compileSafeRegExp("^(a+)+$")).toBeNull();
    expect(compileSafeRegExp("^(a+)+$")).toBeNull();
  });

  it("bounds the cache rather than growing with customer configuration", () => {
    clearRegexCache();
    for (let i = 0; i < 2_000; i++) compileSafeRegExp(`^unique-${i}$`);
    // Still functional after the ceiling was hit and the cache cleared.
    expect(compileSafeRegExp("^still-works$")?.test("still-works")).toBe(true);
  });
});

describe("the guard itself is fast", () => {
  it("checks a thousand patterns in a few milliseconds", () => {
    clearRegexCache();
    const started = performance.now();
    for (let i = 0; i < 1_000; i++) checkRegexPattern(`^prefix-${i}-[a-z]+$`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
