/**
 * MurmurHash3 x86_32 — the frozen uniformity function for featurekit.
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
export function fmix32(h: number): number {
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

/* ───────────────────────── MurmurHash3 x86_128 ───────────────────────── */

/*
 * The 128-bit variant built from 32-bit lanes, so it runs without BigInt.
 * Used where one pass over a key has to yield more than 32 bits — the cuckoo
 * filter takes its bucket and its 32-bit fingerprint from one call, where two
 * separate x86_32 calls read the key twice and cost twice as much.
 *
 * Also a wire format: output matches the reference implementation
 * (`MurmurHash3_x86_128`, read as four little-endian uint32s), pinned by
 * `tests/evaluation/murmur3-128.test.ts` against vectors from the C original.
 */

const K1 = 0x239b961b;
const K2 = 0xab0e9789;
const K3 = 0x38b34ae5;
const K4 = 0xa1e38b93;

/**
 * Hash the UTF-8 bytes of `s` into `out` (four uint32s).
 *
 * Writes into a caller-owned array rather than returning a fresh one: this
 * runs once per segment lookup, and an allocation per call would cost more than
 * the hash. ASCII keys are read once — the ASCII check rides along with the
 * hashing rather than being a separate pass — and anything else is hashed over
 * its UTF-8 encoding.
 */
export function murmur3x86_128(s: string, seed: number, out: Uint32Array): void {
  if (!hash128Ascii(s, seed, out)) hash128Bytes(encoder.encode(s), seed, out);
}

function hash128Ascii(s: string, seed: number, out: Uint32Array): boolean {
  const len = s.length;
  let h1 = seed | 0;
  let h2 = seed | 0;
  let h3 = seed | 0;
  let h4 = seed | 0;
  let seen = 0;
  const blocks = len & ~15;
  for (let i = 0; i < blocks; i += 16) {
    const a0 = s.charCodeAt(i), a1 = s.charCodeAt(i + 1), a2 = s.charCodeAt(i + 2), a3 = s.charCodeAt(i + 3);
    const b0 = s.charCodeAt(i + 4), b1 = s.charCodeAt(i + 5), b2 = s.charCodeAt(i + 6), b3 = s.charCodeAt(i + 7);
    const c0 = s.charCodeAt(i + 8), c1 = s.charCodeAt(i + 9), c2 = s.charCodeAt(i + 10), c3 = s.charCodeAt(i + 11);
    const d0 = s.charCodeAt(i + 12), d1 = s.charCodeAt(i + 13), d2 = s.charCodeAt(i + 14), d3 = s.charCodeAt(i + 15);
    seen |= a0 | a1 | a2 | a3 | b0 | b1 | b2 | b3 | c0 | c1 | c2 | c3 | d0 | d1 | d2 | d3;
    const k1 = a0 | (a1 << 8) | (a2 << 16) | (a3 << 24);
    const k2 = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    const k3 = c0 | (c1 << 8) | (c2 << 16) | (c3 << 24);
    const k4 = d0 | (d1 << 8) | (d2 << 16) | (d3 << 24);
    h1 ^= mul32(rotl32(mul32(k1, K1), 15), K2);
    h1 = (mul32(rotl32(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    h2 ^= mul32(rotl32(mul32(k2, K2), 16), K3);
    h2 = (mul32(rotl32(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    h3 ^= mul32(rotl32(mul32(k3, K3), 17), K4);
    h3 = (mul32(rotl32(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    h4 ^= mul32(rotl32(mul32(k4, K4), 18), K1);
    h4 = (mul32(rotl32(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }

  for (let j = blocks; j < len; j++) seen |= s.charCodeAt(j);
  if (seen > 0x7f) return false;

  let k1 = 0;
  let k2 = 0;
  let k3 = 0;
  let k4 = 0;
  const t = blocks;
  const rem = len & 15;
  if (rem > 12) {
    if (rem > 14) k4 ^= s.charCodeAt(t + 14) << 16;
    if (rem > 13) k4 ^= s.charCodeAt(t + 13) << 8;
    k4 ^= s.charCodeAt(t + 12);
    h4 ^= mul32(rotl32(mul32(k4, K4), 18), K1);
  }
  if (rem > 8) {
    if (rem > 11) k3 ^= s.charCodeAt(t + 11) << 24;
    if (rem > 10) k3 ^= s.charCodeAt(t + 10) << 16;
    if (rem > 9) k3 ^= s.charCodeAt(t + 9) << 8;
    k3 ^= s.charCodeAt(t + 8);
    h3 ^= mul32(rotl32(mul32(k3, K3), 17), K4);
  }
  if (rem > 4) {
    if (rem > 7) k2 ^= s.charCodeAt(t + 7) << 24;
    if (rem > 6) k2 ^= s.charCodeAt(t + 6) << 16;
    if (rem > 5) k2 ^= s.charCodeAt(t + 5) << 8;
    k2 ^= s.charCodeAt(t + 4);
    h2 ^= mul32(rotl32(mul32(k2, K2), 16), K3);
  }
  if (rem > 0) {
    if (rem > 3) k1 ^= s.charCodeAt(t + 3) << 24;
    if (rem > 2) k1 ^= s.charCodeAt(t + 2) << 16;
    if (rem > 1) k1 ^= s.charCodeAt(t + 1) << 8;
    k1 ^= s.charCodeAt(t);
    h1 ^= mul32(rotl32(mul32(k1, K1), 15), K2);
  }
  finish128(h1, h2, h3, h4, len, out);
  return true;
}

function hash128Bytes(b: Uint8Array, seed: number, out: Uint32Array): void {
  const len = b.length;
  let h1 = seed | 0;
  let h2 = seed | 0;
  let h3 = seed | 0;
  let h4 = seed | 0;
  const blocks = len & ~15;
  for (let i = 0; i < blocks; i += 16) {
    const k1 = b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
    const k2 = b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24);
    const k3 = b[i + 8]! | (b[i + 9]! << 8) | (b[i + 10]! << 16) | (b[i + 11]! << 24);
    const k4 = b[i + 12]! | (b[i + 13]! << 8) | (b[i + 14]! << 16) | (b[i + 15]! << 24);
    h1 ^= mul32(rotl32(mul32(k1, K1), 15), K2);
    h1 = (mul32(rotl32(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    h2 ^= mul32(rotl32(mul32(k2, K2), 16), K3);
    h2 = (mul32(rotl32(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    h3 ^= mul32(rotl32(mul32(k3, K3), 17), K4);
    h3 = (mul32(rotl32(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    h4 ^= mul32(rotl32(mul32(k4, K4), 18), K1);
    h4 = (mul32(rotl32(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }

  let k1 = 0;
  let k2 = 0;
  let k3 = 0;
  let k4 = 0;
  const t = blocks;
  const rem = len & 15;
  if (rem > 12) {
    if (rem > 14) k4 ^= b[t + 14]! << 16;
    if (rem > 13) k4 ^= b[t + 13]! << 8;
    k4 ^= b[t + 12]!;
    h4 ^= mul32(rotl32(mul32(k4, K4), 18), K1);
  }
  if (rem > 8) {
    if (rem > 11) k3 ^= b[t + 11]! << 24;
    if (rem > 10) k3 ^= b[t + 10]! << 16;
    if (rem > 9) k3 ^= b[t + 9]! << 8;
    k3 ^= b[t + 8]!;
    h3 ^= mul32(rotl32(mul32(k3, K3), 17), K4);
  }
  if (rem > 4) {
    if (rem > 7) k2 ^= b[t + 7]! << 24;
    if (rem > 6) k2 ^= b[t + 6]! << 16;
    if (rem > 5) k2 ^= b[t + 5]! << 8;
    k2 ^= b[t + 4]!;
    h2 ^= mul32(rotl32(mul32(k2, K2), 16), K3);
  }
  if (rem > 0) {
    if (rem > 3) k1 ^= b[t + 3]! << 24;
    if (rem > 2) k1 ^= b[t + 2]! << 16;
    if (rem > 1) k1 ^= b[t + 1]! << 8;
    k1 ^= b[t]!;
    h1 ^= mul32(rotl32(mul32(k1, K1), 15), K2);
  }
  finish128(h1, h2, h3, h4, len, out);
}

function finish128(
  h1: number,
  h2: number,
  h3: number,
  h4: number,
  len: number,
  out: Uint32Array,
): void {
  h1 ^= len;
  h2 ^= len;
  h3 ^= len;
  h4 ^= len;
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  h1 = fmix32(h1);
  h2 = fmix32(h2);
  h3 = fmix32(h3);
  h4 = fmix32(h4);
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  out[0] = h1;
  out[1] = h2;
  out[2] = h3;
  out[3] = h4;
}
