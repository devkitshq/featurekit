# Decisions and findings

Where the implementation departs from `plan.md`, and what measurement said
about the plan's estimates. Everything here is a deliberate choice with a
reason, not drift.

---

## 1. §1's "14 ns/op, ~70M evals/sec/core" is not attainable for this API

**Measured:** 50–177 ns for the non-hashed paths, i.e. 6–20M evals/sec/core.

The plan's §1 table claims 14 ns for "off, target match, or fixed-variation
rule (no hash)". That figure is achievable only for a bare map lookup. The
documented signature in §9.2 returns `EvaluationDetail<T>` — an object carrying
`value`, `variationIndex`, and a `reason` — and it accepts a raw
`EvaluationContext` that must be normalised before any clause can read an
attribute. Those two obligations dominate:

| | ns/op |
| :-- | --: |
| First implementation (Map + attribute copy per call) | 252 |
| After removing both allocations | 57 |
| After hoisting constant `reason` objects | **50** |

Getting from 50 ns to 14 ns would mean returning a pre-allocated or primitive
result and accepting a pre-normalised context — both of which change the public
API the rest of the plan is written against.

**What was done instead**, because the first number was 5× the last:

- **Normalisation no longer allocates.** It held a `Map` and copied every
  attribute into a fresh object; it now wraps the caller's own object
  (`SingleKindContext`). Cost: `kind` became reserved and unreadable as an
  attribute in every context shape — see [context](evaluation/context.md).
- **`getAttribute` no longer calls `split(".")`** unless the attribute actually
  contains a dot. It allocated an array on *every* attribute read.
- **Payload-free `reason` objects are frozen constants**, not fresh literals.

The honest headline is **"tens of nanoseconds, millions per second per core"**,
which still supports every claim §3 makes about not needing a network call.
§1's specific numbers should be corrected.

## 2. The cuckoo filter is up to 2× the size §9.7 prices it at

**Measured at 500k members: 2,097,168 bytes (2.0 MB, 33.6 bits/member).**
§9.7 prices the same filter at ~1.25 MB (20 bits/member at α=0.8).

Both are right about their own premise. The plan computes `16/α` bits per item
at α=0.8. But §9.7 *also* requires — correctly, and non-negotiably — that the
bucket count be a power of two, because `i₂ = i₁ XOR h(fp)` only stays in range
and only stays an involution when it is. So the achieved load factor is not
0.8; it is whatever `n / (4 · nextPow2(⌈n / 3.2⌉))` works out to, which ranges
over **(0.4, 0.8]**.

500,000 members need 156,250 buckets and get 262,144 — **α = 0.477**, so 33.6
bits per item rather than 20. A segment of 1,600,000 members would land at
α = 0.76 and 21 bits. The quoted figure is the best case, and 500k — the exact
size the plan uses as its example — is near the worst.

This does not affect correctness, and the headroom is not wasted (§9.7 wants
room for the next `segment-patch`). But it changes two comparisons the plan
draws:

- "≈7% over an equal-accuracy Bloom" is true only at the top of the range.
- The 500k re-broadcast the Bloom-vs-cuckoo argument is built on is ~2 MB, not
  ~900 KB — which strengthens the "deltas must ride the patch stream" argument
  rather than weakening it.

`SEGMENT_CUCKOO_FINGERPRINT_BITS=12` halves it and is already a documented knob.
No code change is proposed: the power-of-two requirement is load-bearing and the
parameters are frozen. The numbers in §9.7 should be restated as a range.

## 3. Roaring beats its estimate by a wide margin

**Measured at 500k sequential ids: 117 bytes.** §9.7 says "typically under
100 KB". Run-length encoding collapses contiguous ids to eight containers of
one run each. Lookup is 12 ns — faster than `Set.has` on the same data (18 ns)
and 12× faster than a cuckoo lookup — while being exact.

Where keys are integral, roaring is not a close call.

## 4. `CompiledSegment` gained `excluded` and `rules`

§10.1's sketch puts `excluded` only on the `inline` variant and omits segment
rules entirely, but §7.6's schema has `segment_members.excluded` for all
segments and a `segment_rules` table. An exclusion list that worked only for
small segments would fail exactly where pinning someone out matters most, so:

- `excluded` moved to a shared base and is checked first in every encoding.
- `rules?: CompiledSegmentRule[]` was added. A context is a member if it is
  **listed OR any segment rule matches** — with weighted rules bucketed on the
  segment key, so segment membership is independent of any flag's rollout.

## 5. `SEGMENT_UNRESOLVED` is an annotation, not the served reason

§9.7 says it is "a distinct `reason` on `EvaluationDetail`", and also that a
failed-closed rule falls through "to the same place a genuinely non-matching
context lands". Both cannot be literally true of a single `reason` field: if
`reason` became `SEGMENT_UNRESOLVED`, it would no longer say whether the
fallthrough or the off variation was served.

Resolved by keeping `reason` as the actual outcome and adding
`EvaluationDetail.unresolved?: UnresolvedRule[]`, which names every rule that
was skipped and which segment could not be verified. `POST /v1/debug/evaluate`
gets strictly more than §9.7 asks for, and
`featurekit_sdk_segment_unresolved_total` counts off it. The array is allocated
lazily, so a clean evaluation allocates none.

## 6. Fallthrough rollouts that cannot bucket serve the caller's default

§9.3 says a context lacking the bucketing attribute is *excluded* from a
rollout. In a **rule**, exclusion means the rule does not match and evaluation
continues — implemented exactly so. At the **fallthrough** there is nowhere
left to continue to.

Chosen: the caller's default with `reason: ERROR / MALFORMED_CONTEXT`. Serving
the off variation would report a flag as off when it is on; serving variation 0
is precisely the silent skew §9.3 exists to prevent. The default is the honest
backstop, and `ERROR` makes `featurekit_sdk_default_served_total` — "the alert
that matters" (§15) — rise so someone notices.

## 7. An off prerequisite always fails, whatever its off variation is

If flag `A` requires `B` at variation 1, and `B` is **off** with
`offVariation: 1`, the prerequisite is treated as unmet. "Off" is not "serving
variation 1"; a kill switch on `B` must propagate to everything gated behind it,
which is the entire point of prerequisites.

## 8. `kind` is reserved and never readable as an attribute

A consequence of removing the per-call attribute copy (finding 1). In the
single-context shape `kind` is the discriminator rather than data. Filtering it
at read time in *every* shape is preferable to a rule that could read `kind` in
a multi-context and not in a single one. A clause selects its context kind with
`contextKind`, which is what that field is for.

## 9. Leading zeros disqualify a roaring ordinal — reconciled in M2

§7.6 computes the ordinal with `context_key ~ '^[0-9]{1,9}$'`, which admits
`"07"`. `"07"` and `"7"` are distinct context keys but the same integer, so a
bitmap would answer identically for both and membership would depend on how an
id happened to be formatted.

`ordinalOf` rejects leading zeros. **M2 brought the database into agreement**:
the generated column is now

```sql
CASE WHEN context_key ~ '^(0|[1-9][0-9]{0,8})$' THEN context_key::bigint END
```

and the compiler calls the SDK's own `ordinalOf` rather than re-implementing the
test, so the two cannot drift. Asserted from both sides — the SDK's rule in
`tests/evaluation/roaring.test.ts`, the column's in
`tests/integration/schema.test.ts`, and the compiler's choice in
`tests/snapshot/compile.test.ts`.

Had they stayed out of step the compiler could have picked roaring for a segment
the SDK then answered `false` for: a customer who is in the segment and does not
get the flag, visible weeks later and attributable to nothing.

## 10. Deferred out of M1, deliberately

- **Roaring set operations (AND/OR/ANDNOT).** §9.7 wants segment intersections
  resolved in the compiler. That is compiler-side work and belongs with M2; the
  SDK only ever reads. Read/write of the portable format is complete.
- **Async `SegmentCacheProvider` warm-up.** The interface, the three-state
  contract, `LruSegmentCache`, and the fail-closed behaviour on a promise or a
  throw are all in place. The background fetch that *populates* the LRU belongs
  with the SDK's transport in M4.
- **`defineFlags` typed keys (§11.3).** Config-as-code is M7.

## 11. Test-only surface on `CuckooFilter`

`insertRaw`, `deleteRaw` and `countFingerprint` are public so a test can plant
two colliding fingerprints in one bucket deliberately and assert that `delete`
clears exactly one. That case is unreachable through the public API on demand,
and it is the one that silently evicts a member who is still in the segment.
The alternative — trusting the invariant — is what §9.7 explicitly warns about.

---

# M2–M5 findings

## 12. drizzle-kit silently emits a plain `evaluation_summaries`

drizzle-kit cannot express `PARTITION BY`, and its `tablesFilter` only affects
introspection — so `generate` produced an ordinary `CREATE TABLE` for the one
table in the system that must be partitioned.

Left in place, everything would have *worked*: inserts land, reads succeed,
tests pass. The retention story would simply not have existed, and the discovery
would have been someone trying to drop 90-day-old data and finding a single
400M-row heap.

The statement is stripped from `0000_init.sql` and `0001_partitioning.sql` is
the authority for that table. `tests/integration/schema.test.ts` asserts
`pg_class.relkind = 'p'`, so a regenerate that reintroduces it fails loudly.

## 13. The snapshot version is durable, not a Redis counter

`environments.snapshot_version`, bumped in the same transaction as a config
change.

The tempting implementation is `INCR` on a Redis key — it is one round trip and
the key map (§8) already has a home for it. But §8 also says losing all of Redis
must not lose a flag configuration, and a counter that resets on restart makes
the version go **backwards**. The SDK's version guard then rejects every
subsequent patch as stale, and the environment freezes on its last good snapshot
with nothing in the logs to say why. Silent, total, and slow to diagnose.

## 14. An empty patch replay re-sent the entire snapshot

Found by a test, not by reading. A client reconnecting with `Last-Event-ID` equal
to the current version gets an empty replay — it is already current. The
implementation left the connection's sent-version at 0, concluded it was behind,
and sent a full `put`.

So a fleet flapping its connections would each pull a complete snapshot for no
reason, which is the exact cost resume exists to avoid, and the busier the fleet
the worse it gets. Fixed by seeding the sent-version from `Last-Event-ID` before
applying replayed patches. There is now a regression test asserting a current
client receives **nothing at all**.

## 15. The client tier could miss a change permanently

`POST /v1/client/state` returns values at version V; the SSE stream opens a round
trip later. A change landing in that window is broadcast to the connections that
exist *at broadcast time* — and this one does not yet.

That is not a late delivery, it is a lost one: nothing else would ever push that
flag to this browser. The server tier solves the same problem with
`Last-Event-ID` replay; the client tier now does the equivalent, comparing the
connection's last-sent version against the current snapshot on stream open and
pushing a delta if it is behind.

Found because a test that *looked* flaky was actually correct.

## 16. `contextHash` needed a client-side meaning

§11.5 requires "both checks, not either": `seq` for reordering, `contextHash` for
a stale response to a re-identified context. But the hash is computed by the
server, and the client cannot recompute it without shipping the same
canonicalisation.

The first cut stubbed that check out, which silently disabled half the guard.
It is now enforced with what the client does know: the context key each in-flight
request was issued for, plus a comparison against the hash last accepted for that
key. Three conditions, all of which must pass — `tests/client-tier/browser.test.ts`
drives the A-slow/B-fast race and asserts B wins.

## 17. `CompiledFlag` gained `perContext` and `clientAvailable`

Neither is in §10.1's sketch of the type.

`perContext` marks a flag whose value depends on the context *key* — a rollout, a
target, or a segment clause — and therefore cannot share a fan-out fingerprint.
The compiler knows this for free while walking the rules; making M5 rediscover it
per fan-out would mean re-walking every flag's rules on every broadcast.

`clientAvailable` is carried onto the compiled flag so the evaluation service can
filter without going back to the database, and so `clientFlagKeys()` can state
the client-visible surface exactly.

## 18. Test fixtures that do not bump versions are testing nothing

Two SDK tests failed on first run because the fixture never incremented
`flag_environments.version`. The SDK was **right** to discard those patches: a
config change that does not bump the version models a database that never
recorded the change.

Worth writing down because the instinct on seeing it is to relax the guard. The
fix was the fixture, and there is now a test that deliberately does not bump the
version and asserts the SDK keeps what it holds.

## 19. Four packages became two

`plan.md` §5 lays out a package per surface — `@featurekit/sdk`,
`@featurekit/browser`, `@featurekit/react`, and `@featurekit/edge`,
`@featurekit/openfeature`, `@featurekit/cli`, `@featurekit/mcp` to follow. What
ships is two:

| | what it is | dependencies |
| :-- | :-- | :-- |
| `featurekit` | the control plane, and the server-tier evaluator inside it | drizzle, postgres, ioredis, pino, prom-client, zod |
| `featurekit-client` | the client tier, one entry: browsers, React Native, Node, edge, and any backend that would rather ask than evaluate. No framework bindings. | none |

Three changes are folded into that.

**`@featurekit/sdk` merged into `featurekit`** as `src/sdk/`. The plan kept them
apart so that a service installing the evaluator did not acquire the control
plane's dependency tree — a real property, and the reason `tools/check-package.mjs`
exists. It survives here as an asserted boundary rather than a free one: nothing
under `src/sdk/` may import from the rest of `src/`, and nothing there may import
a runtime dependency. Both are checked statically, and
`tests/evaluation/purity.test.ts` checks the evaluation core separately. What is
genuinely lost is the *packaging* guarantee — a service that installs
`featurekit` to evaluate a flag now does acquire a postgres driver. That is
accepted because the expected shape is a backend using `featurekit-client`, or
running the control plane, and neither is harmed by it.

**`@featurekit/browser` and `@featurekit/react` collapsed into one entry
point.** "Browser" was never the boundary: the same code runs in React Native,
Node, Deno and an edge runtime, and the name implied a portability limit that
does not exist. The React bindings are gone entirely rather than moved to a
subpath — a binding is twenty lines over `detail()` and `on("change")`, and a
package per framework turns those twenty lines into a version matrix owed on
somebody else's release schedule, with every framework we have not packaged
told to wait. [Framework adapters](client-tier/adapters.md) publishes the
twenty lines for React, Vue and Svelte instead, to be copied and owned.

**`featurekit/secure-mode` is a second entry point on the server package.**
Secure mode is mandatory in production and the signature must be minted by the
customer's own backend, but neither `signContext` nor `contextHash` was
exported — so every integrator reimplemented an HMAC over an undocumented
string and a sorted-key canonicalisation by hand, discovering any mistake as a
401 at the moment secure mode was switched on. It is a separate entry because
`featurekit`'s main entry is the control plane: a service whose only job is
signing a string should not load Drizzle, Postgres and Redis to do it. The
closure is asserted dependency-free by `tools/check-package.mjs`.

**The other packages are not planned.** No `@featurekit/edge`, no Swift or
Kotlin SDK. The client tier is two HTTP endpoints and a JSON body, documented
in [the client tier over plain HTTP](client-tier/http.md) with a working
thirty-line implementation. A contract any language can implement in an
afternoon is a better guarantee than a client library that gets updated when
somebody remembers to.

The one hazard this creates is worth stating plainly: `featurekit-client` holds
one identity per instance, so a backend that shares an instance across
concurrent requests will serve one user's flags to another. See
[the client SDK](client-tier/client-sdk.md#one-instance-one-identity).

---

## 20. Still outstanding

Summary of remaining items:

- **Management REST (§12), PAT auth, the audit log, and one-click revert.** The
  schema is in place (`audit_log`, `change_requests`, `scheduled_changes`); the
  write paths and routes are not.
- **Rate limiting per SDK key** (§16) — the Redis key is mapped, the middleware
  is not written.
- **`/health` `/live` `/ready` `/metrics`**, including the partition-runway
  readiness check. `featurekit_partition_runway_days()` exists in SQL; nothing
  calls it yet.
- **`SegmentCacheProvider` Redis implementation.** The interface, the LRU, and
  the fail-closed semantics are done and tested; the Redis-backed provider is
  not.
- **Segment delta patches end to end.** The SDK applies them (`applyDelta`,
  version-guarded); the server does not yet emit them, because that needs the
  management write path.
- **The container-gated chaos scenarios** — `degraded.test.ts` (kill Redis, then
  Postgres, then both) and `rollup-contention.test.ts` — need a live daemon.

---

## §20.1 The `auto` roaring-vs-cuckoo threshold — measured, and not needed

**Open question, now closed.** `auto` picks roaring whenever every member key is
integral, with no density test. The worry was that a sparse integral segment —
ids scattered across a wide range — would make the bitmap larger than the filter
it replaced, and that `auto` therefore needed a density threshold.

Measured, at 16-bit fingerprints and α=0.8:

| members | density | roaring | cuckoo | smaller |
| --: | --: | --: | --: | :-- |
| 10,000 | 1.0% | 20 KB | 32 KB | roaring |
| 10,000 | 0.05% | 22 KB | 32 KB | roaring |
| 100,000 | 1.0% | 197 KB | 256 KB | roaring |
| 100,000 | 0.1% | 207 KB | 256 KB | roaring |
| 100,000 | 0.05% | 219 KB | 256 KB | roaring |
| 100,000 | 0.01% | 315 KB | 256 KB | **cuckoo** |
| 500,000 | 1.0% | 983 KB | 2,048 KB | roaring |
| 500,000 | 0.05% | 1,096 KB | 2,048 KB | roaring |

Roaring wins from fully dense down to about 0.05%, and loses only past 0.01% —
by about 20%, which is not a lot to buy with a new configuration knob.

**And the size comparison understates roaring's advantage**, because the two are
not equivalent. A roaring bitmap is *exact*: membership is answered on the spot,
`unresolved` cannot arise, and no confirmation round trip to a segment cache is
ever needed. A cuckoo filter is probabilistic, so every positive it returns has
to be confirmed — which is a network hop on the client tier and an
`unresolved` (fail-closed) answer until it completes (§9.7).

There is also a natural ceiling on how sparse an eligible segment can be:
`ordinalOf` accepts at most nine digits, so the id space tops out near 10⁹, and
the 0.01% case needs 100,000 members spread across all of it.

**Decision: no threshold.** `auto` stays "integral keys mean roaring". The
measurement is the answer to the question, and adding a knob for a 20% saving in
one uncommon case — at the cost of exactness — would be the wrong trade.
Reproduce with the density probe described in `docs/evaluation/benchmarks.md`.
