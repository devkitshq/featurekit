/**
 * HyperLogLog for distinct-context counts.
 *
 * **Why a sketch at all.** "How many distinct users saw this variation" cannot
 * be answered by summing per-minute counts — the same user appears in many
 * minutes — and it cannot be answered by storing user ids, because that is
 * every evaluation forever, in the one table that is already the highest-volume
 * thing in the system. A sketch is a fixed 2^p bytes per bucket and merges
 * without coordination, which is what makes the rollup single-writer-per-shard
 * rather than requiring one writer globally.
 *
 * **p = 12** gives 4096 registers, ~4 KB per sketch and roughly 1.6% relative
 * error. That is the right trade for a number people use to decide whether a
 * rollout is working; anyone needing exactness has the raw `count`.
 *
 * The encoding is deliberately trivial — a version byte, `p`, then the raw
 * registers — because these bytes live in a Postgres column and will be read
 * back by a future version of this code, and possibly by a port in another
 * language. No library, no dependency, no format that needs a changelog.
 */

const HEADER_BYTES = 2;
const FORMAT_VERSION = 1;

/** 2^12 registers: ~4 KB, ~1.6% error. Frozen — changing it breaks merges. */
export const HLL_PRECISION = 12;

function registerCount(precision: number): number {
  return 1 << precision;
}

/**
 * 64-bit-ish hash from two 32-bit murmur passes.
 *
 * The SDK's murmur3 is 32-bit, and collisions at 32 bits would bias the
 * estimate at a few million distinct values, which is why two passes with
 * different seeds are combined.
 *
 * Frozen along with `HLL_PRECISION`: sketches are persisted and merged, so a
 * different hash would place the same context in different registers and
 * inflate every count that spans the change.
 */
function hash64(value: string): { bucket: number; leading: number; precision: number } {
  let h1 = 0x9747b28c;
  let h2 = 0x85ebca6b;
  const bytes = Buffer.from(value, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    h1 = Math.imul(h1 ^ c, 0xcc9e2d51);
    h1 = (h1 << 15) | (h1 >>> 17);
    h2 = Math.imul(h2 ^ c, 0x1b873593);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  h1 ^= bytes.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 16;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;

  const precision = HLL_PRECISION;
  const bucket = (h1 >>> (32 - precision)) & (registerCount(precision) - 1);
  // Rank: position of the first set bit in the remaining bits, capped so it
  // always fits in one byte.
  const remaining = (h1 << precision) >>> 0;
  let leading = 1;
  if (remaining === 0) {
    leading = 32 - precision + 1 + clz32(h2 >>> 0);
  } else {
    leading = clz32(remaining) + 1;
  }
  return { bucket, leading: Math.min(leading, 63), precision };
}

function clz32(x: number): number {
  return Math.clz32(x);
}

export class HyperLogLog {
  private readonly registers: Uint8Array;

  constructor(readonly precision: number = HLL_PRECISION) {
    this.registers = new Uint8Array(registerCount(precision));
  }

  add(value: string): void {
    const { bucket, leading } = hash64(value);
    if (leading > this.registers[bucket]!) this.registers[bucket] = leading;
  }

  /**
   * Merge another sketch in place.
   *
   * Register-wise max, which is why merging is associative, commutative and
   * idempotent — the three properties that make a duplicated or replayed batch
   * harmless.
   */
  merge(other: HyperLogLog): void {
    if (other.precision !== this.precision) {
      throw new Error("featurekit: cannot merge HLL sketches of different precision");
    }
    for (let i = 0; i < this.registers.length; i++) {
      const value = other.registers[i]!;
      if (value > this.registers[i]!) this.registers[i] = value;
    }
  }

  /** Estimated cardinality, with the small-range correction that matters most. */
  count(): number {
    const m = this.registers.length;
    let sum = 0;
    let zeros = 0;
    for (const register of this.registers) {
      sum += 2 ** -register;
      if (register === 0) zeros++;
    }
    const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
    const estimate = (alpha * m * m) / sum;

    // Below ~2.5m the raw estimate is badly biased, and linear counting is
    // exact-ish there. Most buckets in this system are small, so this branch is
    // the common one rather than an edge case.
    if (estimate <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros));
    return Math.round(estimate);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(HEADER_BYTES + this.registers.length);
    out[0] = FORMAT_VERSION;
    out[1] = this.precision;
    out.set(this.registers, HEADER_BYTES);
    return out;
  }

  /**
   * Decode a stored sketch.
   *
   * Returns `null` rather than throwing on anything unrecognised. A corrupt
   * analytics sketch must degrade to "no unique count for this bucket", never to
   * an exception in the rollup worker — which would stall the drain and turn an
   * analytics problem into an ingest backlog.
   */
  static fromBytes(bytes: Uint8Array | null | undefined): HyperLogLog | null {
    if (bytes === null || bytes === undefined || bytes.length < HEADER_BYTES) return null;
    if (bytes[0] !== FORMAT_VERSION) return null;
    const precision = bytes[1]!;
    if (precision < 4 || precision > 18) return null;
    if (bytes.length !== HEADER_BYTES + registerCount(precision)) return null;
    const sketch = new HyperLogLog(precision);
    sketch.registers.set(bytes.subarray(HEADER_BYTES));
    return sketch;
  }
}

/**
 * **What this system does NOT do, stated where someone will find it.**
 *
 * Today's SDKs report `uniqueContexts` as a *number*, not as a sketch. A number
 * cannot be merged: adding the unique counts from twelve SDK instances
 * double-counts every user who talked to more than one of them, and taking the
 * maximum understates. So `evaluation_summaries.unique_sketch` is written only
 * when a client supplies real sketch bytes, and `unique_contexts_reported` is
 * kept as a documented *floor* otherwise.
 *
 * Fabricating a sketch from the number — hashing N synthetic ids — was the
 * tempting alternative and is worse than useless: it produces a sketch that
 * merges cleanly and is confidently wrong, which is precisely the "telemetry
 * that lies" failure. It also costs N hashes on the ingest path.
 *
 * The real fix is an SDK that ships its own sketch, which is why the wire
 * format accepts one already.
 */
export const UNIQUE_COUNTS_ARE_A_FLOOR = true;
