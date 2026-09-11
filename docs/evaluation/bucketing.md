# Bucketing and rollouts

`src/sdk/evaluation/bucketing.ts` · §9.3

The property that makes percentage rollouts trustworthy: **the same context
always lands in the same bucket** — across processes, restarts, deploys, and
SDK languages.

## The computation

```
bucket(value, flagKey, salt, seed?) =
  floor( murmur3_utf8(`${seed ?? flagKey}.${salt}.${value}`) * 100000 / 2^32 )
```

Result is an integer in `[0, 99999]`.

**Every step is integer arithmetic.** The largest intermediate is
`(2^32 - 1) * 100000 ≈ 4.29e14`, comfortably inside `MAX_SAFE_INTEGER`
(9.01e15) and inside int64 — so a Go or Java port computes an identical value
with native integers, with no BigInt and no floating point anywhere.

## What each hash input buys

| Input | Property | Verified |
| :-- | :-- | :-- |
| `flagKey` | Two flags at 10% do not roll out to the *same* 10% | 200k contexts, overlap 2,019 vs ~2,000 expected |
| `salt` | The 10% in staging is not the 10% in production | same shape, different salts |
| `seed` | An experiment freezes its seed and survives edits to the flag | `seed` replaces `flagKey` entirely |

Without `flagKey` in the hash your "independent" rollouts are perfectly
correlated and you draw conclusions from one population.

`seed` is tested with `!== undefined`, never truthiness: **seed 0 is a valid
frozen seed**, and falling back to the flag key for it would re-randomise a
running experiment.

## Assignment

```ts
assignBucket(rollout, b)   // integer cursor, split on `b < cursor`
```

Weights are integers out of `WEIGHT_SCALE` (100,000) and the cursor stays an
integer. Accumulating `weight / 100_000` as floats defeats the point: twenty
5,000-unit variations sum to `1.0000000000000002` and every intermediate
boundary is off by an ULP.

A boundary bucket belongs to the **later** variation (`b < cursor`). The
conformance corpus pins keys that hash to exactly 0, 1, 9999, 10000, 10001,
49999, 50000, 99998 and 99999 — found by construction, because random fixtures
never land on them.

`assignBucket` is exported separately from `resolveRollout` precisely so the
boundary can be asserted directly rather than by hunting for a context that
happens to hash there.

## Exclusion, not variation 0

```ts
resolveRollout(rollout, context, flagKey, salt) -> number | null
```

`null` means **excluded from this rollout**, not "assign to the first
variation". A context lacking the bucketing attribute cannot be bucketed
consistently; silently dropping everyone who lacks it into variation 0 is the
kind of skew nobody notices until the results are already wrong.

In a rule, `null` means the rule does not match and evaluation continues. At the
fallthrough there is nowhere to continue to — see
[decisions §6](../decisions.md).

## Bucketing on a different kind

```ts
{ contextKind: "organization", variations: [...] }
```

Rolls out to 10% of **organizations** — everyone in an org flips together —
rather than 10% of users, which produces a half-migrated org and a support
ticket. Verified: 500 users in one org all resolve to the same variation.

## Measured uniformity

200,000 synthetic contexts through a 10% rollout landed at 9.98%; all ten
deciles fell within 9.5–10.5%.
