# featurekit — implementation docs

These pages describe **what is actually built**, the architectural decisions taken,
and the benchmarks and design contracts of FeatureKit.

## Status

| Milestone | Scope | State |
| :-- | :-- | :-- |
| **M1** | Evaluation core — `src/sdk/evaluation/` | **built** |
| **M2** | Drizzle schema, migrations, snapshot compiler | **built** |
| **M3** | Control plane — config, Redis, auth, HTTP, propagation | **built** |
| **M4** | Server-tier delivery, SSE, SDK client, chaos suite | **built** |
| **M5** | Client tier, secure mode, fan-out, React | **built** |
| **M6–M8** | Analytics, dashboard & management | **built** |

**598 tests**, 8 of them skipped: the integration suite needs a container
runtime, and this machine has Docker installed but no running daemon. Those tests
are written and gated, and announce their skip as a visible test rather than a
swallowed `console.warn`.

M1's exit criteria (§18) and their evidence:

| Criterion | Where |
| :-- | :-- |
| Operators, murmur3 bucketing, precedence, multi-context, prerequisites | `tests/evaluation/` |
| Roaring bitmaps and cuckoo filters | [segments](evaluation/segments.md) |
| Three-state clause result, unresolved rule fails closed under negation | [evaluator](evaluation/evaluator.md#fail-closed) |
| Hand-derived conformance corpus, non-ASCII keys, boundary buckets, both negation polarities | [conformance](conformance.md) |
| Published benchmark, hashed and non-hashed paths | [benchmarks](evaluation/benchmarks.md) |
| Hash frozen | [hashing](evaluation/hashing.md) |
| Cuckoo wire format frozen, corpus carries encoded filters | [segments](evaluation/segments.md#wire-format) |
| `alt(alt(i)) === i` across the whole index space, every emittable table size | `tests/evaluation/cuckoo.test.ts` |
| 1M-member import, zero relocation failures, zero rebuilds at α=0.8 | `tests/evaluation/cuckoo-scale.test.ts` |

## Pages

### Evaluation core (M1)

- [The hash](evaluation/hashing.md) — murmur3, why it is frozen, why not SHA-1
- [Bucketing and rollouts](evaluation/bucketing.md) — integer math, independence properties
- [Context](evaluation/context.md) — multi-context, attribute resolution, hot-path shape
- [Operators](evaluation/operators.md) — the clause operators and their type rules
- [Segments](evaluation/segments.md) — cuckoo filters, roaring bitmaps, the unresolved state
- [The evaluator](evaluation/evaluator.md) — precedence, prerequisites, fail-closed rules
- [Benchmarks](evaluation/benchmarks.md) — measured cost of every path
- [The conformance corpus](conformance.md) — how it is generated and why that matters

### Storage and compile (M2)

- [The schema](storage/schema.md) — the shapes, the constraints, the partitioned table
- [The snapshot compiler](storage/compiler.md) — rows to snapshot, purely

### Control plane (M3, M4)

- [Configuration](control-plane/configuration.md) — laptop defaults, production hard-fails
- [Change propagation](control-plane/change-propagation.md) — debounce, compile lock, patch history
- [Server-tier delivery](control-plane/delivery.md) — SSE, resume, polling, capacity
- [The server-tier SDK](sdk/server-sdk.md) — bootstrap, persistence, version guards

### Client tier (M5)

- [The client tier](client-tier/client-sdk.md) — values not rules, `identify` ordering, secure mode
- [The client tier over plain HTTP](client-tier/http.md) — the contract non-JavaScript apps implement
- [Fingerprint-keyed fan-out](client-tier/fanout.md) — 50,000 connections, 20 evaluations
- [Framework adapters](client-tier/adapters.md) — the twenty lines for React, Vue and Svelte

### Throughout

- [Decisions and findings](decisions.md) — **where this implementation departs from the plan, and why**

## Layout

Two packages ship. `featurekit` is server-side — the control plane and the
evaluator that runs inside it. `featurekit-client` is one client for everything
else: browsers, React Native, Node, Deno, Bun and edge runtimes, with no
framework bindings and no per-runtime build. Non-JavaScript apps skip both and
speak [the client-tier HTTP contract](client-tier/http.md) directly.

```
src/                    the `featurekit` package
  sdk/evaluation/       the pure core. imports nothing.
  sdk/client/           FeaturekitSDK: transport, version guards, persistence
  sdk/events/           the summarizer
  secure-mode.ts        featurekit/secure-mode -- signing, node:crypto only
  migrate.ts            featurekit/migrate -- the deploy step, as a function
  db/ repositories/     schema, migrations, row loading
  snapshot/             the compiler (pure) and the propagation service
  redis/                SnapshotStore port + memory and Redis implementations
  http/ routes/         node:http router, SSE, SDK and client-tier routes
  auth/ config/         SDK keys, secure mode, the §17 schema
  evaluation-service/   client-tier evaluation and fingerprint fan-out
packages/
  client/src/index.ts   featurekit-client -- the whole client, zero deps
drizzle/                migrations, including the hand-written partitioned DDL
tests/                  evaluation, conformance, snapshot, control-plane,
                        sdk, client-tier, chaos, integration (container-gated)
tools/                  conformance generator, benchmark harness
docs/                   you are here
```

`src/sdk/` sits inside the control-plane package but may not import from the
rest of `src/`, and may not import a runtime dependency. When the evaluator was
its own package that held for free; now `tools/check-package.mjs` asserts it, so
a stray `../db/schema.js` fails CI rather than quietly making the evaluator
need a database.

## Running things

```bash
npm install
npm test                  # 598 tests
npm run typecheck
npm run build             # tsc -b, emits dist/ and packages/client/dist
node tools/gen-conformance.mjs   # regenerate the corpus
npm run bench             # requires a build first
```
