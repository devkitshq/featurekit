/**
 * Large-segment membership: the shipped structure against the alternatives.
 *
 *   npm run build && node --expose-gc tools/bench-segments.mjs
 *
 * A segment too large to inline is answered from a cuckoo filter with 32-bit
 * fingerprints, hashed once with MurmurHash3 x86_128, and nothing confirms a
 * positive. This keeps that choice measurable against the two structures that
 * could replace it — a hash table of 64-bit key hashes and a `Set` of the keys
 * themselves — and against the hashing it replaced (two x86_32 passes, which
 * was most of the old filter's lookup time). See docs/evaluation/segments.md.
 *
 * Lookups cycle through 200k distinct keys rather than repeating one, so the
 * table is not sitting in L1 and the numbers include the cache misses a real
 * fleet of contexts produces. Keys are UUIDs — the realistic non-integral case
 * (integral keys get an exact roaring bitmap) — as flat strings, the way they
 * arrive from `JSON.parse`.
 */

import { createHash } from "node:crypto";
import { buildCuckooFilter } from "../dist/sdk/evaluation/cuckoo.js";
import { murmur3Utf8, murmur3x86_128 } from "../dist/sdk/evaluation/murmur3.js";

const MEMBERS = 500_000;
const PROBES = 200_000;

let sink = 0;

function measure(fn, probes, { minMs = 500 } = {}) {
  const n = probes.length;
  for (let i = 0; i < n; i++) sink ^= fn(probes[i]) ? 1 : 0;
  let iterations = n;
  for (;;) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) sink ^= fn(probes[i % n]) ? 1 : 0;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMs >= minMs) return (elapsedMs * 1e6) / iterations;
    iterations *= 2;
  }
}

/* ── keys ─────────────────────────────────────────────────────────────── */

function uuid(i, salt) {
  // SHA-256, formatted like a v4 uuid. (A generator built from 32-bit hashes
  // collides at this scale, and those collisions show up as false positives
  // that are not.)
  const h = createHash("sha256").update(`${salt}:${i}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Flat strings: concatenated ones are rope-shaped in V8 and slow to read. */
const flat = (keys) => JSON.parse(JSON.stringify(keys));

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = murmur3Utf8(String(i), 99) % (i + 1) >>> 0;
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const members = flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "member")));
const misses = flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "other")));
const memberSet = new Set(members);
if (misses.some((k) => memberSet.has(k))) throw new Error("a non-member key is a member");
const hits = shuffle(members.slice()).slice(0, PROBES);
const missProbes = misses.slice(0, PROBES);

/* ── the alternative: open addressing over 64-bit key hashes ─────────── */

function nextPow2(n) {
  let c = 1;
  while (c < n) c *= 2;
  return c;
}

const h = new Uint32Array(4);

class HashTable64 {
  constructor(n, load = 0.7) {
    this.mask = nextPow2(Math.ceil(n / load)) - 1;
    this.slots = new Uint32Array((this.mask + 1) * 2);
  }
  insert(key) {
    murmur3x86_128(key, 0, h);
    const a = h[0];
    const b = (h[1] | 1) >>> 0; // never 0, so (0, 0) can mean empty
    const s = this.slots;
    for (let i = a & this.mask; ; i = (i + 1) & this.mask) {
      const o = i * 2;
      if (s[o + 1] === 0) return void ((s[o] = a), (s[o + 1] = b));
      if (s[o] === a && s[o + 1] === b) return;
    }
  }
  contains(key) {
    murmur3x86_128(key, 0, h);
    const a = h[0];
    const b = (h[1] | 1) >>> 0;
    const s = this.slots;
    for (let i = a & this.mask; ; i = (i + 1) & this.mask) {
      const o = i * 2;
      const hi = s[o + 1];
      if (hi === 0) return false;
      if (hi === b && s[o] === a) return true;
    }
  }
}

function setBytes() {
  if (typeof globalThis.gc !== "function") return null;
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  // Fresh strings, so the Set's cost includes the keys it has to keep.
  const set = new Set(flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "member"))));
  globalThis.gc();
  sink ^= set.size;
  return process.memoryUsage().heapUsed - before;
}

/* ── run ─────────────────────────────────────────────────────────────── */

const cuckoo = buildCuckooFilter(members).filter;
const table = new HashTable64(MEMBERS);
for (const key of members) table.insert(key);
for (const [name, s] of [["cuckoo", cuckoo], ["hash table", table]]) {
  if (!members.every((k) => s.contains(k))) throw new Error(`${name} lost a member`);
}

const falsePositives = (contains) => misses.reduce((n, k) => n + (contains(k) ? 1 : 0), 0);
const rows = [
  {
    name: "cuckoo, 32-bit fingerprints (shipped)",
    hit: measure((k) => cuckoo.contains(k), hits),
    miss: measure((k) => cuckoo.contains(k), missProbes),
    bytes: cuckoo.encode().byteLength,
    fp: falsePositives((k) => cuckoo.contains(k)),
  },
  {
    name: "hash table, 64-bit key hashes",
    hit: measure((k) => table.contains(k), hits),
    miss: measure((k) => table.contains(k), missProbes),
    bytes: table.slots.byteLength,
    fp: falsePositives((k) => table.contains(k)),
  },
  {
    name: "Set<string> of the keys",
    hit: measure((k) => memberSet.has(k), hits),
    miss: measure((k) => memberSet.has(k), missProbes),
    bytes: setBytes(),
    fp: falsePositives((k) => memberSet.has(k)),
  },
];
const hashing = [
  ["MurmurHash3 x86_128, one pass (shipped)", measure((k) => (murmur3x86_128(k, 0, h), h[0] & 1), hits)],
  ["MurmurHash3 x86_32 twice (the 16-bit format)", measure((k) => (murmur3Utf8(k, 0) ^ murmur3Utf8(k, 1)) & 1, hits)],
];

const kb = (b) => (b === null ? "n/a (run with --expose-gc)" : `${Math.round(b / 1024).toLocaleString("en-US")} KB`);
console.log(`\n${MEMBERS.toLocaleString("en-US")} members (uuid keys), ${PROBES.toLocaleString("en-US")} distinct probe keys, Node ${process.versions.node}\n`);
console.log("| Structure | hit ns/op | miss ns/op | size | false positives / 500k non-members |");
console.log("| :-- | --: | --: | --: | --: |");
for (const r of rows) {
  console.log(`| ${r.name} | ${r.hit.toFixed(0)} | ${r.miss.toFixed(0)} | ${kb(r.bytes)} | ${r.fp} |`);
}
console.log("\n| Hashing only | ns/op |\n| :-- | --: |");
for (const [label, ns] of hashing) console.log(`| ${label} | ${ns.toFixed(0)} |`);
console.log(`\n(sink ${sink & 1})`);
