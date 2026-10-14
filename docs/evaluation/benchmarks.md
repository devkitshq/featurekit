# Benchmarks

M1 exit criterion (§18): a published benchmark for the hashed and non-hashed
paths.

```bash
npm run build && node tools/bench.mjs
```

Measured against `dist/sdk` — the code that actually ships, not a
transpiled-on-the-fly variant. Node 22.19.0, win32/x64, single core. Raw output
is checked in at [`benchmark-output.txt`](benchmark-output.txt).

## Hash

| Path | ns/op | ops/sec |
| :-- | --: | --: |
| `murmur3Bytes`, 37 bytes | 62 | 16.1M |
| `murmur3Utf8`, ASCII fast path | 74 | 13.5M |
| `murmur3Utf8`, non-ASCII (`TextEncoder` fallback) | 709 | 1.4M |
| `bucket()` | 75 | 13.3M |

The ASCII fast path is worth **~10x** on typical keys. That is the entire
justification for scanning the string before hashing it.

## Evaluate — no hash on the path

| Path | ns/op | ops/sec |
| :-- | --: | --: |
| flag not found | 16 | 61.8M |
| flag off | 50 | 19.8M |
| fallthrough, no rules | 60 | 16.7M |
| individual target match | 65 | 15.3M |
| fixed-variation rule, 2 clauses | 177 | 5.7M |

## Evaluate — percentage rollout (hashed)

| Path | ns/op | ops/sec |
| :-- | --: | --: |
| rollout, ASCII key | 516 | 1.9M |
| rollout, non-ASCII key | 1,110 | 901K |

Squarely inside the 535-976 ns band §1 predicts for the hashed path, and §9.4's
claim holds: **the hash dominates whenever a rollout is involved.**

## Evaluate — segment rules

Re-measured after the switch to 32-bit cuckoo fingerprints, on the same
machine; the 16-bit format's figures are kept for comparison.

| Path | ns/op | ops/sec | 16-bit format |
| :-- | --: | --: | --: |
| roaring hit (exact) | 185 | 5.4M | 274 |
| cuckoo hit (no confirmation needed) | 194 | 5.2M | 399, with confirmation |
| cuckoo miss | 182 | 5.5M | 404 |

## Membership structures, 500k members

| Structure | ns/op | ops/sec | 16-bit format |
| :-- | --: | --: | --: |
| roaring `contains` | 10 | 99.8M | 12 |
| `Set.has` (in-heap baseline) | 14 | 69.4M | 18 |
| cuckoo `contains`, hit | 57 | 17.7M | 140 |
| cuckoo `contains`, miss | 70 | 14.4M | 238 |

Roaring is **faster than a `Set`** on the same data, and exact. The cuckoo
lookup got faster as it got wider: it now hashes the key once (MurmurHash3
x86_128) where the 16-bit format hashed it twice, and hashing is most of the
cost. These are single repeated keys, which flatter every structure;
`tools/bench-segments.mjs` measures 200k distinct uuid keys, where a cuckoo
lookup is ~230 ns against ~470 ns before — see [segments](segments.md).

## Serialized size, 500k members

| Structure | serialized | bits/member |
| :-- | --: | --: |
| cuckoo filter, f=32, 262,144 buckets | 4,194,320 B (4,096 KB) | 67.1 |
| roaring bitmap, sequential ids | 117 B | 0.0019 |

Achieved cuckoo load factor: **0.477** — see below.

## Two places measurement disagreed with the plan

### §1's 14 ns is not attainable for this API

§1 claims 14 ns / ~70M evals/sec/core for the non-hashed paths. Measured: **50
to 177 ns**, i.e. 6-20M/sec/core.

The gap is not slack in the implementation — it was largely closed during M1:

| | flag off, ns/op |
| :-- | --: |
| First implementation (Map + attribute copy per call) | 252 |
| No-allocation context normalisation | 57 |
| Frozen constant `reason` objects | **50** |

What remains is the API's own cost: `evaluate` returns an
`EvaluationDetail<T>` object and accepts a raw context that must be normalised.
Reaching 14 ns means changing the signature §9.2 specifies. The honest headline
is **tens of nanoseconds, millions per second per core**, which still supports
every claim §3 makes. See [decisions §1](../decisions.md).

`flag not found` at 16 ns is the one path that returns before normalising —
which is the clearest evidence of where the rest of the time goes.

### The cuckoo filter is ~2x its quoted size at 500k

The power-of-two bucket count required by the XOR involution puts the achieved
load factor at 0.477 rather than 0.8, so a filter is up to twice the size its
load factor alone predicts. Not a defect — a property of the frozen parameters.
See [decisions §2](../decisions.md). At 32-bit fingerprints that is 4 MB for
500k members.

## Method

`tools/bench.mjs` warms each case 50,000 times, then grows the batch until a
single timed run exceeds 400 ms, and reports wall time over iterations. Results
are XOR-folded into a sink so V8 cannot eliminate the work as dead.

**Run-to-run variance on an unpinned desktop is roughly ±30%** — a second run
of the table above put `murmur3Bytes` at 82 ns rather than 62. Absolute figures
will move with hardware and thermal state; the **ratios** are the durable part,
and they are what every claim on this page rests on:

- ASCII fast path vs `TextEncoder` fallback: ~10x
- rollout vs no rollout: ~10x, i.e. the hash dominates
- roaring vs cuckoo lookup: ~12x
- cuckoo lookup vs `Set.has`: ~8x

None of those ordering relationships moved across runs.
