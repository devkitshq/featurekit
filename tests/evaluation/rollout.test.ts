import { describe, expect, it } from "vitest";
import { assignBucket, bucket, resolveRollout } from "../../src/sdk/evaluation/bucketing.js";
import { normalizeContext } from "../../src/sdk/evaluation/context.js";
import type { EvaluationContext, Rollout } from "../../src/sdk/evaluation/types.js";

const SALT = "env_salt_prod";
const norm = (c: EvaluationContext) => normalizeContext(c)!;

const fiftyFifty: Rollout = { variations: [{ variationIndex: 0, weight: 50_000 }, { variationIndex: 1, weight: 50_000 }] };
const tenPercent: Rollout = { variations: [{ variationIndex: 1, weight: 10_000 }, { variationIndex: 0, weight: 90_000 }] };

describe("assignBucket — boundaries are exact integers", () => {
  it("assigns on `b < cursor`, so each boundary belongs to the later variation", () => {
    expect(assignBucket(tenPercent, 0)).toBe(1);
    expect(assignBucket(tenPercent, 9_999)).toBe(1);
    expect(assignBucket(tenPercent, 10_000)).toBe(0); // the boundary itself
    expect(assignBucket(tenPercent, 99_999)).toBe(0);
  });

  it("keeps twenty 5,000-unit boundaries exact", () => {
    // Accumulating `weight / 100_000` as floats sums to 1.0000000000000002 and
    // puts every intermediate boundary off by an ULP. Integers cannot.
    const twenty: Rollout = {
      variations: Array.from({ length: 20 }, (_, i) => ({ variationIndex: i, weight: 5_000 })),
    };
    for (let i = 0; i < 20; i++) {
      expect(assignBucket(twenty, i * 5_000)).toBe(i);
      expect(assignBucket(twenty, i * 5_000 + 4_999)).toBe(i);
    }
    expect(assignBucket(twenty, 99_999)).toBe(19);
  });

  it("returns null when weights underflow 100,000 rather than dumping users into the last variation", () => {
    // Unallocated buckets must not silently dump everyone into the last variation
    const short: Rollout = { variations: [{ variationIndex: 0, weight: 1 }, { variationIndex: 3, weight: 1 }] };
    expect(assignBucket(short, 0)).toBe(0);
    expect(assignBucket(short, 1)).toBe(3);
    expect(assignBucket(short, 2)).toBeNull();
    expect(assignBucket(short, 99_999)).toBeNull();
  });

  it("returns null for a rollout with no variations", () => {
    expect(assignBucket({ variations: [] }, 0)).toBeNull();
  });

  it("ignores zero-weight variations entirely", () => {
    const withZero: Rollout = {
      variations: [
        { variationIndex: 7, weight: 0 },
        { variationIndex: 0, weight: 100_000 },
      ],
    };
    for (const b of [0, 1, 50_000, 99_999]) expect(assignBucket(withZero, b)).toBe(0);
  });
});

describe("resolveRollout", () => {
  it("buckets on the user key by default", () => {
    const ctx = norm({ key: "usr_123" });
    const expected = assignBucket(fiftyFifty, bucket("usr_123", "f", SALT));
    expect(resolveRollout(fiftyFifty, ctx, "f", SALT)).toBe(expected);
  });

  it("buckets on the rollout's context kind, flipping a whole org together", () => {
    const ctx = norm({ kind: "multi", user: { key: "usr_1" }, organization: { key: "org_9" } });
    const byOrg: Rollout = { ...fiftyFifty, contextKind: "organization" };
    expect(resolveRollout(byOrg, ctx, "f", SALT)).toBe(
      assignBucket(fiftyFifty, bucket("org_9", "f", SALT)),
    );
  });

  it("every user in an org lands in the same variation when bucketing by org", () => {
    const byOrg: Rollout = { ...fiftyFifty, contextKind: "organization" };
    const results = new Set(
      Array.from({ length: 500 }, (_, i) =>
        resolveRollout(
          byOrg,
          norm({ kind: "multi", user: { key: `usr_${i}` }, organization: { key: "org_9" } }),
          "f",
          SALT,
        ),
      ),
    );
    expect(results.size).toBe(1);
  });

  it("buckets on `bucketBy` when given", () => {
    const ctx = norm({ key: "usr_1", accountId: "acct_5" });
    const byAccount: Rollout = { ...fiftyFifty, bucketBy: "accountId" };
    expect(resolveRollout(byAccount, ctx, "f", SALT)).toBe(
      assignBucket(fiftyFifty, bucket("acct_5", "f", SALT)),
    );
  });

  it("returns null — excluded — when the bucketing value is missing", () => {
    const ctx = norm({ key: "usr_1" });
    expect(resolveRollout({ ...fiftyFifty, bucketBy: "accountId" }, ctx, "f", SALT)).toBeNull();
    expect(resolveRollout({ ...fiftyFifty, contextKind: "device" }, ctx, "f", SALT)).toBeNull();
  });

  it("honours a frozen seed, so editing the flag cannot re-randomise it", () => {
    const ctx = norm({ key: "usr_123" });
    const seeded: Rollout = { ...fiftyFifty, seed: 42 };
    expect(resolveRollout(seeded, ctx, "flag-a", SALT)).toBe(
      resolveRollout(seeded, ctx, "flag-b-renamed", SALT),
    );
  });

  it("splits 50/50 within tolerance over 100k contexts", () => {
    let zero = 0;
    for (let i = 0; i < 100_000; i++) {
      if (resolveRollout(fiftyFifty, norm({ key: `usr_${i}` }), "f", SALT) === 0) zero++;
    }
    expect(zero / 100_000).toBeGreaterThan(0.495);
    expect(zero / 100_000).toBeLessThan(0.505);
  });

  it("is stable when an unrelated flag's rollout changes", () => {
    const ctx = norm({ key: "usr_123" });
    const before = resolveRollout(fiftyFifty, ctx, "f", SALT);
    const otherFlagChanged: Rollout = { variations: [{ variationIndex: 0, weight: 30_000 }, { variationIndex: 1, weight: 70_000 }] };
    resolveRollout(otherFlagChanged, ctx, "other-flag", SALT);
    expect(resolveRollout(fiftyFifty, ctx, "f", SALT)).toBe(before);
  });
});
