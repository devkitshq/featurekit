# featurekit — task tracker

Living document. Updated as work lands. Section refs point into [`plan.md`](plan.md);
design notes and divergences live in [`docs/decisions.md`](docs/decisions.md).

**Production readiness work is tracked separately in
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md)**, which is the launch gate and
supersedes this file where the two disagree. The milestone table below covers feature
completeness; that one covers whether any of it can be operated.

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked / needs a decision

---

## Status

| Milestone | Scope | State |
| :-- | :-- | :-- |
| **M1** | Evaluation core | **done** |
| **M2** | Storage + snapshot compile | **done** |
| **M3** | Control plane | **done** — management REST, audit + revert, rate limits, `/metrics` all landed |
| **M4** | Server-tier delivery + chaos suite | **done**; Redis-loss chaos added |
| **M5** | Client tier | **done** |
| **M6** | Analytics ingest + rollup | **done** — buffer, sharded rollup, HLL, DLQ (Postgres write container-gated) |
| **M7** | Governance + hardening | **done** — scheduled changes, approvals, dry run, idempotency, audit chaining |
| M8 | Dashboard/CLI, reach | out of current scope |

**Environment note:** container-backed tests now **run**. The whole suite executes
against real Postgres and Redis via testcontainers — 978 tests, none skipped — and
doing so immediately found a divergence between the Redis and in-memory patch
stores that no amount of mock-based testing would have. They still skip with a loud
message where no container runtime exists; `FEATUREKIT_REQUIRE_CONTAINERS=1` turns
that skip into a failure, and CI sets it.

---

## M1 — Evaluation core `[x]`

- [x] `murmur3.ts` — frozen hash, UTF-8 bytes, ASCII fast path, 16 published vectors
- [x] `bucketing.ts` — integer bucketing, rollout assignment, exact boundaries
- [x] `context.ts` — multi-context normalisation, attribute resolution, no-alloc hot path
- [x] `operators.ts` — 15 operators, semver precedence, type-mismatch-is-false
- [x] `cuckoo.ts` — (2,4) partial-key filter, frozen wire format
- [x] `roaring.ts` — official Roaring portable format
- [x] `segments.ts` — three-state membership, `SegmentCacheProvider`, deltas
- [x] `evaluate.ts` — precedence, prerequisites, fail-closed rules
- [x] Purity guard: `evaluation/` imports nothing
- [x] Conformance corpus + independent BigInt generator
- [x] Benchmarks for hashed and non-hashed paths
- [x] Docs: 8 pages under `docs/`

Exit criteria met. Findings recorded in `docs/decisions.md` §1–§11.

---

## M2 — Storage and compile `[x]`

### Schema and migrations
- [x] `src/db/schema.ts` — every table in §7.1–§7.11
- [x] Composite FK on `segments` so its project agrees with its environment (§7.6)
- [x] `segment_members.ordinal` generated column — **reconciled**: the column now
      uses `^(0|[1-9][0-9]{0,8})$`, matching the SDK's `ordinalOf`. Both reject
      leading zeros. Asserted from both sides.
- [x] `flag_environments` XOR check constraints (`fallthrough_xor`, `rule_outcome_xor`)
- [x] Hand-written partitioned DDL for `evaluation_summaries` (§7.9) —
      drizzle-kit's plain `CREATE TABLE` stripped from `0000_init.sql`, since it
      would have silently shadowed the partitioned one
- [x] `pg_partman` + `pg_cron` configuration, `p_premake => 7`, **no DEFAULT partition**
- [x] `featurekit_ensure_partitions()` fallback for locked-down managed Postgres
- [x] `featurekit_partition_runway_days()` backing the readiness check

### Repositories
- [x] `loadCompilerInput` — one environment, batched queries, reshapes nothing
- [x] `findEnvironment` by project + environment key
- [x] Write paths — landed in M3 with the management API that drives them

### Snapshot compiler `src/snapshot/`
- [x] Rows → `Snapshot`, pure and container-free
- [x] Resolve variation uuids to positional indices, scoped per flag
- [x] Topologically order prerequisites, **reject cycles at compile time**
- [x] Drop archived flags, unconfigured flags, and other environments' config
- [x] Drop prerequisites pointing at archived flags rather than dangling
- [x] Inline small segments; cuckoo/roaring for large ones (§9.7)
- [x] `SEGMENT_FILTER=roaring` **fails the compile loudly** on a non-integral key
- [x] Emit `referencedAttributes` per flag, kind-qualified (§11.5, §22.1)
- [x] Emit `perContext` — rollout, target, or segment clause defeats fingerprint
      collapse, so M5 does not have to rediscover it
- [x] `clientFlagKeys` — the client-visible surface. **No second "client
      snapshot" compile**: the client tier gets evaluated values (§11.5), and a
      second artifact would give the ruleset a second path out of the building

### Configuration (moved forward from M3, everything below needs it)
- [x] `src/config/` — full §17 schema, prod fails loudly listing every missing var
- [x] `SECURE_MODE_SECRET` required in prod only once a client key exists
- [x] Comma-separated secret rotation: sign with the first, verify against all
- [x] Cross-field check: patch ceiling must exceed the load factor it guards

### Tests
- [x] Compiler unit tests — 36, no containers
- [x] Config tests — 22
- [x] Integration tests against real PG (container-gated, 8 tests)
- [x] Gate status is a **visible test**, not a `console.warn` — vitest swallows
      console output written during collection, and a skip nobody sees is
      indistinguishable from a pass. `FEATUREKIT_REQUIRE_CONTAINERS=1` fails instead.

## M3 — Control plane `[x]`

- [x] `src/config/` — done in M2, everything below needed it
- [x] `src/redis/keys.ts` — the §8 key map, with each key's rebuild cost stated
- [x] `SnapshotStore` plugin interface + Redis and in-memory implementations,
      both run against **one shared contract suite** so they cannot diverge
- [x] Binary-safe snapshot codec — a `Uint8Array` filter JSON-round-tripped into
      `{"0":1,...}` is a filter that answers `false` for every member
- [x] Patch history + the §10.3 resume table in one place (`resumeFrom`)
- [x] Compile lock with compare-and-delete release, so an overrunning compile
      cannot delete a lock another node has since acquired
- [x] `SnapshotService` — debounced per environment, lock-guarded, publishes
      after storing; a failed compile leaves the last good snapshot serving
- [x] Durable monotonic version (`environments.snapshot_version`) — a Redis
      counter would go backwards on restart and freeze the version guard
- [x] SDK-key auth: server keys hashed at rest, client/mobile public (§7.2)
- [x] Secure mode: HMAC over `${key}:${expiresAt}`, rotation, distinct
      `SIGNATURE_EXPIRED` vs `SIGNATURE_INVALID` vs `SIGNATURE_TTL_TOO_LONG`
- [x] HTTP layer on `node:http` + SSE primitives — §2 lists no HTTP framework
- [x] Management REST (§12), PAT auth — `src/routes/admin.ts`, roles + environment
      scope, resolution by key never uuid, 404 (not 403) for another tenant's object
- [x] Audit log with before/after diff and one-click revert — one transaction with the
      config write and the version bump
- [x] Optimistic concurrency — `FOR UPDATE` + `expectedVersion`, 409 carrying the
      current state. Two engineers saving the same flag no longer lose one of them
- [x] Kill switch as its own endpoint — no version, no body, undebounced propagation
- [x] Rate limiting per SDK key (§16) — sliding window; **Redis loss tightens the
      limit rather than removing it**
- [x] `/health` `/live` `/ready` `/metrics` + partition-runway readiness
- [x] CORS for the client tier only — never on the ruleset endpoints
- [x] Input validation and caps on every public endpoint (zod, context caps, body
      ceilings)
- [x] Secure mode enforced from `environments.is_production`, not from call-site wiring
- [x] Control-plane last-known-good: Redis down serves memory, then compiles from
      Postgres
- [x] Composition root (`src/app.ts`) and entrypoint (`src/main.ts`) — the system can
      actually be started
- [x] Graceful drain: readiness first, jittered reconnect hints, then close

## M4 — Server-tier delivery `[~]`  (segment deltas and container chaos outstanding)

- [x] `GET /v1/stream/:env` — SSE, `id:` = snapshot version, heartbeats
- [x] Patch replay from `Last-Event-ID`, all three full-`put` cases (§10.3)
- [x] **Fixed:** an empty replay left the sent-version at 0 and re-sent the whole
      snapshot to a client that was already current — the opposite of resume
- [x] `GET /v1/snapshot/:env` — polling fallback with `If-None-Match` / 304
- [x] Stream capacity shedding to polling, and the SDK takes the hint
- [x] `featurekit` server SDK (`src/sdk/client/`): bootstrap, persistence, `ready()`,
      streaming/polling/offline, jittered reconnect
- [x] Version-guarded patch application, per snapshot and per flag
- [x] `ready()` times out into "serving defaults" and **never rejects**
- [x] Event summarizer — 500 evaluations become one bucket, drop on backpressure
- [x] End-to-end tests against a real HTTP control plane, not mocks
- [x] **Chaos suite** (`tests/chaos/`) — 12 scenarios against a control plane that
      is genuinely killed, flapped and stormed:
      - `control-plane-down` — SIGKILL under live load; **zero** evaluation
        errors, **zero** changed values, and 10k evaluations against a dead
        server in well under a frame
      - `stream-flap` — repeated disconnects converge; past `PATCH_HISTORY_DEPTH`
        degrades to a full `put`
      - `storm` — 25 SDKs, 20 rapid toggles; debounce coalesces, all converge
      - `bucketing-stability` — 200k contexts at 10% ±0.5%; **zero** contexts move
        when an unrelated flag is edited or the process restarts
      - `segment-fail-closed` — the §22.3 leak, in the cold-start window *and*
        with the provider throwing
      - snapshot version regression rejected by the guard
- [x] Segment import end to end — paged, idempotent (`ON CONFLICT DO UPDATE`), so a
      retried page is a no-op rather than a stranded half-import
- [ ] Segment delta patches end to end — SDK side done (`applyDelta`, version-guarded);
      the server still emits a full re-encode rather than a delta
- [ ] `SegmentCacheProvider` Redis implementation
- [~] Chaos: `tests/chaos/redis-loss.test.ts` covers Redis down / wiped / recovering,
      version regression and kill-switch-during-debounce — in-process, not containers.
      The container-gated set still needs a live daemon

## M5 — Client tier `[x]`

- [x] `src/evaluation-service/` — server-side evaluation for the client tier
- [x] `POST /v1/client/state`, `GET /v1/client/stream`
- [x] Secure mode: HMAC over `${key}:${expiresAt}`, comma-separated rotation (§16)
- [x] `SIGNATURE_EXPIRED` distinct from `SIGNATURE_INVALID`, plus
      `SIGNATURE_TTL_TOO_LONG` checked **before** the HMAC so a validly-signed
      decade-long token is still refused
- [x] `featurekit-client` — `seq` + identity + `contextHash` guards,
      discard-on-key-change, superseded calls resolve rather than hang
- [x] **Fingerprint-keyed fan-out** (§11.5) — 50,000 connections spanning 20
      attribute combinations produce **20** evaluations, not 50,000
- [x] Rollout, target and segment flags specialised per connection (`perContext`)
- [x] Cache keyed `(version, flagKey, fingerprint)` — a version bump invalidates
      by construction, with no sweep to forget to call
- [x] Only the reason *kind* crosses to the browser; never `ruleId`/`ruleIndex`
- [x] Catch-up on stream open — a change landing between `POST /state` and the
      stream opening was previously missed **permanently**
- [x] `featurekit-client` React adapter (`docs/client-tier/adapters.md`) — `useSyncExternalStore`, SSR bootstrap, no re-render
      on unrelated changes, client created once so a double-firing effect cannot
      reintroduce the §22.7 leak
- [ ] Connection shedding above `MAX_CLIENT_CONNECTIONS` — the cap is enforced,
      the short-TTL polling fallback is not yet wired into the browser SDK
- [!] **Single-node only.** The connection registry is a per-process `Map`, so a
      browser whose POST and SSE land on different nodes gets `409 UNKNOWN_CONNECTION`.
      Sticky routing is documented as a requirement; the fix is PR-A6

---

## Test inventory

| Suite | Tests | Needs |
| :-- | --: | :-- |
| `tests/evaluation/` | 298 | — |
| `tests/control-plane/` | 97 | — |
| `tests/conformance/` | 57 | — |
| `tests/client-tier/` | 49 | — |
| `tests/snapshot/` | 36 | — |
| `tests/config/` | 22 | — |
| `tests/sdk/` | 18 | — |
| `tests/chaos/` | 12 | — |
| `tests/integration/` | 100 | a container runtime |
| `tests/events/` | 25 | — |
| `tests/contracts/` | 12 | — |
| **Total** | **978 passing, 0 skipped** | |

Suites added across the readiness work: `app-boot`, `ops`, `hardening`,
`compression`, `idempotency`, `trace`, `memory`, `circuit-breaker`, `redis-loss`,
`version-gaps`, `secure-mode`, `multi-node`, `analytics`, `context`, `adversarial`,
`regex`, `bucketing-immutability`, `dry-run`, and — needing containers —
`management-api`, `governance`, `security`, `chaos-infra`, `segment-scale`,
`segment-cache`, `restore`. Plus `conformance/python/`, a second implementation of
the evaluation core that runs the same corpus in CI.

## Open questions carried forward

- [x] ~~**§7.6 ordinal regex vs `ordinalOf`.**~~ **Resolved in M2.** The generated
      column now uses `^(0|[1-9][0-9]{0,8})$` and the compiler calls the SDK's
      own `ordinalOf` rather than re-implementing the test, so the two cannot
      drift. Asserted from both sides. (`docs/decisions.md` §9)
- [x] ~~**§1 performance claims.**~~ **Resolved.** `plan.md` now opens with a
      corrections banner: 14 ns → 50–177 ns, ~70M evals/sec → ~6–20M, cuckoo 1.25 MB →
      2.0 MB. The arguments stand; the figures are marked wrong where someone would
      otherwise quote them.
- [x] ~~**Docker daemon.**~~ **Resolved.** The container suites run. First green run
      found `MAXLEN ~` approximate trimming in the Redis patch store diverging from
      the in-memory one — exactly the class of bug the gate exists for.
- [x] ~~**§9.7 cuckoo sizing.**~~ Recorded in the same banner. The sizing itself is
      unchanged and still correct; only the claimed number was wrong.
- [x] ~~§19.2 HLL implementation choice~~ — dependency-free p=12 sketch in
      `src/events/hll.ts`, frozen wire format. **Open consequence:** SDKs report unique
      contexts as a number, which cannot be merged, so unique counts are a documented
      floor until an SDK ships its own sketch
- [x] ~~§19.1 `auto` roaring-vs-cuckoo density threshold~~ — **measured, no
      threshold needed.** Roaring is smaller from 100% density down to ~0.05%
      and only loses past 0.01%, by ~20% — and it is *exact*, so it never needs
      the confirmation round trip a filter does. (`docs/decisions.md` §19.1)
