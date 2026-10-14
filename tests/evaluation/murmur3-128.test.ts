/**
 * MurmurHash3 x86_128 against the C reference.
 *
 * The cuckoo filter takes its bucket and fingerprint from this hash, so it is
 * a wire format: a port that disagrees by one bit cannot find members a filter
 * was built with. The vectors come from the original C implementation, not
 * from this code.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { murmur3x86_128 } from "../../src/sdk/evaluation/murmur3.js";

const { vectors } = JSON.parse(
  readFileSync(join(import.meta.dirname, "murmur3-128-vectors.json"), "utf8"),
) as { vectors: Array<[string, number, [number, number, number, number]]> };

describe("murmur3x86_128", () => {
  it("has a vector for every tail length and the UTF-8 path", () => {
    const lengths = new Set(vectors.map(([key]) => new TextEncoder().encode(key).length % 16));
    expect(lengths.size).toBe(16);
    expect(vectors.some(([key]) => /[^\x00-\x7f]/.test(key))).toBe(true);
  });

  it.each(vectors)("matches the reference for %j with seed %i", (key, seed, expected) => {
    const out = new Uint32Array(4);
    murmur3x86_128(key, seed, out);
    expect([...out]).toEqual(expected);
  });

  it("gives the same answer for a key built by concatenation", () => {
    // Rope-shaped strings take a different path through V8's charCodeAt.
    const flat = new Uint32Array(4);
    const rope = new Uint32Array(4);
    murmur3x86_128("94f7804b-762d-437d-a030-5424a79384f1", 0, flat);
    murmur3x86_128(["94f7804b", "762d", "437d", "a030", "5424a79384f1"].join("-"), 0, rope);
    expect([...rope]).toEqual([...flat]);
  });
});
