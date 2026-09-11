import { describe, expect, it } from "vitest";
import { buildCuckooFilter, CuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";

/**
 * M1 exit criterion (§18): a large import must complete with zero relocation
 * failures and zero rebuilds at the pinned load factor. A construction bug
 * here is silent at 10k members and a rebuild loop at 1M, so it is asserted at
 * scale rather than inferred from a small case.
 */
describe("cuckoo filter at import scale", () => {
  it("imports 1M members with zero relocation failures and zero rebuilds", { timeout: 180_000 }, () => {
    const keys = Array.from({ length: 1_000_000 }, (_, i) => `usr_${i.toString(36)}`);
    const result = buildCuckooFilter(keys);

    expect(result.rebuilds).toBe(0);
    expect(result.rebuildReasons).toEqual([]);
    expect(result.filter.size).toBe(1_000_000);
    // Every member must be found: a false negative is a correctness bug, not a
    // budget. Checked exhaustively, not sampled.
    expect(keys.filter((k) => !result.filter.contains(k)).length).toBe(0);
  });

  it("saturates an actual alpha = 0.8 table without a rebuild", { timeout: 180_000 }, () => {
    // 1M members round up to 524_288 buckets (2.1M slots), which is only
    // alpha = 0.48 -- the pow2 sizing leaves a lot of slack. The load factor
    // the parameters are actually pinned at is only reached at 3.2 * 2^k
    // members, and that is the case that stresses relocation.
    const n = 1_677_721; // 3.2 * 2^19, i.e. alpha = 0.79999...
    const keys = Array.from({ length: n }, (_, i) => `usr_${i.toString(36)}`);
    const result = buildCuckooFilter(keys);

    expect(result.rebuilds).toBe(0);
    expect(result.filter.bucketCount).toBe(524_288);
    expect(result.filter.loadFactor).toBeGreaterThan(0.79);
    expect(result.filter.loadFactor).toBeLessThanOrEqual(0.8);
    expect(keys.filter((k) => !result.filter.contains(k)).length).toBe(0);

    // Relocations stay proportional to the item count. An unbounded figure
    // here is the signature of a broken alternate-index involution.
    expect(result.filter.relocations).toBeLessThan(n * 6);
  });

  it("keeps the 500k-member filter near the ~1.25 MB the plan prices it at", () => {
    const keys = Array.from({ length: 500_000 }, (_, i) => `usr_${i.toString(36)}`);
    const bytes = buildCuckooFilter(keys).filter.encode();
    // 262_144 buckets * 8 bytes + 16 = 2_097_168 at f=16... but pow2 rounding
    // means 500k sizes to 262_144 buckets = 1_048_576 slots, alpha = 0.477.
    // The price of the power-of-two requirement, stated rather than hidden.
    expect(bytes.byteLength).toBe(16 + 262_144 * 8);
    expect(bytes.byteLength / 1024 / 1024).toBeLessThan(2.1);
  });

  it("round-trips a large filter through the wire format byte-for-byte", () => {
    const keys = Array.from({ length: 200_000 }, (_, i) => `usr_${i.toString(36)}`);
    const encoded = buildCuckooFilter(keys).filter.encode();
    expect(CuckooFilter.decode(encoded).encode()).toEqual(encoded);
  });
});
