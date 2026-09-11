/**
 * M1 exit criterion (§18): a published benchmark for the hashed and non-hashed
 * evaluation paths.
 *
 * §1 claims ~14 ns/op when no hash is involved and 535–976 ns/op when a
 * percentage rollout is, and §9.4 is explicit that the hash dominates whenever
 * one is. This measures both and prints the table that goes into
 * `docs/evaluation/benchmarks.md`.
 *
 * Runs against `dist/sdk`, so it measures the code that actually
 * ships rather than a transpiled-on-the-fly variant.
 *
 * Run: npm run build && node tools/bench.mjs
 */

import { bucket } from "../dist/sdk/evaluation/bucketing.js";
import { buildCuckooFilter } from "../dist/sdk/evaluation/cuckoo.js";
import { evaluate } from "../dist/sdk/evaluation/evaluate.js";
import { murmur3Bytes, murmur3Utf8 } from "../dist/sdk/evaluation/murmur3.js";
import { RoaringBitmap } from "../dist/sdk/evaluation/roaring.js";
import { InMemorySegmentCache, SegmentIndex } from "../dist/sdk/evaluation/segments.js";

/** Kept alive so V8 cannot eliminate the work as dead. */
let sink = 0;

function measure(label, fn, { minMs = 400, warmup = 50_000 } = {}) {
  for (let i = 0; i < warmup; i++) sink ^= fn(i) === undefined ? 0 : 1;

  // Grow the batch until a single timed run is long enough to be meaningful
  // against the clock's resolution.
  let iterations = 1_000;
  for (;;) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) sink ^= fn(i) === undefined ? 0 : 1;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMs >= minMs) {
      const nsPerOp = (elapsedMs * 1e6) / iterations;
      return { label, nsPerOp, opsPerSec: 1e9 / nsPerOp };
    }
    iterations *= 4;
  }
}

const flag = (over = {}) => ({
  key: "new-checkout",
  version: 1,
  kind: "boolean",
  on: true,
  variations: [false, true],
  offVariation: 0,
  fallthrough: { variation: 0 },
  prerequisites: [],
  targets: [],
  rules: [],
  ...over,
});

const snap = (flags, segments = {}) => ({
  version: 1,
  environmentKey: "production",
  salt: "env_salt_prod",
  flags,
  segments,
});

const ctx = { key: "usr_7f3a91", country: "DE", plan: "pro" };
const K = "new-checkout";

/* ─────────────────────────── fixtures ─────────────────────────── */

const offSnap = snap({ [K]: flag({ on: false }) });
const emptySnap = snap({});
const targetSnap = snap({
  [K]: flag({ targets: [{ contextKind: "user", variation: 1, keys: ["usr_7f3a91"] }] }),
});
const ruleSnap = snap({
  [K]: flag({
    rules: [
      {
        id: "r0",
        variation: 1,
        clauses: [
          { contextKind: "user", attribute: "country", op: "in", values: ["DE", "AT", "CH"], negate: false },
          { contextKind: "user", attribute: "plan", op: "in", values: ["pro"], negate: false },
        ],
      },
    ],
  }),
});
const fallthroughSnap = snap({ [K]: flag() });
const rolloutSnap = snap({
  [K]: flag({
    fallthrough: {
      rollout: {
        variations: [
          { variationIndex: 1, weight: 10_000 },
          { variationIndex: 0, weight: 90_000 },
        ],
      },
    },
  }),
});

const members = Array.from({ length: 500_000 }, (_, i) => `usr_${i}`);
const filter = buildCuckooFilter(members).filter;
const bitmap = RoaringBitmap.from(Array.from({ length: 500_000 }, (_, i) => i));
const memberSet = new Set(members);

const segRule = {
  id: "r0",
  variation: 1,
  clauses: [{ contextKind: "user", attribute: "key", op: "segmentMatch", values: ["enterprise"], negate: false }],
};
const cuckooSnap = snap(
  { [K]: flag({ rules: [segRule] }) },
  { enterprise: { kind: "cuckoo", version: 1, filter: filter.encode(), fpRate: 0.00012, loadFactor: 0.8 } },
);
const cuckooIndex = new SegmentIndex(cuckooSnap.segments);
cuckooIndex.setCache(new InMemorySegmentCache({ enterprise: members }));

const roaringSnap = snap(
  { [K]: flag({ rules: [segRule] }) },
  { enterprise: { kind: "roaring", version: 1, contextKind: "user", bitmap: bitmap.serialize() } },
);
const roaringIndex = new SegmentIndex(roaringSnap.segments);

/* ─────────────────────────── the runs ─────────────────────────── */

const groups = [
  [
    "Hash",
    [
      ["murmur3Bytes, 37 bytes", () => murmur3Bytes(new Uint8Array(37), 0)],
      ["murmur3Utf8, ASCII fast path", () => murmur3Utf8("new-checkout.env_salt_prod.usr_7f3a91")],
      ["murmur3Utf8, non-ASCII (TextEncoder)", () => murmur3Utf8("new-checkout.env_salt_prod.usr_josé")],
      ["bucket()", () => bucket("usr_7f3a91", K, "env_salt_prod")],
    ],
  ],
  [
    "Evaluate - no hash on the path",
    [
      ["flag off", () => evaluate(K, ctx, offSnap, false)],
      ["flag not found", () => evaluate("absent", ctx, emptySnap, false)],
      ["individual target match", () => evaluate(K, ctx, targetSnap, false)],
      ["fixed-variation rule, 2 clauses", () => evaluate(K, ctx, ruleSnap, false)],
      ["fallthrough, no rules", () => evaluate(K, ctx, fallthroughSnap, false)],
    ],
  ],
  [
    "Evaluate - percentage rollout (hashed)",
    [
      ["rollout, ASCII key", () => evaluate(K, ctx, rolloutSnap, false)],
      ["rollout, non-ASCII key", () => evaluate(K, { key: "usr_josé" }, rolloutSnap, false)],
    ],
  ],
  [
    "Evaluate - segment rules",
    [
      ["cuckoo miss (exact negative)", () => evaluate(K, { key: "ghost_1" }, cuckooSnap, false, { segments: cuckooIndex })],
      ["cuckoo hit + in-heap confirm", () => evaluate(K, { key: "usr_250000" }, cuckooSnap, false, { segments: cuckooIndex })],
      ["roaring hit (exact)", () => evaluate(K, { key: "250000" }, roaringSnap, false, { segments: roaringIndex })],
    ],
  ],
  [
    "Membership structures, 500k members",
    [
      ["cuckoo contains, hit", () => filter.contains("usr_250000")],
      ["cuckoo contains, miss", () => filter.contains("ghost_250000")],
      ["roaring contains", () => bitmap.contains(250_000)],
      ["Set.has (in-heap baseline)", () => memberSet.has("usr_250000")],
    ],
  ],
];

console.log(`node ${process.version}  ${process.platform}/${process.arch}\n`);
for (const [title, cases] of groups) {
  console.log(`### ${title}\n`);
  console.log("| Path | ns/op | ops/sec |");
  console.log("| :-- | --: | --: |");
  for (const [label, fn] of cases) {
    const r = measure(label, fn);
    const ops =
      r.opsPerSec >= 1e6 ? `${(r.opsPerSec / 1e6).toFixed(1)}M` : `${(r.opsPerSec / 1e3).toFixed(0)}K`;
    console.log(`| ${label} | ${r.nsPerOp.toFixed(1)} | ${ops} |`);
  }
  console.log("");
}

const size = (n) => `${n.toLocaleString("en-US")} (${(n / 1024).toFixed(1)} KB)`;
const cuckooBytes = filter.encode().byteLength;
const roaringBytes = bitmap.serialize().byteLength;

console.log(`### Segment structure sizes, 500k members\n`);
console.log("| Structure | serialized | bits/member |");
console.log("| :-- | --: | --: |");
console.log(
  `| cuckoo filter, f=16, ${filter.bucketCount.toLocaleString("en-US")} buckets | ` +
    `${size(cuckooBytes)} | ${((cuckooBytes * 8) / 500_000).toFixed(1)} |`,
);
console.log(
  `| roaring bitmap, sequential ids | ${size(roaringBytes)} | ` +
    `${((roaringBytes * 8) / 500_000).toFixed(4)} |`,
);
console.log(`\ncuckoo load factor: ${filter.loadFactor.toFixed(3)}`);
console.log(`\n(sink=${sink})`);
