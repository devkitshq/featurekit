/**
 * (2,4) partial-key cuckoo filter with 32-bit fingerprints — the membership
 * structure for large segments whose keys are not integers.
 *
 * **Answered from the snapshot alone.** At 32 bits the false-positive rate is
 * about 2b/2^32 ≈ 1.9e-9 per lookup, so a positive is treated as membership and
 * nothing confirms it: no provider, no network, no "unresolved" while a cache
 * warms. Below that rate a false positive is rarer than the hardware failures
 * nobody guards against, and it grants nothing a caller could not get anyway —
 * without secure mode a caller can claim any key, including a real member's,
 * and with it keys are signed, so a colliding key cannot be chosen.
 *
 * **This is a wire format.** The compiler writes it and every SDK reads it. A
 * disagreement about hashing or layout does not throw — it silently answers
 * `false` for members who *are* in the segment. Every parameter is frozen.
 *
 * **Speed.** Bucket and fingerprint come from one MurmurHash3 x86_128 call — a
 * single pass over the key — and the alternate bucket from integer mixing of
 * the fingerprint, with no allocation. Hashing is most of a lookup's cost, so
 * reading the key once rather than twice is what makes this about twice as fast
 * as the 16-bit format it replaced (`tools/bench-segments.mjs`).
 *
 * Chosen over Bloom because **Bloom cannot delete**, which a segment-patch
 * needs.
 *
 * @see docs/evaluation/segments.md
 */

import { fmix32, murmur3x86_128 } from "./murmur3.js";

/** Slots per bucket. The load-factor knee: b=2 saturates near 84%, b=4 reaches ~95%. */
export const SLOTS_PER_BUCKET = 4;

/** Standard. At alpha <= 0.8 with a correct construction it is never reached. */
export const CUCKOO_MAX_KICKS = 500;

/** `FKCF` + version + fpBits + bucketsLog2 + slots + seed(u32) + count(u32). */
export const CUCKOO_HEADER_BYTES = 16;

/** Fingerprint width. Fixed: 32 bits is what lets positives go unconfirmed. */
export const FINGERPRINT_BITS = 32;

const MAGIC = [0x46, 0x4b, 0x43, 0x46] as const; // "FKCF"
/** Version 1 was 12/16-bit fingerprints from two x86_32 hashes; it is not read. */
const FORMAT_VERSION = 2;

/** Derives the alternate-bucket mix from the filter's seed. Frozen. */
const ALT_SEED_XOR = 0x5bd1e995;

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
  let h = fmix32((fingerprint ^ seed ^ ALT_SEED_XOR) >>> 0) & mask;
  if (h === 0) h = 1 & mask;
  return (index ^ h) & mask;
}

export interface CuckooOptions {
  loadFactor?: number;
  seed?: number;
}

/** One per module: a lookup must not allocate, and evaluation is synchronous. */
const scratch = new Uint32Array(4);

export class CuckooFilter {
  readonly fingerprintBits = FINGERPRINT_BITS;
  readonly bucketsLog2: number;
  readonly bucketCount: number;
  readonly seed: number;

  private readonly mask: number;
  /** `bucketCount * SLOTS_PER_BUCKET` fingerprints. 0 means empty. */
  private readonly slots: Uint32Array;
  private count = 0;

  /**
   * Cumulative relocations performed. At alpha <= 0.8 with a correct
   * construction this stays a small multiple of the item count; a table whose
   * XOR involution is broken shows it here as a number that explodes long
   * before any insert actually fails.
   */
  relocations = 0;

  private constructor(bucketsLog2: number, seed: number) {
    this.bucketsLog2 = bucketsLog2;
    this.bucketCount = 2 ** bucketsLog2;
    this.seed = seed >>> 0;
    this.mask = this.bucketCount - 1;
    this.slots = new Uint32Array(this.bucketCount * SLOTS_PER_BUCKET);
  }

  /** Size a filter for `capacity` members at the target load factor. */
  static create(capacity: number, options: CuckooOptions = {}): CuckooFilter {
    const loadFactor = options.loadFactor ?? 0.8;
    const bucketCount = bucketCountFor(capacity, SLOTS_PER_BUCKET, loadFactor);
    return new CuckooFilter(Math.log2(bucketCount), options.seed ?? 0);
  }

  get size(): number {
    return this.count;
  }

  get loadFactor(): number {
    return this.count / (this.bucketCount * SLOTS_PER_BUCKET);
  }

  /** Hash once; the primary bucket and fingerprint are left in `scratch`. */
  private hash(key: string): void {
    murmur3x86_128(key, this.seed, scratch);
  }

  /**
   * The fingerprint for a key. **Never zero** — zero is the empty-slot
   * sentinel, so a computed zero is remapped to the fixed constant 1.
   */
  fingerprintOf(key: string): number {
    this.hash(key);
    return scratch[1] === 0 ? 1 : scratch[1]!;
  }

  /** The primary bucket for a key. */
  indexOf(key: string): number {
    this.hash(key);
    return scratch[0]! & this.mask;
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
    const o = bucket * SLOTS_PER_BUCKET;
    const s = this.slots;
    return s[o] === fp || s[o + 1] === fp || s[o + 2] === fp || s[o + 3] === fp;
  }

  /**
   * Insert a fingerprint at a known bucket, relocating as needed.
   * Returns false if the kick limit was reached — the caller rebuilds.
   *
   * Exposed for tests that need to plant colliding fingerprints deliberately.
   */
  insertRaw(bucket: number, fp: number): boolean {
    let i = bucket & this.mask;
    let f = fp >>> 0;
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
    const primary = bucket & this.mask;
    const f = fp >>> 0;
    for (const b of [primary, altIndex(primary, f, this.seed, this.mask)]) {
      for (let s = 0; s < SLOTS_PER_BUCKET; s++) {
        if (this.slotAt(b, s) === f) {
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
    for (let s = 0; s < SLOTS_PER_BUCKET; s++) if (this.slotAt(bucket, s) === fp >>> 0) n++;
    return n;
  }

  insert(key: string): boolean {
    this.hash(key);
    return this.insertRaw(scratch[0]! & this.mask, scratch[1] === 0 ? 1 : scratch[1]!);
  }

  /** Membership. Exact for negatives; a positive is wrong about once in 500 million. */
  contains(key: string): boolean {
    this.hash(key);
    const i = scratch[0]! & this.mask;
    const fp = scratch[1] === 0 ? 1 : scratch[1]!;
    return this.hasFingerprint(i, fp) || this.hasFingerprint(altIndex(i, fp, this.seed, this.mask), fp);
  }

  delete(key: string): boolean {
    this.hash(key);
    return this.deleteRaw(scratch[0]! & this.mask, scratch[1] === 0 ? 1 : scratch[1]!);
  }

  /* ─────────────────────────── wire format ─────────────────────────── */

  /**
   * Serialise. Layout, frozen:
   *
   * ```
   *  0..3   magic "FKCF"
   *  4      format version (2)
   *  5      fingerprint bits (32)
   *  6      log2(bucketCount)
   *  7      slots per bucket (4)
   *  8..11  seed, uint32 little-endian
   * 12..15  item count, uint32 little-endian
   * 16..    fingerprint table: per bucket, four uint32 little-endian
   * ```
   *
   * A bucket is 16 bytes, so both candidate buckets of a lookup are at most two
   * cache lines. No semi-sorting: it saves a bit per item and costs a decode on
   * every lookup.
   */
  encode(): Uint8Array {
    const out = new Uint8Array(CUCKOO_HEADER_BYTES + this.slots.length * 4);
    out.set(MAGIC, 0);
    out[4] = FORMAT_VERSION;
    out[5] = FINGERPRINT_BITS;
    out[6] = this.bucketsLog2;
    out[7] = SLOTS_PER_BUCKET;
    const view = new DataView(out.buffer);
    view.setUint32(8, this.seed, true);
    view.setUint32(12, this.count, true);
    let o = CUCKOO_HEADER_BYTES;
    for (let i = 0; i < this.slots.length; i++, o += 4) view.setUint32(o, this.slots[i]!, true);
    return out;
  }

  static decode(bytes: Uint8Array): CuckooFilter {
    if (bytes.length < CUCKOO_HEADER_BYTES) throw new Error("cuckoo: truncated payload");
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new Error("cuckoo: bad magic");
    }
    if (bytes[4] !== FORMAT_VERSION) throw new Error(`cuckoo: unsupported version ${bytes[4]}`);
    if (bytes[5] !== FINGERPRINT_BITS) {
      throw new Error(`cuckoo: unsupported fingerprint width ${bytes[5]}`);
    }
    if (bytes[7] !== SLOTS_PER_BUCKET) throw new Error("cuckoo: unsupported slots per bucket");
    const bucketsLog2 = bytes[6]!;
    if (bucketsLog2 > 30) throw new Error("cuckoo: table too large");

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const filter = new CuckooFilter(bucketsLog2, view.getUint32(8, true));
    if (bytes.length !== CUCKOO_HEADER_BYTES + filter.slots.length * 4) {
      throw new Error("cuckoo: truncated or overlong table");
    }
    let o = CUCKOO_HEADER_BYTES;
    for (let i = 0; i < filter.slots.length; i++, o += 4) filter.slots[i] = view.getUint32(o, true);
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
  const baseSeed = options.seed ?? 0;

  const rebuildReasons: ("seed_retry" | "table_growth")[] = [];
  let capacity = unique.length;
  let seed = baseSeed;

  for (let attempt = 0; attempt < 8; attempt++) {
    const filter = CuckooFilter.create(capacity, { loadFactor, seed });
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
