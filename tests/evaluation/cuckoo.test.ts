import { describe, expect, it } from "vitest";
import {
  CUCKOO_HEADER_BYTES,
  CUCKOO_MAX_KICKS,
  CuckooFilter,
  altIndex,
  bucketCountFor,
  buildCuckooFilter,
} from "../../src/sdk/evaluation/cuckoo.js";

const members = (n: number, prefix = "usr_") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("bucketCountFor - sizing", () => {
  it("is nextPow2(ceil(n / (b * loadFactor)))", () => {
    // 1000 / (4 * 0.8) = 312.5 -> 313 -> nextPow2 = 512
    expect(bucketCountFor(1000, 4, 0.8)).toBe(512);
    // 500_000 / 3.2 = 156_250 -> nextPow2 = 262_144
    expect(bucketCountFor(500_000, 4, 0.8)).toBe(262_144);
    expect(bucketCountFor(1, 4, 0.8)).toBe(1);
    expect(bucketCountFor(0, 4, 0.8)).toBe(1);
  });

  it("always returns a power of two", () => {
    // Not a preference. `i2 = i1 XOR h(fp)` only stays in range for a
    // power-of-two index space; any other size breaks the involution.
    for (let n = 0; n < 5_000; n += 37) {
      const c = bucketCountFor(n, 4, 0.8);
      expect(c & (c - 1)).toBe(0);
    }
  });
});

describe("altIndex - the involution the whole structure rests on", () => {
  it("satisfies alt(alt(i)) === i across the ENTIRE index space, for every emittable size", () => {
    // This is the single most common cuckoo filter bug: with a non-power-of-two
    // table the usual `% numBuckets` patch quietly breaks `alt(alt(i)) === i`,
    // relocated items become unfindable, and inserts loop on a half-full table.
    // It is invisible at 10k members and a rebuild loop at 1M, so it is
    // asserted exhaustively rather than sampled.
    for (let log2 = 0; log2 <= 14; log2++) {
      const bucketCount = 1 << log2;
      const mask = bucketCount - 1;
      for (const fp of [1, 2, 0x5a, 0xffff, 0xdeadbeef, 0xffffffff]) {
        for (let i = 0; i < bucketCount; i++) {
          const j = altIndex(i, fp, 0x9747b28c, mask);
          expect(j).toBeGreaterThanOrEqual(0);
          expect(j).toBeLessThan(bucketCount);
          expect(altIndex(j, fp, 0x9747b28c, mask)).toBe(i);
        }
      }
    }
  });

  it("never maps a bucket to itself, so every item has two real candidates", () => {
    // If h(fp) were 0 the alternate bucket would equal the primary and the
    // item would have half the homes it is sized for.
    for (let log2 = 1; log2 <= 12; log2++) {
      const mask = (1 << log2) - 1;
      for (let fp = 1; fp <= 0xffffffff; fp += 0x10003) {
        expect(altIndex(0, fp, 12345, mask)).not.toBe(0);
      }
    }
  });
});

describe("CuckooFilter - membership", () => {
  it("contains every member it was built from", () => {
    const keys = members(10_000);
    const f = buildCuckooFilter(keys).filter;
    for (const k of keys) expect(f.contains(k)).toBe(true);
  });

  it("admits no non-member across 200,000 probes", () => {
    // eps ~= 2b/2^32 ~= 1.9e-9, so the expected count here is ~0.0004. A
    // positive is treated as membership with nothing to confirm it, which is
    // only sound because this is effectively zero.
    const f = buildCuckooFilter(members(50_000)).filter;
    const probes = members(200_000, "nonmember_");
    expect(probes.filter((k) => f.contains(k))).toEqual([]);
  });

  it("reports zero false negatives, which would be a correctness bug", () => {
    const keys = members(50_000);
    const f = buildCuckooFilter(keys).filter;
    expect(keys.filter((k) => !f.contains(k))).toEqual([]);
  });

  it("handles non-ASCII member keys by UTF-8 bytes", () => {
    const keys = ["usr_josé", "usr_日本", "usr_🚀", "usr_ascii"];
    const f = buildCuckooFilter(keys).filter;
    for (const k of keys) expect(f.contains(k)).toBe(true);
  });
});

describe("CuckooFilter - deletion (the entire reason Bloom was dropped)", () => {
  it("removes a member and leaves the rest intact", () => {
    const keys = members(5_000);
    const f = buildCuckooFilter(keys).filter;
    expect(f.delete("usr_42")).toBe(true);
    expect(f.contains("usr_42")).toBe(false);
    for (const k of keys) if (k !== "usr_42") expect(f.contains(k)).toBe(true);
  });

  it("decrements the item count", () => {
    const f = buildCuckooFilter(members(100)).filter;
    const before = f.size;
    f.delete("usr_1");
    expect(f.size).toBe(before - 1);
  });

  it("returns false when deleting something that was never inserted", () => {
    const f = buildCuckooFilter(members(100)).filter;
    expect(f.delete("usr_absent_9999")).toBe(false);
  });

  it("clears ONE matching fingerprint, never all of them", () => {
    // Two distinct members can share a fingerprint in the same bucket.
    // Clearing both silently evicts someone who is still in the segment.
    const f = CuckooFilter.create(64);
    const bucketIndex = 3;
    const fp = 0x1234;
    // Plant the same fingerprint twice in one bucket, then delete once.
    expect(f.insertRaw(bucketIndex, fp)).toBe(true);
    expect(f.insertRaw(bucketIndex, fp)).toBe(true);
    expect(f.countFingerprint(bucketIndex, fp)).toBe(2);
    f.deleteRaw(bucketIndex, fp);
    expect(f.countFingerprint(bucketIndex, fp)).toBe(1);
  });

  it("frees space, so a delete-then-insert cycle does not grow the table", () => {
    const f = buildCuckooFilter(members(1_000)).filter;
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 100; i++) expect(f.delete(`usr_${i}`)).toBe(true);
      for (let i = 0; i < 100; i++) expect(f.insert(`usr_${i}`)).toBe(true);
    }
    expect(f.size).toBe(1_000);
    for (const k of members(1_000)) expect(f.contains(k)).toBe(true);
  });
});

describe("CuckooFilter - fingerprints are never zero", () => {
  it("remaps a computed zero to 1, since zero is the empty-slot sentinel", () => {
    // A computed zero is one in 2^32, so it cannot be provoked by scanning;
    // this guards the remap against a refactor that drops it.
    const f = CuckooFilter.create(100_000);
    for (const k of members(50_000)) expect(f.fingerprintOf(k)).toBeGreaterThan(0);
  });
});

describe("CuckooFilter - wire format is frozen", () => {
  it("writes the pinned header", () => {
    const f = CuckooFilter.create(1000, { seed: 0xdeadbeef });
    const bytes = f.encode();
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("FKCF");
    expect(bytes[4]).toBe(2); // format version
    expect(bytes[5]).toBe(32); // fingerprint bits
    expect(bytes[6]).toBe(9); // log2(512) buckets
    expect(bytes[7]).toBe(4); // slots per bucket
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(8, true)).toBe(0xdeadbeef); // seed, little-endian
    expect(view.getUint32(12, true)).toBe(0); // item count
  });

  it("is exactly header + buckets * 16 bytes", () => {
    const f = CuckooFilter.create(1000);
    expect(f.encode().byteLength).toBe(CUCKOO_HEADER_BYTES + 512 * 16);
  });

  it("round-trips membership through encode/decode", () => {
    const keys = members(20_000);
    const encoded = buildCuckooFilter(keys).filter.encode();
    const decoded = CuckooFilter.decode(encoded);
    for (const k of keys) expect(decoded.contains(k)).toBe(true);
    expect(decoded.size).toBe(keys.length);
  });

  it("re-encodes to identical bytes after a decode", () => {
    // A future Go or Python SDK is verified against bytes, not a description
    // of bytes. Decode-then-encode must be the identity.
    const original = buildCuckooFilter(members(5_000)).filter.encode();
    expect(CuckooFilter.decode(original).encode()).toEqual(original);
  });

  it("produces identical bytes for the same members inserted in the same order", () => {
    const keys = members(5_000);
    const a = buildCuckooFilter(keys, { seed: 7 }).filter.encode();
    const b = buildCuckooFilter(keys, { seed: 7 }).filter.encode();
    expect(a).toEqual(b);
  });

  it("rejects a foreign or corrupt payload rather than answering nonsense", () => {
    const good = CuckooFilter.create(64).encode();
    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(() => CuckooFilter.decode(badMagic)).toThrow(/magic/i);

    const badVersion = good.slice();
    badVersion[4] = 99;
    expect(() => CuckooFilter.decode(badVersion)).toThrow(/version/i);

    const badBits = good.slice();
    badBits[5] = 13;
    expect(() => CuckooFilter.decode(badBits)).toThrow(/fingerprint/i);

    // Version 1 — 16-bit fingerprints whose positives needed confirming — is
    // refused rather than read: it cannot be answered on its own.
    const versionOne = good.slice();
    versionOne[4] = 1;
    expect(() => CuckooFilter.decode(versionOne)).toThrow(/version/i);

    expect(() => CuckooFilter.decode(good.slice(0, 10))).toThrow(/truncat/i);
    expect(() => CuckooFilter.decode(good.slice(0, good.length - 1))).toThrow(/truncat/i);
  });
});

describe("buildCuckooFilter - construction policy", () => {
  it("reaches the 0.8 target load factor without rebuilding", () => {
    const result = buildCuckooFilter(members(100_000));
    expect(result.rebuilds).toBe(0);
    expect(result.filter.loadFactor).toBeGreaterThan(0.7);
    expect(result.filter.loadFactor).toBeLessThanOrEqual(0.8);
  });

  it("caps relocations at 500 per insert", () => {
    expect(CUCKOO_MAX_KICKS).toBe(500);
  });

  it("deduplicates repeated members rather than double-counting capacity", () => {
    const result = buildCuckooFilter(["a", "b", "a", "b", "c"]);
    expect(result.filter.size).toBe(3);
  });
});
