import { describe, expect, it } from "vitest";
import { HASH_SPACE, WEIGHT_SCALE, bucket, bucketFromHash, validateRolloutWeights } from "../../src/sdk/evaluation/bucketing.js";
import { murmur3Utf8 } from "../../src/sdk/evaluation/murmur3.js";

const SALT = "env_salt_prod";

describe("bucketFromHash — exact integer division", () => {
  // Hand-computed from floor(raw * 100000 / 2^32). Not captured from the code.
  it.each([
    [0x00000000, 0],
    [0x80000000, 50_000], // 2^31 * 100000 / 2^32 == 50000 exactly
    [0xffffffff, 99_999], // 429496729500000 / 4294967296 == 99999.99997 -> 99999
    [429_496_730, 10_000], // 42949673000000 / 4294967296 == 10000.0000093 -> 10000
    [429_496_729, 9_999], // one below the 10% boundary
  ])("maps raw 0x%s to bucket %i", (raw, expected) => {
    expect(bucketFromHash(raw)).toBe(expected);
  });

  it("never exceeds MAX_SAFE_INTEGER in the intermediate product", () => {
    // The whole reason weights are 100_000 and not, say, 10^12: a Go or Java
    // port must compute this identically with native integers.
    expect((HASH_SPACE - 1) * WEIGHT_SCALE).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("stays in [0, 99999] across the entire hash space", () => {
    for (let raw = 0; raw < HASH_SPACE; raw += 0x00100000) {
      const b = bucketFromHash(raw);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(WEIGHT_SCALE);
      expect(Number.isInteger(b)).toBe(true);
    }
    expect(bucketFromHash(HASH_SPACE - 1)).toBe(WEIGHT_SCALE - 1);
  });
});

describe("bucket — hash input composition", () => {
  it("hashes exactly `${prefix}.${salt}.${value}` as UTF-8", () => {
    // The spelling is frozen; a port reads this assertion, not the source.
    expect(bucket("usr_123", "new-checkout", SALT)).toBe(
      bucketFromHash(murmur3Utf8("new-checkout.env_salt_prod.usr_123")),
    );
  });

  it("is deterministic across calls", () => {
    const a = bucket("usr_123", "new-checkout", SALT);
    for (let i = 0; i < 100; i++) expect(bucket("usr_123", "new-checkout", SALT)).toBe(a);
  });

  it("uses `seed` in place of the flag key when supplied", () => {
    expect(bucket("usr_123", "new-checkout", SALT, 42)).toBe(
      bucketFromHash(murmur3Utf8("42.env_salt_prod.usr_123")),
    );
  });

  it("distinguishes seed 0 from an absent seed", () => {
    // `seed: 0` is a legitimate frozen experiment seed. A truthiness check here
    // would silently fall back to the flag key and re-randomise the experiment.
    expect(bucket("usr_123", "new-checkout", SALT, 0)).toBe(
      bucketFromHash(murmur3Utf8("0.env_salt_prod.usr_123")),
    );
    expect(bucket("usr_123", "new-checkout", SALT, 0)).not.toBe(
      bucket("usr_123", "new-checkout", SALT),
    );
  });

  it("buckets non-ASCII keys by UTF-8 bytes", () => {
    expect(bucket("usr_josé", "f", SALT)).toBe(bucketFromHash(murmur3Utf8("f.env_salt_prod.usr_josé")));
  });
});

describe("bucket — the independence properties rollouts depend on", () => {
  const keys = Array.from({ length: 200_000 }, (_, i) => `usr_${i}`);
  const at10 = (flagKey: string, salt: string) =>
    new Set(keys.filter((k) => bucket(k, flagKey, salt) < 10_000));

  it("does not roll two 10% flags out to the same 10% of users", () => {
    const a = at10("flag-a", SALT);
    const b = at10("flag-b", SALT);
    // Independent 10% samples of 200k overlap on ~2,000 (200000 * 0.1 * 0.1).
    // Without flagKey in the hash this would be a perfect 20,000 overlap.
    const overlap = [...a].filter((k) => b.has(k)).length;
    expect(overlap).toBeGreaterThan(1_700);
    expect(overlap).toBeLessThan(2_350);
  });

  it("does not roll out to the same users in staging as in production", () => {
    const prod = at10("flag-a", "salt_production");
    const stage = at10("flag-a", "salt_staging");
    const overlap = [...prod].filter((k) => stage.has(k)).length;
    expect(overlap).toBeGreaterThan(1_700);
    expect(overlap).toBeLessThan(2_350);
  });

  it("distributes uniformly: a 10% rollout lands within +/-0.5%", () => {
    const inRollout = keys.filter((k) => bucket(k, "flag-a", SALT) < 10_000).length;
    const pct = (inRollout / keys.length) * 100;
    expect(pct).toBeGreaterThan(9.5);
    expect(pct).toBeLessThan(10.5);
  });

  it("distributes uniformly across all ten deciles", () => {
    const deciles = new Array(10).fill(0);
    for (const k of keys) deciles[Math.floor(bucket(k, "flag-a", SALT) / 10_000)]!++;
    for (const count of deciles) {
      expect(count / keys.length).toBeGreaterThan(0.095);
      expect(count / keys.length).toBeLessThan(0.105);
    }
  });
});

describe("validateRolloutWeights", () => {
  it("returns true when weights sum to 100,000", () => {
    expect(
      validateRolloutWeights({
        variations: [
          { variationIndex: 0, weight: 50_000 },
          { variationIndex: 1, weight: 50_000 },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when weights underflow 100,000", () => {
    expect(
      validateRolloutWeights({
        variations: [{ variationIndex: 1, weight: 5_000 }],
      }),
    ).toBe(false);
  });

  it("returns false when weights overflow 100,000", () => {
    expect(
      validateRolloutWeights({
        variations: [
          { variationIndex: 0, weight: 60_000 },
          { variationIndex: 1, weight: 50_000 },
        ],
      }),
    ).toBe(false);
  });

  it("returns false for empty variations", () => {
    expect(validateRolloutWeights({ variations: [] })).toBe(false);
  });
});
