# The snapshot compiler

`src/snapshot/compile.ts` · §10.1

Compiles Postgres rows into the immutable snapshot every server SDK holds.

**It is pure.** It takes plain rows and returns a `Snapshot`; it opens no
connections and reads no configuration. That is what makes the hardest part of
M2 unit-testable without a container, and it is why `src/repositories/` is a
separate, deliberately thin layer that fetches rows and reshapes nothing.

## What it does that the SDK shouldn't

| Step | Why it is here and not there |
| :-- | :-- |
| Resolve variation uuids to positional indices | The SDK holds no uuids; doing it per evaluation is a map lookup on the hot path |
| Reject prerequisite cycles | The evaluator's depth cap is defence against corruption, not the mechanism |
| Topologically order flags | A consumer walking the snapshot never reads a flag before one it depends on |
| Drop archived flags | And drop prerequisites *pointing at* archived flags, rather than leaving them dangling |
| Inline small segments, build filters for large ones | §9.7; the SDK only reads |
| Emit `referencedAttributes` | Cheap now, a rewrite later (§22.1) |
| Emit `perContext` | So M5's fan-out does not have to rediscover it |

## Errors are thrown, never swallowed

A compile that cannot be done correctly must not publish a snapshot. The
evaluator's job is to survive a *stale* snapshot, not a wrong one.

| Code | When |
| :-- | :-- |
| `PREREQUISITE_CYCLE` | Any cycle, including a self-reference |
| `UNKNOWN_VARIATION` | A variation id that does not belong to the flag referencing it |
| `MISSING_FALLTHROUGH` | Unreachable from a healthy database — `fallthrough_xor` prevents it |
| `ROARING_NON_INTEGRAL` | `SEGMENT_FILTER=roaring` with a non-integral member key |

That last one **fails the compile loudly** rather than silently falling back to
cuckoo: a wrong answer is not an acceptable response to a misconfiguration.

## What it drops, and why that is right

A flag with **no configuration row in this environment** is dropped, not given a
default. A flag exists once at the project level; its configuration exists once
per environment, and with no config row there is nothing to serve. Inventing one
would be the compiler guessing. The SDK reports `FLAG_NOT_FOUND` and the caller's
default is served — the documented behaviour for a flag that does not exist.

A prerequisite pointing at an **archived** flag is dropped rather than left
dangling. A dangling key would make the evaluator report `PREREQUISITE_FAILED`
forever, silently disabling the dependent flag with nothing to point at.

## Determinism

The same rows compile to the same bytes. Targets are sorted, rules ordered by
`idx`, segment members sorted, and cuckoo victim selection is deterministic
rather than random. This matters because the compiler re-encoding an unchanged
segment must not produce a spurious new version — and a new version is a
broadcast to every connected SDK.

## `referencedAttributes` and `perContext`

```ts
referencedAttributes: ["organization.tier", "user.country"]  // kind-qualified, sorted
perContext: true                                             // rollout, target, or segment clause
```

`referencedAttributes` is what lets the client tier collapse 50,000 connections
into a few hundred groups (§11.5). `perContext` marks the flags that *cannot*
collapse, because their answer depends on the context key rather than only on its
attributes.

Both are emitted in M2 even though only M5 reads them. §22.1 is explicit that
this is the part that cannot be retrofitted: the cache is an afternoon, the
compiler emitting the sets is not.

## No second "client snapshot"

There is deliberately no `compileClientPayload`. The client tier receives
*evaluated values* (§11.5), produced per-context by the evaluation service from
this same snapshot. Compiling a second artifact would duplicate the work and give
the ruleset a second path out of the building — and §16 is explicit that the tier
split is the security boundary, "not a filter applied at serialisation time,
which is a filter someone eventually forgets on a new endpoint".

What compilation owes the client tier is `clientAvailable` on each flag plus
`referencedAttributes`. `clientFlagKeys(snapshot)` is the entire client-visible
surface at compile time.
