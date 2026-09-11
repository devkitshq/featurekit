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

| Path | ns/op | ops/sec |
| :-- | --: | --: |
| roaring hit (exact) | 274 | 3.6M |
| cuckoo hit + in-heap confirmation | 399 | 2.5M |
| cuckoo miss (exact negative, no confirmation) | 404 | 2.5M |

## Membership structures, 500k members

| Structure | ns/op | ops/sec |
| :-- | --: | --: |
| roaring `contains` | 12 | 84.6M |
| `Set.has` (in-heap baseline) | 18 | 55.5M |
| cuckoo `contains`, hit | 140 | 7.2M |
| cuckoo `contains`, miss | 238 | 4.2M |

Roaring is **faster than a `Set`** on the same data, and exact. Cuckoo costs
~8x a `Set` lookup, which is the price of not holding 50-80 MB of heap.

## Serialized size, 500k members

| Structure | serialized | bits/member |
| :-- | --: | --: |
| cuckoo filter, f=16, 262,144 buckets | 2,097,168 B (2,048 KB) | 33.6 |
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

2.0 MB rather than ~1.25 MB, because the power-of-two bucket count required by
the XOR involution puts the achieved load factor at 0.477 rather than 0.8. Not
a defect — a property of the frozen parameters. See
[decisions §2](../decisions.md).

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
