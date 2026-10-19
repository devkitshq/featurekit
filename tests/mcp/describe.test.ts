/**
 * The arithmetic and the reading of loose phrases, without a server.
 *
 * "Roll out cart v2 page to 20%" has to become the right flag, the right
 * weights and — when the rollout already exists — the same people plus more,
 * not a reshuffle.
 */

import { describe, expect, it } from "vitest";
import {
  buildRollout,
  matchScore,
  percentToWeight,
  resolveVariation,
} from "../../packages/mcp/src/index.js";
import type { Variation } from "../../packages/mcp/src/index.js";

const bool: Variation[] = [
  { idx: 0, name: "off", value: false },
  { idx: 1, name: "on", value: true },
];

describe("percentToWeight", () => {
  it("speaks weights out of 100,000", () => {
    expect(percentToWeight(20)).toBe(20_000);
    expect(percentToWeight(0.5)).toBe(500);
    expect(percentToWeight(12.345)).toBe(12_345);
    expect(percentToWeight(100)).toBe(100_000);
  });

  it("refuses what is not a percentage", () => {
    expect(() => percentToWeight(120)).toThrow(RangeError);
    expect(() => percentToWeight(-1)).toThrow(RangeError);
    expect(() => percentToWeight(Number.NaN)).toThrow(RangeError);
  });
});

describe("buildRollout", () => {
  it("serves the percentage to the rolled-out variation and the rest to the other", () => {
    expect(buildRollout(undefined, 1, 0, 20)).toEqual({
      variations: [
        { variation: 1, weight: 20_000 },
        { variation: 0, weight: 80_000 },
      ],
    });
  });

  it("keeps the existing order and bucketing, so raising it adds people rather than reshuffling", () => {
    const existing = {
      bucketBy: "accountId",
      seed: 7,
      variations: [
        { variationIndex: 0, weight: 90_000 },
        { variationIndex: 1, weight: 10_000 },
      ],
    };
    expect(buildRollout(existing, 1, 0, 20)).toEqual({
      bucketBy: "accountId",
      seed: 7,
      variations: [
        { variation: 0, weight: 80_000 },
        { variation: 1, weight: 20_000 },
      ],
    });
  });
});

describe("resolveVariation", () => {
  it("means true for a boolean flag when nothing is said", () => {
    expect(resolveVariation(bool, "boolean", undefined).idx).toBe(1);
  });

  it("accepts a value, a name, an index or a spelled boolean", () => {
    expect(resolveVariation(bool, "boolean", false).idx).toBe(0);
    expect(resolveVariation(bool, "boolean", "on").idx).toBe(1);
    expect(resolveVariation(bool, "boolean", "False").idx).toBe(0);
    const colours: Variation[] = [
      { idx: 0, name: null, value: "red" },
      { idx: 1, name: "Ocean", value: "blue" },
    ];
    expect(resolveVariation(colours, "string", "blue").idx).toBe(1);
    expect(resolveVariation(colours, "string", "ocean").idx).toBe(1);
    expect(resolveVariation(colours, "string", 0).idx).toBe(0);
  });

  it("asks rather than guessing for a multivariate flag", () => {
    const colours: Variation[] = [
      { idx: 0, name: null, value: "red" },
      { idx: 1, name: null, value: "blue" },
    ];
    expect(() => resolveVariation(colours, "string", undefined)).toThrow(/say which one/);
    expect(() => resolveVariation(colours, "string", "green")).toThrow(/no variation matches/);
  });
});

describe("matchScore", () => {
  const flags = [
    { key: "cart-v2-page", name: "Cart v2 page" },
    { key: "cart-v2-checkout", name: "Cart v2 checkout" },
    { key: "newSearch", name: "Search rewrite" },
  ];
  const best = (query: string) =>
    flags
      .map((f) => ({ key: f.key, score: matchScore(query, f) }))
      .sort((a, b) => b.score - a.score)[0]!;

  it("finds a flag the way people name it", () => {
    expect(best("cart v2 page")).toEqual({ key: "cart-v2-page", score: 100 });
    expect(best("Cart V2 Page").key).toBe("cart-v2-page");
    expect(best("new search").key).toBe("newSearch");
  });

  it("scores a partial phrase below an exact one", () => {
    expect(matchScore("cart v2", flags[0]!)).toBeLessThan(100);
    expect(matchScore("cart v2", flags[0]!)).toBe(matchScore("cart v2", flags[1]!));
    expect(matchScore("billing", flags[0]!)).toBe(0);
  });
});
