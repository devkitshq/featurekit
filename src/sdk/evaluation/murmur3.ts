/**
 * MurmurHash3 x86_32 — the frozen uniformity function for featurekit (§9.3, §9.4).
 *
 * This is a WIRE FORMAT, not an implementation detail. The same bytes must
 * produce the same uint32 in every SDK in every language, forever: changing it
 * re-buckets every context in every percentage rollout simultaneously, which
 * cannot be done without a coordinated flag-by-flag migration.
 *
 * It does no security work. It is a uniformity function, and a cryptographic
 * hash here costs ~2500 ns/op — against a budget measured in tens of ns.
 *
 * @see docs/evaluation/hashing.md
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const M = 5;
const N = 0xe6546b64;

/** Multiply two uint32s modulo 2^32. `a * b` in floats loses the low bits. */
const mul32 = Math.imul;

/** Rotate a uint32 left. `<<` and `>>>` on a negative int32 still work here. */
function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

/** The final avalanche. Shared by both input paths so they cannot drift. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = mul32(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = mul32(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** One 4-byte block mixed into the running hash. */
function mixBlock(h: number, k: number): number {
  k = mul32(k, C1);
  k = rotl32(k, 15);
  k = mul32(k, C2);
  h ^= k;
  h = rotl32(h, 13);
  return (mul32(h, M) + N) | 0;
}

/**
 * The 1–3 byte tail, mixed without the block loop's second rotation.
 * `k === 0` is deliberately not short-circuited: it is already a no-op
 * (`h ^ 0 === h`), and a shortcut here reads like a bug to anyone porting this.
 */
function mixTail(h: number, k: number): number {
  k = mul32(k, C1);
  k = rotl32(k, 15);
  k = mul32(k, C2);
  return h ^ k;
}

/**
 * Hash raw bytes. This is the specification: every other entry point in this
 * file must agree with it byte for byte.
 */
export function murmur3Bytes(bytes: Uint8Array, seed = 0): number {
  const len = bytes.length;
  const blocks = len & ~3;
  let h = seed | 0;

  for (let i = 0; i < blocks; i += 4) {
    // Little-endian, per the reference implementation on a little-endian host.
    const k =
      bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    h = mixBlock(h, k);
  }

  // The reference implementation writes this as a fallthrough switch. Spelled
  // out here instead: an accidental `break` in that form is a silent hash
  // change, and this file is a wire format.
  const rem = len & 3;
  if (rem > 0) {
    let k1 = bytes[blocks]!;
    if (rem > 1) k1 |= bytes[blocks + 1]! << 8;
    if (rem > 2) k1 |= bytes[blocks + 2]! << 16;
    h = mixTail(h, k1);
  }

  return fmix32(h ^ len);
}

/**
 * The ASCII fast path: hash a string's bytes without materialising them.
 *
 * Valid ONLY when every code unit is < 0x80, where the UTF-8 encoding of the
 * string is exactly its code units. The caller checks; this function trusts.
 * It is an optimisation of `murmur3Bytes`, never a second specification —
 * `murmur3.test.ts` asserts the two agree over the full ASCII range.
 */
function murmur3Ascii(s: string, seed: number): number {
  const len = s.length;
  const blocks = len & ~3;
  let h = seed | 0;

  for (let i = 0; i < blocks; i += 4) {
    const k =
      s.charCodeAt(i) |
      (s.charCodeAt(i + 1) << 8) |
      (s.charCodeAt(i + 2) << 16) |
      (s.charCodeAt(i + 3) << 24);
    h = mixBlock(h, k);
  }

  const rem = len & 3;
  if (rem > 0) {
    let k1 = s.charCodeAt(blocks);
    if (rem > 1) k1 |= s.charCodeAt(blocks + 1) << 8;
    if (rem > 2) k1 |= s.charCodeAt(blocks + 2) << 16;
    h = mixTail(h, k1);
  }

  return fmix32(h ^ len);
}

/** True when the string's UTF-8 encoding is identical to its code units. */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) return false;
  }
  return true;
}

/** Allocated once. `TextEncoder` construction, not encoding, was the cost. */
const encoder = new TextEncoder();

/**
 * Hash the UTF-8 bytes of a string.
 *
 * BYTES, not UTF-16 code units. `"usr_josé"` is [...,115,195,169] here and in
 * every other language's SDK; a `charCodeAt`-based implementation would hash
 * [...,115,233] and silently split that user across SDKs on a rollout
 * boundary. Non-ASCII context keys — emails, names, unicode ids — are routine.
 */
export function murmur3Utf8(s: string, seed = 0): number {
  return isAscii(s) ? murmur3Ascii(s, seed) : murmur3Bytes(encoder.encode(s), seed);
}
