/**
 * Percentage rollout bucketing.
 *
 * The property that makes rollouts trustworthy: the same context always lands
 * in the same bucket — across processes, restarts, deploys, and SDK languages.
 * Everything here is integer arithmetic for that reason, and the hash is
 * frozen (see `murmur3.ts`).
 *
 * @see docs/evaluation/bucketing.md
 */

import { bucketValue } from "./context.js";
import { murmur3Utf8 } from "./murmur3.js";
import type { NormalizedContext, Rollout } from "./types.js";

/** murmur3 x86_32 output space. */
export const HASH_SPACE = 2 ** 32;

/** Rollout weights are integers out of 100,000, never floats out of 1. */
export const WEIGHT_SCALE = 100_000;

/**
 * Map a uint32 hash onto `[0, 99999]`.
 *
 * Exact integer division. The largest intermediate is
 * `(2^32 - 1) * 100000 ≈ 4.29e14`, comfortably inside `MAX_SAFE_INTEGER`
 * (9.01e15) and inside int64 — so a Go or Java port computes an identical
 * value with native integers, with no BigInt and no floating point anywhere.
 */
export function bucketFromHash(raw: number): number {
  return Math.floor((raw * WEIGHT_SCALE) / HASH_SPACE);
}

/**
 * Bucket a context value into `[0, 99999]`.
 *
 * Hashes the UTF-8 bytes of `${prefix}.${salt}.${value}`, where `prefix` is
 * the rollout's `seed` when it has one and the flag key otherwise:
 *
 * - **`flagKey` in the hash** — two flags at 10% do not roll out to the *same*
 *   10% of users. Without it your "independent" rollouts are perfectly
 *   correlated and you draw conclusions from one population.
 * - **`salt` from the environment** — the 10% in staging is not the 10% in
 *   production.
 * - **`seed` override** — an experiment can freeze its own seed and survive
 *   later edits to the flag's rollout.
 */
export function bucket(contextValue: string, flagKey: string, salt: string, seed?: number): number {
  // `seed !== undefined`, never a truthiness check: seed 0 is a valid frozen
  // seed, and falling back to the flag key for it would re-randomise a
  // running experiment.
  const prefix = seed !== undefined ? String(seed) : flagKey;
  return bucketFromHash(murmur3Utf8(`${prefix}.${salt}.${contextValue}`));
}

/**
 * Assign a bucket integer to a variation index.
 *
 * The cursor stays an integer, never a float. Twenty 5,000-unit variations sum
 * to `1.0000000000000002` in float space and every intermediate boundary is
 * off by an ULP; in integers the boundary is exact and identical in every
 * language.
 *
 * Split on `b < cursor`, so a boundary bucket belongs to the *later* variation.
 * Exported separately from `resolveRollout` so the boundary can be asserted
 * directly rather than by hunting for a context that happens to hash there.
 */
export function assignBucket(rollout: Rollout, b: number): number | null {
  let cursor = 0;
  for (const v of rollout.variations) {
    cursor += v.weight;
    if (b < cursor) return v.variationIndex;
  }
  // Weights that underflow WEIGHT_SCALE leave unallocated buckets unassigned (null).
  // Silently dumping unassigned users into the last variation is a dangerous footgun.
  return null;
}

/**
 * Check whether rollout variation weights sum to WEIGHT_SCALE (100,000).
 */
export function validateRolloutWeights(rollout: Rollout): boolean {
  if (!Array.isArray(rollout.variations) || rollout.variations.length === 0) return false;
  const total = rollout.variations.reduce((sum, v) => sum + (v.weight ?? 0), 0);
  return total === WEIGHT_SCALE;
}

/**
 * Resolve a rollout for a context, or `null` if the context cannot be bucketed.
 *
 * `null` propagates as *excluded from this rollout* — the rule does not match
 * and evaluation continues — rather than as variation 0.
 */
export function resolveRollout(
  rollout: Rollout,
  context: NormalizedContext,
  flagKey: string,
  salt: string,
): number | null {
  const value = bucketValue(context, rollout.contextKind ?? "user", rollout.bucketBy ?? "key");
  if (value === null) return null;
  return assignBucket(rollout, bucket(value, flagKey, salt, rollout.seed));
}
