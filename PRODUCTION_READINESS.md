# featurekit — production readiness gate

The work required to pass [`Production Readiness Review Prompt.md`](Production%20Readiness%20Review%20Prompt.md).

Derived by reading that prompt against the repository, and **updated in place as
work lands** — the status here is what exists, not what is planned.

**Legend:** `[ ]` not started · `[~]` partially done · `[x]` done · `[!]` blocked
**Priority:** **P0** = 🔴 NOT READY while open · **P1** = 🟡 conditions ·
**P2** = post-launch.

---

## 0. Verdict

**First review: 🔴 NOT READY.** No runnable system, no write path, and nothing
ever executed against a real Postgres or Redis.

**Now: 🟢 READY, with the launch conditions below met.** Every Gate A blocker is
closed, the container-gated suites run and pass, and the claims the review
called UNVERIFIED are either proven or explicitly restated. **978 tests pass,
zero skipped**, against real Postgres and Redis.

The remaining honest qualifications — none of them blocking, all of them stated
rather than buried:

1. **Load figures come from one developer laptop** (`docs/ops/deployment.md`),
   not from a soak on production-shaped hardware. The numbers are labelled as
   measured-here, and the first bottleneck is named.
2. **The cross-language port is Python, not Go.** It proves the wire format and
   semantics are portable and it found two real gaps doing so, but a Go SDK will
   still be the first consumer written by somebody who was not in this room.
3. **ReDoS protection is a heuristic**, documented as one. The exponential
   shapes are rejected and inputs are capped; a polynomial-backtracking pattern
   can still be slow. Closing that properly needs a linear-time engine.
4. **Idempotency is per node.** It covers the retry that happens in practice and
   falls back to the version check otherwise.

---

## 0.1 What the work actually found

Fourteen defects, each caught by something written for this gate rather than by
inspection. Listed because they are the argument for the tests, not the code.

| # | Found by | Defect |
| --: | :-- | :-- |
| 1 | Container-gated store contract | **Redis trimmed patch history approximately** (`MAXLEN ~`), so the two stores disagreed about when a reconnect degrades to a full `put` — under load, in production, on one of them |
| 2 | Adversarial evaluator corpus | **`^(a\|a)*$` ran for 291 seconds.** The first ReDoS guard caught nested quantifiers only, and missed overlapping alternation entirely |
| 3 | Memory suite | **Rate limiter went quadratic during a Redis outage** — same-window counters meant the prune freed nothing, so it rescanned a growing map on every request |
| 4 | Two-node client test | Client tier answered `409` to every browser whose POST and stream landed on different nodes — i.e. every multi-node deployment |
| 5 | Audit chain test | Hash covered `JSON.stringify(diff)`, which `jsonb` does not round-trip — the chain failed to verify on a log nobody had touched |
| 6 | Audit chain test | `created_at` is transaction-start time, so rows written together tie and "the previous row" had no single answer |
| 7 | Load harness | Every snapshot poll ran serialize → parse → stringify: three passes over the whole ruleset, per request |
| 8 | Package contents check | All three npm packages were shipping **source maps** |
| 9 | Python conformance port | The **cuckoo header layout was documented nowhere** — the first decoder put two fields in the wrong order and every lookup missed |
| 10 | Python conformance port | `cuckoo.json` promised "a porting SDK must read THESE bytes" and **shipped no bytes** |
| 11 | Body-limit test | `req.destroy()` on an oversized body severed the socket before the 413 could be written |
| 12 | Redis hardening | `enableOfflineQueue: false` broke the startup window; `commandTimeout: 0` meant *immediate* timeout, not disabled — it tore down the subscriber |
| 13 | Client-tier leak test | A substring assertion against a random connection handle: the new 256-bit ids eventually contain any short needle, and one did |
| 14 | Density measurement | The `auto` filter question resolved by measuring: roaring wins everywhere realistic, so **no threshold was added** |

---

## 0.2 What changed across both passes

| Area | Before | Now |
| :-- | :-- | :-- |
| Startup | Assembled only in tests | `src/app.ts` + `src/main.ts`; boots, drains, exits on signals |
| SDK auth | Unimplemented dependency | Indexed lookup, 30s revocation bound, asserted |
| Write path | None | Full management API, all resources |
| Authorization | None | PAT + roles + environment scope, filtered in SQL, 404 not 403 |
| Concurrent edits | Silent overwrite | `FOR UPDATE` + `expectedVersion` → 409 with current state |
| Audit | Table with no writer | Full before/after, same transaction, revert, **hash-chained** |
| Governance | Tables with no reader | Scheduled changes with `SKIP LOCKED`, four-eyes approvals |
| Redis down | 500 to every SDK | Memory → Postgres, behind a circuit breaker so it is *fast* |
| Client tier | Single-node only | Shared connection store; a second node takes over |
| Kill switch | Behind debounce and lock | Own endpoint, no version, undebounced |
| Secure mode | A call-site flag | Derived from `environments.is_production` |
| Rate limiting | A key name in a comment | Sliding window, per environment, degrades *tighter* |
| ReDoS | Length cap only | Both exponential shapes rejected, inputs capped, patterns cached |
| Segments | Whole table in one query | Keyset pagination + a loud ceiling; Redis provider for large ones |
| Analytics | No writer at all | Bounded buffer → sharded rollup → idempotent upsert → DLQ |
| Snapshot delivery | Re-serialised per request | Cached per version, **brotli: 2.43 MB → 20 KB** |
| Observability | Deps imported nowhere | Structured logs, request ids, W3C trace context, ~26 metrics |
| Conformance | Corpus with one consumer | **Python implementation, 102 checks, in CI** |
| Tests | 590, 8 never run | **978, all run, against real infrastructure** |

---

## 1. Implementation reality (review §1)

| Component | File(s) | Classification |
| :-- | :-- | :-- |
| Evaluator | `src/sdk/evaluation/evaluate.ts` | Implemented; unit-verified **and fuzzed** |
| Bucketing / murmur3 | `src/sdk/evaluation/{bucketing,murmur3}.ts` | Implemented; frozen by a golden corpus **and a second language** |
| Regex safety | `src/sdk/evaluation/regex.ts` | Implemented and verified; heuristic, documented as one |
| Operators, context | `src/sdk/evaluation/{operators,context}.ts` | Implemented and verified |
| Cuckoo / roaring filters | `src/sdk/evaluation/{cuckoo,roaring}.ts` | Implemented; wire format decoded independently in Python |
| Segment membership | `src/sdk/evaluation/segments.ts` | Implemented and verified (fail-closed) |
| Snapshot compiler | `src/snapshot/compile.ts` | Implemented and verified |
| Snapshot service + last-known-good | `src/snapshot/service.ts` | Implemented; Redis-loss and version-regression paths verified against real Redis |
| Redis store | `src/redis/redis-store.ts` | Implemented and verified, including atomic commit, TLS options and a circuit breaker |
| Redis segment cache | `src/redis/segment-cache.ts` | Implemented and verified against real Redis |
| Client connection store | `src/client-tier/connection-store.ts`, `src/redis/client-connections.ts` | Implemented; **two-node takeover verified** |
| SDK delivery routes | `src/routes/sdk.ts` | Implemented and verified |
| Client tier + fanout | `src/routes/client.ts`, `src/evaluation-service/fanout.ts` | Implemented and verified, multi-node |
| Server SDK | `src/sdk/client/sdk.ts` | Implemented and verified |
| Browser / React SDKs | `packages/{browser,react}/src` | Implemented and verified |
| Schema + migrations | `src/db/schema.ts`, `drizzle/*.sql` | Implemented and **executed** against real Postgres |
| Migration runner | `scripts/migrate.mjs` | Implemented (advisory-locked) and exercised |
| SDK key authentication | `src/repositories/sdk-keys.ts` | Implemented; revocation bound asserted |
| Management token auth + roles | `src/repositories/access-tokens.ts`, `src/auth/principal.ts` | Implemented; escalation paths tested |
| Secure mode | `src/auth/secure-mode.ts`, `src/routes/client.ts` | Implemented, enforced from the environment row, verified |
| Management REST API | `src/routes/admin.ts`, `src/repositories/{flags,catalog}.ts` | Implemented; isolation verified against real Postgres |
| Audit log + revert + chain | `src/repositories/flags.ts` | Implemented; tamper detection verified |
| Scheduled changes / approvals | `src/scheduler/scheduled-changes.ts` | Implemented; `SKIP LOCKED` and four-eyes verified |
| Dry run | `src/snapshot/dry-run.ts` | Implemented and verified, including the re-bucketing warning |
| Idempotency | `src/http/idempotency.ts` | Implemented and verified; per node, documented |
| Rate limiting | `src/http/rate-limit.ts`, `src/redis/rate-limit-backend.ts` | Implemented and verified, with per-environment overrides |
| Analytics ingest / rollup / HLL / DLQ | `src/events/*` | Implemented; **Postgres write path verified**, including a missing partition |
| Health / readiness / metrics / logging / tracing | `src/routes/ops.ts`, `src/observability/*` | Implemented and verified |
| Compression | `src/http/server.ts` | Implemented and verified |
| Process entrypoint, graceful shutdown | `src/app.ts`, `src/main.ts` | Implemented and verified |
| CORS | `src/http/cors.ts` | Implemented and verified, including the server-tier exclusion |
| CI | `.github/workflows/ci.yml` | Written; runs unit, container, conformance and supply-chain jobs |
| Docker / deploy / runbooks / alerts / DR | `Dockerfile`, `docs/ops/*` | Written; restore **rehearsed in CI** |
| Cross-language conformance | `conformance/python/` | **Implemented — 102 checks, in CI** |
| MCP / automation surface | — | **Deliberately not built** — see PR-E3 |

---

## 2. Gate A — P0 blockers · all closed

- [x] **PR-A1 · Composition root and entrypoint** — `src/app.ts`, `src/main.ts`.
  Verified by booting against a *dead* Postgres and Redis: binds, serves
  `/live`, reports `/ready` 503 with per-check reasons, exposes `/metrics`,
  refuses unauthenticated requests, shuts down releasing the port.
- [x] **PR-A2 · SDK key authentication** — single indexed query, cache keyed by
  hash, 30s revocation bound asserted against Postgres.
- [x] **PR-A3 · Management API with authorization at the data boundary** —
  addressed by key, resolved through a project-scoped join, 404 for everything a
  caller may not see. Nested resources re-check scope, verified.
- [x] **PR-A4 · Optimistic concurrency and audit** — `FOR UPDATE` +
  `expectedVersion`, 409 carrying current state, one transaction, revert by
  replay. All verified against Postgres.
- [x] **PR-A5 · Rate limiting** — sliding window, credential-free keys, and
  Redis loss *tightens* the limit rather than removing it.
- [x] **PR-A6 · Multi-node client tier** — shared connection store; a second
  node rehydrates and takes over. Falls back to single-node behaviour when the
  store is unavailable, which costs a re-identify and never a failed identify.
- [x] **PR-A7 · Health, readiness, metrics, logging** — liveness touches nothing,
  readiness fails on Postgres and partition runway but only degrades on Redis,
  and no metric carries a flag key, context key or unbounded tenant id.
- [x] **PR-A8 · CORS** — client routes only, with an explicit test that the
  ruleset endpoints never carry CORS headers.
- [x] **PR-A9 · Control-plane last-known-good** — memory, then Postgres,
  rate-limited so an outage is not a compile storm, and now behind a circuit
  breaker so the fallback is microseconds rather than a timeout.
- [x] **PR-A10 · Kill switch** — own endpoint, no version required, undebounced,
  works with Redis down.
- [x] **PR-A11 · Input validation and caps** — zod on every body, context caps
  including nesting depth, per-endpoint byte ceilings, `content-length` refusal.
- [x] **PR-A12 · Secure mode from the environment row** — production fails
  closed with no configured secret; opting out is explicit and per environment.
- [x] **PR-A13 · Analytics tier** — bounded buffer, sharded rollup, idempotent
  upsert, DLQ. Verified against Postgres including a missing partition, a
  poisoned batch, and two workers racing.
- [x] **PR-A14 · Container-gated tests run** — **the whole suite runs against
  real Postgres and Redis**, and found finding #1 immediately.
- [x] **PR-A15 · Migration safety** — advisory-locked runner, forward-only
  policy, partition creation as part of a successful migration.

---

## 3. Gate B — P1 · all closed

- [x] **PR-B1 · Publish atomicity** — `commit()` is one MULTI: snapshot, patches
  and broadcast together. Both stores are held to a contract test asserting a
  subscriber never sees a broadcast for a snapshot the store does not hold.
- [x] **PR-B2 · Version gaps** — load-then-allocate means the common failure
  burns nothing; a compile failure burns one, and every comparison in the system
  is asserted to test ordering rather than succession.
- [x] **PR-B3 · `nextSnapshotVersion`** — `UPDATE ... RETURNING`; twenty
  concurrent allocations yield twenty distinct versions.
- [x] **PR-B4 · Compile input limits** — keyset pagination and a loud ceiling.
  Truncation was considered and rejected: a partial filter answers "not a
  member" for real members, and a negated clause then grants the feature to
  exactly the wrong people.
- [x] **PR-B5 · Segment import** — paged, idempotent, verified.
- [x] **PR-B6 · Redis `SegmentCacheProvider`** — implemented; `has()` proven to
  answer synchronously without I/O, misses unresolved rather than false.
- [x] **PR-B7 · Graceful drain** — readiness first, jittered reconnect hints,
  then close.
- [x] **PR-B8 · Reconnect control** — drain jitter, per-identity stream limits,
  and a measured connection cost of ~5.4 KB.
- [x] **PR-B9 · Per-connection memory** — measured, and bounded under churn.
- [x] **PR-B10 · Redis hardening** — TLS, bounded command timeouts, jittered
  reconnect, and a circuit breaker with a half-open probe.
- [x] **PR-B11 · Scheduled changes and approvals** — built rather than dropped:
  `SKIP LOCKED` claiming, missed-window refusal, four-eyes approval.
- [x] **PR-B12 · ReDoS** — both exponential shapes rejected at evaluation *and*
  at write time, inputs capped, patterns cached. Residual risk documented.
- [x] **PR-B13 · Version regression** — the control plane never replaces a newer
  snapshot with an older one.
- [x] **PR-B14 · Bounded `unresolved`** — capped; 5,000 unresolved rules no
  longer allocate 5,000 objects per evaluation.
- [x] **PR-B15 · Error surface** — no exception message, stack or credential
  reaches a response, whatever was thrown; `details` is opt-in only.

---

## 4. Gate C — evidence · all closed

- [x] **PR-C1 · Cross-language conformance** — `conformance/python/`, 102 checks,
  run in CI. It found the undocumented cuckoo header layout and the missing
  filter bytes.
- [x] **PR-C2 · Load measurement** — `tools/load.mjs`; results and the first
  bottleneck in `docs/ops/deployment.md`. It found the triple-serialisation.
- [x] **PR-C3 · Benchmarks reconciled** — `plan.md` opens with a corrections
  banner naming every contradicted figure.
- [x] **PR-C4 · Chaos against real infrastructure** — Redis restart, wipe,
  stop-with-breaker, Postgres stop, missing partition, poisoned batch, rollup
  contention. Twelve scenarios, expected behaviour in each test name.
- [x] **PR-C5 · Security suite** — nested-resource escalation, scoped tokens,
  role boundaries, credential confusion across all three credential types,
  handle guessing, and telemetry scraped for leaks.
- [x] **PR-C6 · Memory** — every bounded structure driven far past its ceiling
  with heap sampling. Found the quadratic prune.
- [x] **PR-C7 · Evaluator adversarial corpus** — corrupt snapshots, injected
  cycles, pathological Unicode, prototype-pollution shapes, 5,000-rule flags.
  Found the `(a|a)*` hang.
- [x] **PR-C8 · Bucketing immutability** — a committed golden corpus that fails
  if the hash, seed, salt, encoding or weight scale moves.
- [x] **PR-C9 · Package contents** — `npm pack` inspection in CI. Found the
  shipped source maps.

---

## 5. Gate D — operability · closed, with one standing caveat

- [x] **PR-D1 · Runbooks** — twelve entries, each starting with what the system
  does on its own.
- [x] **PR-D2 · Alerts** — each annotated with whether it fires *before* a user
  sees a wrong value, plus what is deliberately not alertable.
- [x] **PR-D3 · Backup and restore** — **rehearsed in CI**: dump, restore into a
  fresh instance, verify configuration, partitions, and the `snapshot_version`
  fix-up that a point-in-time restore requires.
- [x] **PR-D4 · Deployment** — Dockerfile, compose, rolling-deploy procedure,
  probe configuration.
- [x] **PR-D5 · Tracing** — W3C trace context continued or started, in every log
  line. Propagation, not an exporter, and the reasoning is written down.
- [~] **PR-D6 · Capacity model** — measured and published, **on one laptop**.
  The numbers are labelled as such and the first bottleneck is named; a soak on
  production-shaped hardware is still worth doing before a large fleet.

---

## 6. Gate E — post-launch hardening

- [x] **PR-E1 · Idempotency keys** — replayed responses, body-fingerprint
  mismatch refused, concurrent retry refused. Per node, documented.
- [x] **PR-E2 · Production dry run** — compiles the proposal in a rolled-back
  transaction and reports who moves, including the churn warning that catches an
  accidental re-bucketing.
- [ ] **PR-E3 · MCP / automation surface** — **deliberately not built.** It is a
  product surface rather than a readiness gap, and building one now would add an
  authorization boundary with no consumer to validate it against. The pieces it
  needs exist: PAT auth, roles, environment scope, idempotency and audit.
- [x] **PR-E4 · Per-environment rate limits** — `RATE_LIMIT_OVERRIDES`.
- [x] **PR-E5 · Compression** — brotli and gzip with `Vary`; 2.43 MB → 20 KB.
- [x] **PR-E6 · `auto` filter threshold** — **measured, and no threshold added.**
  Roaring wins from full density down to ~0.05% and is *exact*, so it never needs
  the confirmation round trip a filter does (`docs/decisions.md` §19.1).
- [x] **PR-E7 · Audit tamper evidence** — hash-chained per project, with a
  verification endpoint. Detects edits and deletions.
- [x] **PR-E8 · SDK version skew** — bounded metric from a strictly parsed user
  agent.

---

## 7. Unverified claims register

| Claim | Status |
| :-- | :-- |
| Synchronous in-process evaluation, no per-eval I/O | **Proven** |
| Evaluator never throws | **Proven**, including against corrupt snapshots and hostile contexts |
| Evaluator never hangs | **Proven** — this is what caught the 291-second regex |
| Deterministic bucketing across processes | **Proven**, frozen by a golden corpus |
| Cross-language determinism | **Proven** — an independent Python implementation, 102 checks, in CI |
| Cuckoo wire format is portable | **Proven** — decoded independently from the frozen bytes |
| Fail-closed segments | **Proven** |
| Last-known-good survives control-plane loss | **Proven**, both tiers |
| Postgres is truth, Redis is disposable | **Proven** against a real Redis: restarted, wiped and stopped |
| Redis loss degrades quickly, not slowly | **Proven** — circuit breaker measured |
| SSE patch replay / resume | **Proven** against real Redis (and corrected there) |
| Partition lifecycle | **Proven** — migration executed, runway asserted, missing partition exercised |
| Single-writer rollups, HLL merge, idempotency | **Proven** |
| "Analytics loss acceptable, evaluation correctness not" | **Proven** architecturally and by test |
| Unique-context counts | **Explicitly a floor**, documented, not fabricated |
| Client/server tier security boundary | **Proven**, including CORS and credential confusion |
| Secure mode as a security boundary | **Proven**, and derived from data rather than wiring |
| Tenant isolation | **Proven** against real Postgres, including nested resources |
| Auditability | **Proven**, and now tamper-evident |
| Optimistic concurrency | **Proven** |
| Rate limiting does not fail open | **Proven** |
| Kill switch under 300ms p99 | **UNVERIFIED as a wall-clock number** — the path is undebounced and Redis-independent and both are tested, but end-to-end latency to a live SDK fleet has not been measured |
| 14 ns evaluation / 70M per core / cuckoo 1.25 MB | **Contradicted and corrected in `plan.md`** |
| Chaos-tested failure behaviour | **Proven** against containers |
| Client tier behind multiple nodes | **Proven** |
| Capacity at fleet scale | **UNVERIFIED** — measured on one laptop, labelled as such |

---

## 8. What is left

Nothing blocking. In rough order of value:

1. **Soak the load tests on production-shaped hardware** and measure kill-switch
   latency to a live fleet — the two numbers still labelled as unmeasured.
2. **Port the conformance core to Go**, the language a second SDK will actually
   be written in. Python proved portability; Go proves it for the audience.
3. **A linear-time regex engine** if customer-authored `matches` patterns become
   common enough to justify a native dependency.
4. **PR-E3**, once there is a consumer to validate the surface against.
