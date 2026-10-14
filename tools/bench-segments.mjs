/**
 * Large-segment membership: which structure, measured.
 *
 *   npm run build && node --expose-gc tools/bench-segments.mjs
 *
 * A segment too large to inline needs a structure the SDK can query
 * synchronously. Today that is a 16-bit cuckoo filter whose positives must be
 * confirmed elsewhere — and nothing in the control plane confirms them. This
 * compares it against structures that need no confirmation, on the three
 * things that matter: lookup time, bytes, and false positives.
 *
 * Lookups cycle through 200k distinct keys rather than repeating one, so the
 * table is not sitting in L1 and the numbers include the cache misses a real
 * fleet of contexts produces. Keys are UUIDs — the realistic non-integral case
 * (integral keys already get an exact roaring bitmap).
 *
 * The 32-bit cuckoo and the hash table are prototypes defined here, not
 * shipped code.
 */

import { createHash } from "node:crypto";
import { buildCuckooFilter } from "../dist/sdk/evaluation/cuckoo.js";
import { murmur3Bytes, murmur3Utf8 } from "../dist/sdk/evaluation/murmur3.js";

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
  // Deterministic and collision-free in practice: SHA-256, formatted like a v4
  // uuid. (A generator built from 32-bit hashes collides at this scale, and
  // those collisions show up as false positives that are not.)
  const h = createHash("sha256").update(`${salt}:${i}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Flat strings, the way context keys arrive from `JSON.parse`. Strings built
 * by concatenation are rope-shaped in V8 and slow to read per character,
 * which would bill the hash for V8's string representation.
 */
const flat = (keys) => JSON.parse(JSON.stringify(keys));

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = murmur3Utf8(String(i), 99) % (i + 1) >>> 0;
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const members = flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "member")));
const hits = shuffle(members.slice()).slice(0, PROBES);
const misses = flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "other")));
{
  const memberSet = new Set(members);
  if (misses.some((k) => memberSet.has(k))) throw new Error("a non-member key is a member");
}
const missProbes = misses.slice(0, PROBES);

/* ── hashing ─────────────────────────────────────────────────────────── */

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Two independent 32-bit murmur3 lanes over the same characters in one pass
 * (ASCII keys). The second lane is left in `lane2`.
 */
let lane2 = 0;
function murmur3x2(s, seed) {
  let h1 = seed >>> 0;
  let h2 = (seed ^ 0x9747b28c) >>> 0;
  const len = s.length;
  const blocks = len & ~3;
  for (let i = 0; i < blocks; i += 4) {
    let k =
      s.charCodeAt(i) |
      (s.charCodeAt(i + 1) << 8) |
      (s.charCodeAt(i + 2) << 16) |
      (s.charCodeAt(i + 3) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h1 ^= k;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
    h2 ^= k;
    h2 = (h2 << 13) | (h2 >>> 19);
    h2 = (Math.imul(h2, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const rem = len & 3;
  if (rem > 2) k ^= s.charCodeAt(blocks + 2) << 16;
  if (rem > 1) k ^= s.charCodeAt(blocks + 1) << 8;
  if (rem > 0) {
    k ^= s.charCodeAt(blocks);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h1 ^= k;
    h2 ^= k;
  }
  lane2 = fmix32(h2 ^ len);
  return fmix32(h1 ^ len);
}

/* ── candidates ──────────────────────────────────────────────────────── */

function nextPow2(n) {
  let c = 1;
  while (c < n) c *= 2;
  return c;
}

/** Cuckoo filter, 32-bit fingerprints, hashed exactly as the shipped one is. */
class Cuckoo32SameHashing {
  constructor(n) {
    this.buckets = nextPow2(Math.ceil(n / (4 * 0.8)));
    this.mask = this.buckets - 1;
    this.slots = new Uint32Array(this.buckets * 4);
  }
  fp(key) {
    const f = murmur3Utf8(key, 0x9747b28c) >>> 0;
    return f === 0 ? 1 : f;
  }
  index(key) {
    return murmur3Utf8(key, 0) & this.mask;
  }
  alt(i, fp) {
    const scratch = new Uint8Array(4);
    scratch[0] = fp & 0xff;
    scratch[1] = (fp >>> 8) & 0xff;
    scratch[2] = (fp >>> 16) & 0xff;
    scratch[3] = fp >>> 24;
    let h = murmur3Bytes(scratch, 0x5bd1e995) & this.mask;
    if (h === 0) h = 1 & this.mask;
    return (i ^ h) & this.mask;
  }
  has(b, fp) {
    const o = b * 4, s = this.slots;
    return s[o] === fp || s[o + 1] === fp || s[o + 2] === fp || s[o + 3] === fp;
  }
  put(b, fp) {
    const o = b * 4, s = this.slots;
    for (let j = 0; j < 4; j++) if (s[o + j] === 0) return (s[o + j] = fp), true;
    return false;
  }
  insert(key) {
    let fp = this.fp(key);
    let i = this.index(key);
    if (this.put(i, fp) || this.put(this.alt(i, fp), fp)) return true;
    for (let kick = 0; kick < 500; kick++) {
      const j = (kick * 7) & 3;
      const o = i * 4 + j;
      const evicted = this.slots[o];
      this.slots[o] = fp;
      fp = evicted;
      i = this.alt(i, fp);
      if (this.put(i, fp)) return true;
    }
    throw new Error("cuckoo32: insert failed");
  }
  contains(key) {
    const fp = this.fp(key);
    const i = this.index(key);
    return this.has(i, fp) || this.has(this.alt(i, fp), fp);
  }
  get bytes() {
    return this.slots.byteLength;
  }
}

/** Same table, one pass over the key, and an allocation-free alternate bucket. */
class Cuckoo32OnePass extends Cuckoo32SameHashing {
  alt(i, fp) {
    let h = fmix32(fp ^ 0x5bd1e995) & this.mask;
    if (h === 0) h = 1 & this.mask;
    return (i ^ h) & this.mask;
  }
  insert(key) {
    const i = murmur3x2(key, 0) & this.mask;
    const fp = lane2 === 0 ? 1 : lane2;
    return this.insertRaw(i, fp);
  }
  insertRaw(i, fp) {
    if (this.put(i, fp) || this.put(this.alt(i, fp), fp)) return true;
    for (let kick = 0; kick < 500; kick++) {
      const j = (kick * 7) & 3;
      const o = i * 4 + j;
      const evicted = this.slots[o];
      this.slots[o] = fp;
      fp = evicted;
      i = this.alt(i, fp);
      if (this.put(i, fp)) return true;
    }
    throw new Error("cuckoo32: insert failed");
  }
  contains(key) {
    const i = murmur3x2(key, 0) & this.mask;
    const fp = lane2 === 0 ? 1 : lane2;
    return this.has(i, fp) || this.has(this.alt(i, fp), fp);
  }
}

/** Open addressing over 64-bit key hashes (two lanes), linear probing. */
class HashTable64 {
  constructor(n, load = 0.7) {
    this.capacity = nextPow2(Math.ceil(n / load));
    this.mask = this.capacity - 1;
    this.slots = new Uint32Array(this.capacity * 2);
  }
  insert(key) {
    const a = murmur3x2(key, 0);
    const b = (lane2 | 1) >>> 0; // never 0, so (0, 0) can mean empty
    let i = a & this.mask;
    const s = this.slots;
    for (;;) {
      const o = i * 2;
      if (s[o + 1] === 0) return (s[o] = a), (s[o + 1] = b), true;
      if (s[o] === a && s[o + 1] === b) return true;
      i = (i + 1) & this.mask;
    }
  }
  contains(key) {
    const a = murmur3x2(key, 0);
    const b = (lane2 | 1) >>> 0;
    let i = a & this.mask;
    const s = this.slots;
    for (;;) {
      const o = i * 2;
      const hi = s[o + 1];
      if (hi === 0) return false;
      if (hi === b && s[o] === a) return true;
      i = (i + 1) & this.mask;
    }
  }
  get bytes() {
    return this.slots.byteLength;
  }
}

/* ── memory of a Set, which holds the strings themselves ─────────────── */

function setBytes() {
  if (typeof globalThis.gc !== "function") return null;
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  // Fresh strings, so the Set's cost includes the keys it has to keep.
  const set = new Set(flat(Array.from({ length: MEMBERS }, (_, i) => uuid(i, "member"))));
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  sink ^= set.size;
  return after - before;
}

/* ── run ─────────────────────────────────────────────────────────────── */

const cuckoo16 = buildCuckooFilter(members, { fingerprintBits: 16 }).filter;
const confirm = new Set(members);
const same32 = new Cuckoo32SameHashing(MEMBERS);
for (const key of members) same32.insert(key);
const onePass32 = new Cuckoo32OnePass(MEMBERS);
for (const key of members) onePass32.insert(key);
const table64 = new HashTable64(MEMBERS);
for (const key of members) table64.insert(key);

for (const [name, s] of [["cuckoo32 same hashing", same32], ["cuckoo32 one pass", onePass32], ["hash table 64", table64]]) {
  if (!members.every((k) => s.contains(k))) throw new Error(`${name} lost a member`);
}

const falsePositives = (contains) => misses.reduce((n, k) => n + (contains(k) ? 1 : 0), 0);

const rows = [
  {
    name: "cuckoo f=16 (today), filter only",
    hit: measure((k) => cuckoo16.contains(k), hits),
    miss: measure((k) => cuckoo16.contains(k), missProbes),
    bytes: cuckoo16.encode().byteLength,
    fp: falsePositives((k) => cuckoo16.contains(k)),
    note: "positives need confirming",
  },
  {
    name: "cuckoo f=16 + Set confirm",
    hit: measure((k) => cuckoo16.contains(k) && confirm.has(k), hits),
    miss: measure((k) => cuckoo16.contains(k) && confirm.has(k), missProbes),
    bytes: null,
    fp: falsePositives((k) => cuckoo16.contains(k) && confirm.has(k)),
    note: "today, if confirmation were wired up",
  },
  {
    name: "cuckoo f=32, same hashing",
    hit: measure((k) => same32.contains(k), hits),
    miss: measure((k) => same32.contains(k), missProbes),
    bytes: same32.bytes,
    fp: falsePositives((k) => same32.contains(k)),
    note: "~1.9e-9 expected",
  },
  {
    name: "cuckoo f=32, one-pass hash",
    hit: measure((k) => onePass32.contains(k), hits),
    miss: measure((k) => onePass32.contains(k), missProbes),
    bytes: onePass32.bytes,
    fp: falsePositives((k) => onePass32.contains(k)),
    note: "~1.9e-9 expected",
  },
  {
    name: "hash table, 64-bit hashes",
    hit: measure((k) => table64.contains(k), hits),
    miss: measure((k) => table64.contains(k), missProbes),
    bytes: table64.bytes,
    fp: falsePositives((k) => table64.contains(k)),
    note: "~2.7e-14 expected",
  },
  {
    name: "Set<string> (exact)",
    hit: measure((k) => confirm.has(k), hits),
    miss: measure((k) => confirm.has(k), missProbes),
    bytes: setBytes(),
    fp: falsePositives((k) => confirm.has(k)),
    note: "heap, keys included",
  },
];

const hashing = [
  ["murmur3Utf8 x2 (today's cuckoo hashing)", measure((k) => (murmur3Utf8(k, 0) ^ murmur3Utf8(k, 1)) & 1, hits)],
  ["murmur3x2, one pass", measure((k) => murmur3x2(k, 0) & 1, hits)],
];

const kb = (b) => (b === null ? "n/a" : `${Math.round(b / 1024).toLocaleString("en-US")} KB`);
console.log(`\n${MEMBERS.toLocaleString("en-US")} members (uuid keys), ${PROBES.toLocaleString("en-US")} distinct probe keys, Node ${process.versions.node}\n`);
console.log("| Structure | hit ns/op | miss ns/op | size | false positives / 500k misses | |");
console.log("| :-- | --: | --: | --: | --: | :-- |");
for (const r of rows) {
  console.log(`| ${r.name} | ${r.hit.toFixed(0)} | ${r.miss.toFixed(0)} | ${kb(r.bytes)} | ${r.fp} | ${r.note} |`);
}
console.log("\n| Hashing only | ns/op |\n| :-- | --: |");
for (const [label, ns] of hashing) console.log(`| ${label} | ${ns.toFixed(0)} |`);
console.log(`\n(sink ${sink & 1})`);
