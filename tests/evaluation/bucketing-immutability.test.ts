/**
 * The bucketing corpus is frozen.
 *
 * **This test exists to fail.** If someone changes the hash, the seed handling,
 * the salt composition, the string encoding, or `WEIGHT_SCALE`, every
 * percentage rollout in every customer's production environment silently
 * re-assigns. Users in a 10% rollout leave it; users outside it enter. Nothing
 * errors, no alert fires, and the first symptom is a support ticket about a
 * feature that "turned itself off" — weeks later, for a change made in a
 * refactor that looked purely internal.
 *
 * The corpus in `bucketing-golden.json` was generated once and is committed.
 * It is not a snapshot to be updated when it fails: **a failure here means the
 * change is wrong**, unless someone has consciously decided to re-bucket every
 * production population, in which case that decision belongs in
 * `docs/decisions.md` and this file is regenerated deliberately.
 *
 * The corpus deliberately includes the cases where an implementation is most
 * likely to drift on a port to another language: multi-byte UTF-8, emoji
 * outside the BMP, leading zeros (`"07"` vs `"7"`), the empty salt, seed `0`,
 * and both ends of the hash space.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bucket,
  bucketFromHash,
  HASH_SPACE,
  WEIGHT_SCALE,
} from "../../src/sdk/evaluation/bucketing.js";
import { murmur3Utf8 } from "../../src/sdk/evaluation/murmur3.js";

interface Golden {
  rows: Array<{ flagKey: string; salt: string; key: string; seed?: number; bucket: number }>;
  hashes: Array<{ input: string; hash: number }>;
  edges: Array<{ raw: number; bucket: number }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "bucketing-golden.json"), "utf8")) as Golden;

describe("the frozen bucketing corpus", () => {
  it("has not moved", () => {
    const drifted: string[] = [];
    for (const row of golden.rows) {
      const actual = bucket(row.key, row.flagKey, row.salt, row.seed);
      if (actual !== row.bucket) {
        drifted.push(
          `${row.flagKey}/${row.salt}/${row.key}${row.seed === undefined ? "" : `/seed=${row.seed}`}: ` +
            `expected ${row.bucket}, got ${actual}`,
        );
      }
    }
    expect(
      drifted,
      "Bucketing changed. Every percentage rollout in production has just been " +
        "re-randomised. If that was intentional, record it in docs/decisions.md " +
        "and regenerate the corpus deliberately.",
    ).toEqual([]);
  });

  it("covers the cases a port is most likely to get wrong", () => {
    const keys = new Set(golden.rows.map((r) => r.key));
    expect(keys.has("用户-1")).toBe(true); // multi-byte UTF-8
    expect(keys.has("🎉-user")).toBe(true); // outside the BMP, surrogate pair
    expect(keys.has("0")).toBe(true);
    expect(keys.has("00")).toBe(true); // leading zeros are a distinct key
    expect(keys.has("07")).toBe(true);
    expect(golden.rows.some((r) => r.salt === "")).toBe(true);
    expect(golden.rows.some((r) => r.seed === 0)).toBe(true);
    expect(golden.rows.length).toBeGreaterThan(100);
  });

  it("keeps the murmur3 vectors frozen", () => {
    for (const { input, hash } of golden.hashes) {
      expect(murmur3Utf8(input), `murmur3(${JSON.stringify(input)})`).toBe(hash);
    }
  });

  it("keeps the hash-to-bucket mapping frozen at both ends", () => {
    for (const { raw, bucket: expected } of golden.edges) {
      expect(bucketFromHash(raw), `bucketFromHash(${raw})`).toBe(expected);
    }
  });
});

describe("the constants the corpus depends on", () => {
  it("still uses a 100,000-unit weight scale", () => {
    // Changing this rescales every stored weight in every database.
    expect(WEIGHT_SCALE).toBe(100_000);
  });

  it("still maps a 32-bit hash space", () => {
    expect(HASH_SPACE).toBe(2 ** 32);
  });

  it("produces buckets strictly inside [0, 99999]", () => {
    expect(bucketFromHash(0)).toBe(0);
    expect(bucketFromHash(HASH_SPACE - 1)).toBe(WEIGHT_SCALE - 1);
    // The intermediate product must stay exact: (2^32-1) * 100000 is ~4.29e14,
    // inside MAX_SAFE_INTEGER, which is what lets a Go or Java port use int64
    // with no BigInt and no floating point.
    expect((HASH_SPACE - 1) * WEIGHT_SCALE).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe("the properties the corpus is protecting", () => {
  it("gives two flags at the same weight different populations", () => {
    // Without the flag key in the hash, every "independent" rollout is
    // perfectly correlated and you draw conclusions from one population.
    let same = 0;
    for (let i = 0; i < 2_000; i++) {
      const key = `user-${i}`;
      if (bucket(key, "flag-a", "salt") === bucket(key, "flag-b", "salt")) same++;
    }
    expect(same).toBeLessThan(20);
  });

  it("gives the same flag different populations per environment", () => {
    let same = 0;
    for (let i = 0; i < 2_000; i++) {
      const key = `user-${i}`;
      if (bucket(key, "flag", "prod-salt") === bucket(key, "flag", "staging-salt")) same++;
    }
    expect(same).toBeLessThan(20);
  });

  it("treats seed 0 as a real seed, not as absent", () => {
    // `seed !== undefined`, never a truthiness check. Falling back to the flag
    // key for seed 0 would re-randomise a running experiment.
    expect(bucket("user-1", "flag", "salt", 0)).not.toBe(bucket("user-1", "flag", "salt"));
    expect(bucket("user-1", "flag", "salt", 0)).toBe(bucket("user-1", "other-flag", "salt", 0));
  });

  it("distinguishes keys that differ only by leading zeros", () => {
    // `"07"` and `"7"` are distinct context keys. A roaring bitmap keyed on the
    // integer value would answer identically for both, which is why the
    // ordinal regex excludes leading zeros (docs/decisions.md §9).
    expect(bucket("07", "flag", "salt")).not.toBe(bucket("7", "flag", "salt"));
  });

  it("is stable across repeated calls and object identity", () => {
    const first = bucket("user-1", "flag", "salt");
    for (let i = 0; i < 100; i++) expect(bucket("user-1", "flag", "salt")).toBe(first);
  });
});
