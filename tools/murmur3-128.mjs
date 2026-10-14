/**
 * MurmurHash3 x86_128, over UTF-8 bytes, in 32-bit arithmetic only.
 *
 * The 128-bit variant built from 32-bit lanes, so JavaScript runs it without
 * BigInt. One pass over the key yields four 32-bit words. Output matches the
 * reference implementation (`mmh3.hash_bytes(key, seed, x64arch=False)`, read
 * as four little-endian u32s); `tools/bench-segments.mjs` checks known
 * vectors before it measures anything.
 *
 * Results land in `out` rather than a fresh array: this sits on a lookup path
 * measured in nanoseconds, and an allocation per call would be most of it.
 */

export const out = new Uint32Array(4);

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;
const encoder = new TextEncoder();

function rotl(x, r) {
  return (x << r) | (x >>> (32 - r));
}

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Hash `key` with `seed`; the four words are left in `out`. */
export function murmur3x86_128(key, seed = 0) {
  // One pass: read characters as bytes and note whether any was non-ASCII.
  // Only then is the UTF-8 encoding needed, and the work is redone over it.
  if (!hashAscii(key, seed)) hashBytes(encoder.encode(key), seed);
}

function hashAscii(s, seed) {
  const len = s.length;
  let h1 = seed | 0, h2 = seed | 0, h3 = seed | 0, h4 = seed | 0;
  let seen = 0;
  const blocks = len & ~15;
  for (let i = 0; i < blocks; i += 16) {
    const a0 = s.charCodeAt(i), a1 = s.charCodeAt(i + 1), a2 = s.charCodeAt(i + 2), a3 = s.charCodeAt(i + 3);
    const b0 = s.charCodeAt(i + 4), b1 = s.charCodeAt(i + 5), b2 = s.charCodeAt(i + 6), b3 = s.charCodeAt(i + 7);
    const c0 = s.charCodeAt(i + 8), c1 = s.charCodeAt(i + 9), c2 = s.charCodeAt(i + 10), c3 = s.charCodeAt(i + 11);
    const d0 = s.charCodeAt(i + 12), d1 = s.charCodeAt(i + 13), d2 = s.charCodeAt(i + 14), d3 = s.charCodeAt(i + 15);
    seen |= a0 | a1 | a2 | a3 | b0 | b1 | b2 | b3 | c0 | c1 | c2 | c3 | d0 | d1 | d2 | d3;
    let k1 = a0 | (a1 << 8) | (a2 << 16) | (a3 << 24);
    let k2 = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    let k3 = c0 | (c1 << 8) | (c2 << 16) | (c3 << 24);
    let k4 = d0 | (d1 << 8) | (d2 << 16) | (d3 << 24);

    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    h1 ^= k1;
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    h2 ^= k2;
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    h3 ^= k3;
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    h4 ^= k4;
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }

  let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
  const t = blocks;
  for (let j = len - 1; j >= t; j--) seen |= s.charCodeAt(j);
  if (seen > 0x7f) return false;
  switch (len & 15) {
    case 15: k4 ^= s.charCodeAt(t + 14) << 16; // falls through
    case 14: k4 ^= s.charCodeAt(t + 13) << 8; // falls through
    case 13:
      k4 ^= s.charCodeAt(t + 12);
      k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
      h4 ^= k4; // falls through
    case 12: k3 ^= s.charCodeAt(t + 11) << 24; // falls through
    case 11: k3 ^= s.charCodeAt(t + 10) << 16; // falls through
    case 10: k3 ^= s.charCodeAt(t + 9) << 8; // falls through
    case 9:
      k3 ^= s.charCodeAt(t + 8);
      k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
      h3 ^= k3; // falls through
    case 8: k2 ^= s.charCodeAt(t + 7) << 24; // falls through
    case 7: k2 ^= s.charCodeAt(t + 6) << 16; // falls through
    case 6: k2 ^= s.charCodeAt(t + 5) << 8; // falls through
    case 5:
      k2 ^= s.charCodeAt(t + 4);
      k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
      h2 ^= k2; // falls through
    case 4: k1 ^= s.charCodeAt(t + 3) << 24; // falls through
    case 3: k1 ^= s.charCodeAt(t + 2) << 16; // falls through
    case 2: k1 ^= s.charCodeAt(t + 1) << 8; // falls through
    case 1:
      k1 ^= s.charCodeAt(t);
      k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
      h1 ^= k1;
  }
  finish(h1, h2, h3, h4, len);
  return true;
}

function hashBytes(b, seed) {
  const len = b.length;
  let h1 = seed | 0, h2 = seed | 0, h3 = seed | 0, h4 = seed | 0;
  const blocks = len & ~15;
  for (let i = 0; i < blocks; i += 16) {
    let k1 = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    let k2 = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    let k3 = b[i + 8] | (b[i + 9] << 8) | (b[i + 10] << 16) | (b[i + 11] << 24);
    let k4 = b[i + 12] | (b[i + 13] << 8) | (b[i + 14] << 16) | (b[i + 15] << 24);

    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    h1 ^= k1;
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    h2 ^= k2;
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    h3 ^= k3;
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    h4 ^= k4;
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }

  let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
  const t = blocks;
  switch (len & 15) {
    case 15: k4 ^= b[t + 14] << 16; // falls through
    case 14: k4 ^= b[t + 13] << 8; // falls through
    case 13:
      k4 ^= b[t + 12];
      k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
      h4 ^= k4; // falls through
    case 12: k3 ^= b[t + 11] << 24; // falls through
    case 11: k3 ^= b[t + 10] << 16; // falls through
    case 10: k3 ^= b[t + 9] << 8; // falls through
    case 9:
      k3 ^= b[t + 8];
      k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
      h3 ^= k3; // falls through
    case 8: k2 ^= b[t + 7] << 24; // falls through
    case 7: k2 ^= b[t + 6] << 16; // falls through
    case 6: k2 ^= b[t + 5] << 8; // falls through
    case 5:
      k2 ^= b[t + 4];
      k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
      h2 ^= k2; // falls through
    case 4: k1 ^= b[t + 3] << 24; // falls through
    case 3: k1 ^= b[t + 2] << 16; // falls through
    case 2: k1 ^= b[t + 1] << 8; // falls through
    case 1:
      k1 ^= b[t];
      k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
      h1 ^= k1;
  }
  finish(h1, h2, h3, h4, len);
}

function finish(h1, h2, h3, h4, len) {
  h1 ^= len; h2 ^= len; h3 ^= len; h4 ^= len;
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  h1 = fmix32(h1); h2 = fmix32(h2); h3 = fmix32(h3); h4 = fmix32(h4);
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  out[0] = h1; out[1] = h2; out[2] = h3; out[3] = h4;
}
