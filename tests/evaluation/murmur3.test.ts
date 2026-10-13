import { describe, expect, it } from "vitest";
import { murmur3Bytes, murmur3Utf8 } from "../../src/sdk/evaluation/murmur3.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Reference MurmurHash3_x86_32 vectors. These are published values for the
 * canonical Austin Appleby implementation — NOT captured from this codebase.
 * The corpus must not certify the implementation against itself.
 */
describe("murmur3 x86_32 — published reference vectors", () => {
  const vectors: [input: string, seed: number, expected: number][] = [
    ["", 0x00000000, 0x00000000],
    ["", 0x00000001, 0x514e28b7],
    ["", 0xffffffff, 0x81f16f39],
    ["test", 0x00000000, 0xba6bd213],
    ["test", 0x9747b28c, 0x704b81dc],
    ["Hello, world!", 0x00000000, 0xc0363e43],
    ["Hello, world!", 0x9747b28c, 0x24884cba],
    ["The quick brown fox jumps over the lazy dog", 0x00000000, 0x2e4ff723],
    ["The quick brown fox jumps over the lazy dog", 0x9747b28c, 0x2fa826cd],
    ["a", 0x9747b28c, 0x7fa09ea6],
    ["ab", 0x9747b28c, 0x74875592],
    ["abc", 0x9747b28c, 0xc84a62dd],
    ["abcd", 0x9747b28c, 0xf0478627],
    ["aa", 0x9747b28c, 0x5d211726],
    ["aaa", 0x9747b28c, 0x283e0130],
    ["aaaa", 0x9747b28c, 0x5a97808a],
  ];

  for (const [input, seed, expected] of vectors) {
    it(`hashes ${JSON.stringify(input)} @ seed 0x${seed.toString(16)}`, () => {
      expect(murmur3Bytes(utf8(input), seed)).toBe(expected);
    });
  }
});

describe("murmur3 — tail handling across every length residue", () => {
  // Lengths 0..8 exercise every branch of the 4-byte block loop plus each of
  // the three tail cases. A tail bug is invisible at length 4 and 8.
  it("is stable and distinct across lengths 0..16", () => {
    const seen = new Map<number, number>();
    for (let n = 0; n <= 16; n++) {
      const h = murmur3Bytes(utf8("x".repeat(n)), 0);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
      seen.set(n, h);
    }
    expect(new Set(seen.values()).size).toBe(17);
  });
});

describe("murmur3Utf8 — bytes, not UTF-16 code units", () => {
  it("hashes non-ASCII as UTF-8 bytes", () => {
    // "é" is U+00E9: one UTF-16 code unit (233), two UTF-8 bytes (0xC3 0xA9).
    // A charCodeAt implementation would hash [233] and diverge from every
    // other language. This asserts the byte spelling explicitly.
    expect(murmur3Utf8("é")).toBe(murmur3Bytes(new Uint8Array([0xc3, 0xa9]), 0));
    expect(murmur3Utf8("é")).not.toBe(murmur3Bytes(new Uint8Array([0xe9]), 0));
  });

  it("hashes a non-ASCII context key the way a UTF-8 reader would", () => {
    expect(murmur3Utf8("usr_josé")).toBe(murmur3Bytes(utf8("usr_josé"), 0));
  });

  it("handles astral-plane characters (surrogate pairs) as 4 UTF-8 bytes", () => {
    expect(murmur3Utf8("🚀")).toBe(murmur3Bytes(new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]), 0));
  });

  it("handles a lone surrogate the way TextEncoder does (U+FFFD)", () => {
    expect(murmur3Utf8("\ud800")).toBe(murmur3Utf8("\ufffd"));
  });
});

describe("murmur3Utf8 — ASCII fast path is byte-identical to the UTF-8 path", () => {
  it("agrees with TextEncoder on every single-byte ASCII code point", () => {
    for (let c = 0; c < 128; c++) {
      const s = String.fromCharCode(c);
      expect(murmur3Utf8(s)).toBe(murmur3Bytes(utf8(s), 0));
    }
  });

  it("agrees on mixed-length ASCII strings, including block boundaries", () => {
    for (let n = 0; n <= 64; n++) {
      const s = "ctx_key_".repeat(8).slice(0, n);
      expect(murmur3Utf8(s)).toBe(murmur3Bytes(utf8(s), 0));
    }
  });

  it("agrees on strings that begin ASCII and turn multi-byte late", () => {
    // The fast path must not commit to ASCII before scanning the whole string.
    const s = "aaaaaaaaaaaaaaaaaaaaaaaaé";
    expect(murmur3Utf8(s)).toBe(murmur3Bytes(utf8(s), 0));
  });

  it("agrees under a non-zero seed", () => {
    expect(murmur3Utf8("usr_7f3a91", 0x9747b28c)).toBe(murmur3Bytes(utf8("usr_7f3a91"), 0x9747b28c));
  });
});

describe("murmur3 — output domain", () => {
  it("returns an unsigned 32-bit integer for adversarial inputs", () => {
    for (const s of ["", "\0", "\0\0\0\0", "ÿÿÿÿ", "🚀🚀🚀🚀", "z".repeat(1000)]) {
      const h = murmur3Utf8(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
