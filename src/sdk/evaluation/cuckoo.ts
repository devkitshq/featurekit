/**
 * (2,4) partial-key cuckoo filter — the default large-segment membership
 * structure (§9.7).
 *
 * **This is a wire format.** The compiler writes it, every SDK reads it, and a
 * future Go or Python SDK must read the same bytes. A disagreement about
 * fingerprint width or alternate-bucket derivation does not throw — it
 * silently answers `false` for members who *are* in the segment, which
 * surfaces as "the flag didn't turn on for that customer" weeks later. Every
 * parameter below is frozen alongside the bucketing hash.
 *
 * Chosen over a Bloom filter for one reason: **Bloom cannot delete.** Removing
 * one person from a 500k-member allow-list is the single most common operation
 * on exactly this kind of segment, and with Bloom it forces a full re-encode
 * and a ~900 KB re-broadcast to every connected SDK — on the same SSE stream
 * that carries kill switches.
 *
 * Positives are probabilistic (eps ~= 0.012% at f=16) and are confirmed against
 * a resolved membership set (§9.7 step 2). Negatives are exact and final.
 *
 * @see docs/evaluation/segments.md
 */

import { murmur3Bytes, murmur3Utf8 } from "./murmur3.js";

/** Slots per bucket. The load-factor knee: b=2 saturates near 84%, b=4 reaches ~95%. */
export const SLOTS_PER_BUCKET = 4;

/** Standard. At alpha <= 0.8 with a correct construction it is never reached. */
export const CUCKOO_MAX_KICKS = 500;

/** `FKCF` + version + fpBits + bucketsLog2 + slots + seed(u32) + count(u32). */
export const CUCKOO_HEADER_BYTES = 16;

const MAGIC = [0x46, 0x4b, 0x43, 0x46] as const; // "FKCF"
const FORMAT_VERSION = 1;

/** Derives the fingerprint hash from the index hash's seed. Frozen. */
const FINGERPRINT_SEED_XOR = 0x9747b28c;
/** Derives the alternate-bucket hash's seed. Frozen. */
const ALT_SEED_XOR = 0x5bd1e995;

export type FingerprintBits = 12 | 16;

/**
 * `nextPow2(ceil(n / (b * loadFactor)))`.
 *
 * A power of two is **required**, not preferred: `i2 = i1 XOR h(fp)` only
 * stays in range when the index space is a power of two. The usual patch for
 * another size — `(i1 XOR h(fp)) % numBuckets` — quietly breaks the
 * involution, so `alt(alt(i)) !== i`, relocated items become unfindable, and
 * inserts loop until the kick limit on a filter that is only half full.
 */
export function bucketCountFor(n: number, slots: number, loadFactor: number): number {
  if (n <= 0) return 1;
  const needed = Math.ceil(n / (slots * loadFactor));
  let c = 1;
  while (c < needed) c *= 2;
  return c;
}

/**
 * The alternate bucket for a fingerprint: `i XOR h(fingerprint)`.
 *
 * Partial-key hashing — relocation needs only the fingerprint, never the
 * original key, which is what lets the filter rehome items it cannot read.
 *
 * `h(fp)` is forced non-zero: at zero the alternate bucket would equal the
 * primary and the item would have half the homes the table is sized for.
 * Masking after the XOR is what makes this an involution, and it is exact only
 * because `mask` is `bucketCount - 1` for a power-of-two `bucketCount`.
 */
export function altIndex(index: number, fingerprint: number, seed: number, mask: number): number {
  const scratch = new Uint8Array(2);
  scratch[0] = fingerprint & 0xff;
  scratch[1] = (fingerprint >>> 8) & 0xff;
  let h = murmur3Bytes(scratch, seed ^ ALT_SEED_XOR) & mask;
  if (h === 0) h = 1 & mask;
  return (index ^ h) & mask;
}

export interface CuckooOptions {
  fingerprintBits?: FingerprintBits;
  loadFactor?: number;
  seed?: number;
}

export class CuckooFilter {
  readonly fingerprintBits: FingerprintBits;
  readonly bucketsLog2: number;
  readonly bucketCount: number;
  readonly seed: number;

  private readonly mask: number;
  private readonly fpMask: number;
  /** `bucketCount * SLOTS_PER_BUCKET` fingerprints. 0 means empty. */
  private readonly slots: Uint16Array;
  private count = 0;

  /**
   * Cumulative relocations performed. At alpha <= 0.8 with a correct
   * construction this stays a small multiple of the item count; a table whose
   * XOR involution is broken shows it here as a number that explodes long
   * before any insert actually fails.
   */
  relocations = 0;

  private constructor(bucketsLog2: number, fingerprintBits: FingerprintBits, seed: number) {
    this.bucketsLog2 = bucketsLog2;
    this.bucketCount = 1 << bucketsLog2;
    this.fingerprintBits = fingerprintBits;
    this.seed = seed >>> 0;
    this.mask = this.bucketCount - 1;
    this.fpMask = (1 << fingerprintBits) - 1;
    this.slots = new Uint16Array(this.bucketCount * SLOTS_PER_BUCKET);
  }

  /** Size a filter for `capacity` members at the target load factor. */
  static create(capacity: number, options: CuckooOptions = {}): CuckooFilter {
    const fingerprintBits = options.fingerprintBits ?? 16;
    const loadFactor = options.loadFactor ?? 0.8;
    const bucketCount = bucketCountFor(capacity, SLOTS_PER_BUCKET, loadFactor);
    return new CuckooFilter(Math.log2(bucketCount), fingerprintBits, options.seed ?? 0);
  }

  get size(): number {
    return this.count;
  }

  get loadFactor(): number {
    return this.count / (this.bucketCount * SLOTS_PER_BUCKET);
  }

  /**
   * Would adding `n` members push the load factor past `ceiling`?
   *
   * The compiler refuses such a patch and emits a full re-encode instead — a
   * filter built at 0.95 has no room for the next import, and discovering that
   * at insert time is a runtime surprise rather than a scheduled event.
   */
  wouldExceedCeiling(n: number, ceiling: number): boolean {
    return (this.count + n) / (this.bucketCount * SLOTS_PER_BUCKET) > ceiling;
  }

  /**
   * The fingerprint for a key. **Never zero** — zero is the empty-slot
   * sentinel, so a computed zero is remapped to the fixed constant 1. The
   * accuracy cost is one collision class out of 65,536.
   */
  fingerprintOf(key: string): number {
    const fp = murmur3Utf8(key, this.seed ^ FINGERPRINT_SEED_XOR) & this.fpMask;
    return fp === 0 ? 1 : fp;
  }

  /** The primary bucket for a key. */
  private indexOf(key: string): number {
    return murmur3Utf8(key, this.seed) & this.mask;
  }

  private slotAt(bucket: number, slot: number): number {
    return this.slots[bucket * SLOTS_PER_BUCKET + slot]!;
  }

  private setSlot(bucket: number, slot: number, fp: number): void {
    this.slots[bucket * SLOTS_PER_BUCKET + slot] = fp;
  }

  /** Place a fingerprint in the first free slot of a bucket. */
  private tryPlace(bucket: number, fp: number): boolean {
    for (let s = 0; s < SLOTS_PER_BUCKET; s++) {
      if (this.slotAt(bucket, s) === 0) {
        this.setSlot(bucket, s, fp);
        return true;
      }
    }
    return false;
  }

  private hasFingerprint(bucket: number, fp: number): boolean {
    for (let s = 0; s < SLOTS_PER_BUCKET; s++) {
      if (this.slotAt(bucket, s) === fp) return true;
    }
    return false;
  }

  /**
   * Insert a fingerprint at a known bucket, relocating as needed.
   * Returns false if the kick limit was reached — the caller rebuilds.
   *
   * Exposed for tests that need to plant colliding fingerprints deliberately.
   */
  insertRaw(bucket: number, fp: number): boolean {
    let i = bucket & this.mask;
    let f = fp;
    if (this.tryPlace(i, f)) {
      this.count++;
      return true;
    }
    const j = altIndex(i, f, this.seed, this.mask);
    if (this.tryPlace(j, f)) {
      this.count++;
      return true;
    }

    // Both homes are full: evict an occupant and rehome it, repeatedly.
    i = j;
    for (let kick = 0; kick < CUCKOO_MAX_KICKS; kick++) {
      // Deterministic victim selection, so a rebuild from the same input
      // produces the same bytes. `Math.random()` here would make the wire
      // format irreproducible and the conformance corpus unstable.
      const slot = (f + kick) % SLOTS_PER_BUCKET;
      this.relocations++;
      const evicted = this.slotAt(i, slot);
      this.setSlot(i, slot, f);
      f = evicted;
      i = altIndex(i, f, this.seed, this.mask);
      if (this.tryPlace(i, f)) {
        this.count++;
        return true;
      }
    }
    // The evicted fingerprint `f` is now homeless and has been dropped. The
    // caller must rebuild; a partially-inserted filter is not usable.
    return false;
  }

  /** Remove one occurrence of a fingerprint from one of its two buckets. */
  deleteRaw(bucket: number, fp: number): boolean {
    for (const b of [bucket & this.mask, altIndex(bucket & this.mask, fp, this.seed, this.mask)]) {
      for (let s = 0; s < SLOTS_PER_BUCKET; s++) {
        if (this.slotAt(b, s) === fp) {
          // ONE matching fingerprint, not all of them. Two distinct members can
          // share a fingerprint in the same bucket; clearing both silently
          // evicts someone who is still in the segment.
          this.setSlot(b, s, 0);
          this.count--;
          return true;
        }
      }
    }
    return false;
  }

  /** Test helper: how many slots in a bucket hold this fingerprint. */
  countFingerprint(bucket: number, fp: number): number {
    let n = 0;
    for (let s = 0; s < SLOTS_PER_BUCKET; s++) if (this.slotAt(bucket, s) === fp) n++;
    return n;
  }

  insert(key: string): boolean {
    return this.insertRaw(this.indexOf(key), this.fingerprintOf(key));
  }

  /** Exact for negatives. Positives are confirmed upstream (§9.7 step 2). */
  contains(key: string): boolean {
    const fp = this.fingerprintOf(key);
    const i = this.indexOf(key);
    if (this.hasFingerprint(i, fp)) return true;
    return this.hasFingerprint(altIndex(i, fp, this.seed, this.mask), fp);
  }

  delete(key: string): boolean {
    return this.deleteRaw(this.indexOf(key), this.fingerprintOf(key));
  }

  /* ─────────────────────────── wire format ─────────────────────────── */

  /**
   * Serialise. Layout, frozen:
   *
   * ```
   *  0..3   magic "FKCF"
   *  4      format version (1)
   *  5      fingerprint bits (12 | 16)
   *  6      log2(bucketCount)
   *  7      slots per bucket (4)
   *  8..11  seed, uint32 little-endian
   * 12..15  item count, uint32 little-endian
   * 16..    fingerprint table
   * ```
   *
   * At f=16 a bucket is four uint16 little-endian values — 8 bytes, read with
   * no shifting. At f=12 four fingerprints are nibble-packed into 6 bytes.
   * There is deliberately **no semi-sorting**: it saves ~1 bit per item and
   * costs a decode on every lookup, against a ~14 ns budget.
   */
  encode(): Uint8Array {
    const perBucket = this.fingerprintBits === 16 ? 8 : 6;
    const out = new Uint8Array(CUCKOO_HEADER_BYTES + this.bucketCount * perBucket);
    out.set(MAGIC, 0);
    out[4] = FORMAT_VERSION;
    out[5] = this.fingerprintBits;
    out[6] = this.bucketsLog2;
    out[7] = SLOTS_PER_BUCKET;
    const view = new DataView(out.buffer);
    view.setUint32(8, this.seed, true);
    view.setUint32(12, this.count, true);

    let o = CUCKOO_HEADER_BYTES;
    for (let b = 0; b < this.bucketCount; b++) {
      const f0 = this.slotAt(b, 0);
      const f1 = this.slotAt(b, 1);
      const f2 = this.slotAt(b, 2);
      const f3 = this.slotAt(b, 3);
      if (this.fingerprintBits === 16) {
        view.setUint16(o, f0, true);
        view.setUint16(o + 2, f1, true);
        view.setUint16(o + 4, f2, true);
        view.setUint16(o + 6, f3, true);
      } else {
        // Nibble packing, little-endian within each 12-bit field.
        out[o] = f0 & 0xff;
        out[o + 1] = ((f0 >>> 8) & 0x0f) | ((f1 & 0x0f) << 4);
        out[o + 2] = (f1 >>> 4) & 0xff;
        out[o + 3] = f2 & 0xff;
        out[o + 4] = ((f2 >>> 8) & 0x0f) | ((f3 & 0x0f) << 4);
        out[o + 5] = (f3 >>> 4) & 0xff;
      }
      o += perBucket;
    }
    return out;
  }

  static decode(bytes: Uint8Array): CuckooFilter {
    if (bytes.length < CUCKOO_HEADER_BYTES) throw new Error("cuckoo: truncated payload");
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new Error("cuckoo: bad magic");
    }
    if (bytes[4] !== FORMAT_VERSION) throw new Error(`cuckoo: unsupported version ${bytes[4]}`);
    const fingerprintBits = bytes[5];
    if (fingerprintBits !== 12 && fingerprintBits !== 16) {
      throw new Error(`cuckoo: unsupported fingerprint width ${fingerprintBits}`);
    }
    if (bytes[7] !== SLOTS_PER_BUCKET) throw new Error("cuckoo: unsupported slots per bucket");

    const bucketsLog2 = bytes[6]!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const filter = new CuckooFilter(bucketsLog2, fingerprintBits, view.getUint32(8, true));
    const perBucket = fingerprintBits === 16 ? 8 : 6;
    if (bytes.length !== CUCKOO_HEADER_BYTES + filter.bucketCount * perBucket) {
      throw new Error("cuckoo: truncated or overlong table");
    }

    let o = CUCKOO_HEADER_BYTES;
    for (let b = 0; b < filter.bucketCount; b++) {
      if (fingerprintBits === 16) {
        for (let s = 0; s < SLOTS_PER_BUCKET; s++) {
          filter.setSlot(b, s, view.getUint16(o + s * 2, true));
        }
      } else {
        const b0 = bytes[o]!;
        const b1 = bytes[o + 1]!;
        const b2 = bytes[o + 2]!;
        const b3 = bytes[o + 3]!;
        const b4 = bytes[o + 4]!;
        const b5 = bytes[o + 5]!;
        filter.setSlot(b, 0, b0 | ((b1 & 0x0f) << 8));
        filter.setSlot(b, 1, (b1 >>> 4) | (b2 << 4));
        filter.setSlot(b, 2, b3 | ((b4 & 0x0f) << 8));
        filter.setSlot(b, 3, (b4 >>> 4) | (b5 << 4));
      }
      o += perBucket;
    }
    filter.count = view.getUint32(12, true);
    return filter;
  }
}

export interface CuckooBuildResult {
  filter: CuckooFilter;
  /** Increments `featurekit_segment_filter_rebuild_total`. A rebuild loop that
   *  nobody can see is how a compile-time bug becomes a production incident. */
  rebuilds: number;
  rebuildReasons: ("seed_retry" | "table_growth")[];
}

/**
 * Build a filter over a member set, applying the compiler's retry policy.
 *
 * At alpha <= 0.8 an insert failure means the construction is wrong rather than
 * unlucky, so the first retry only increments the seed. A second failure
 * doubles the table.
 */
export function buildCuckooFilter(
  members: readonly string[],
  options: CuckooOptions = {},
): CuckooBuildResult {
  const unique = [...new Set(members)];
  const loadFactor = options.loadFactor ?? 0.8;
  const fingerprintBits = options.fingerprintBits ?? 16;
  const baseSeed = options.seed ?? 0;

  const rebuildReasons: ("seed_retry" | "table_growth")[] = [];
  let capacity = unique.length;
  let seed = baseSeed;

  for (let attempt = 0; attempt < 8; attempt++) {
    const filter = CuckooFilter.create(capacity, { fingerprintBits, loadFactor, seed });
    let ok = true;
    for (const key of unique) {
      if (!filter.insert(key)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { filter, rebuilds: rebuildReasons.length, rebuildReasons };
    }
    if (attempt === 0) {
      seed = (seed + 1) >>> 0;
      rebuildReasons.push("seed_retry");
    } else {
      capacity = Math.max(1, capacity * 2);
      rebuildReasons.push("table_growth");
    }
  }
  throw new Error("cuckoo: construction failed after 8 attempts");
}
