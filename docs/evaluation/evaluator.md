# The evaluator

`src/sdk/evaluation/evaluate.ts` · §9.1, §9.2

```ts
evaluate<T>(flagKey, context, snapshot, defaultValue, options?) : EvaluationDetail<T>
```

Synchronous. Pure. **Never throws.**

## Precedence

Fixed, never configurable — configurable precedence makes flags impossible to
reason about.

```
1. Flag not in snapshot ....... caller's default   FLAG_NOT_FOUND
2. Flag off ................... offVariation       OFF
3. Prerequisite unmet ......... offVariation       PREREQUISITE_FAILED
4. Individual target match .... target variation   TARGET_MATCH
5. First matching rule ........ variation/rollout  RULE_MATCH
6. Fallthrough ................ variation/rollout  FALLTHROUGH
```

An error at any step returns the **caller's default** with `reason: ERROR`.

## Why the default is required, not optional

Optional defaults produce `undefined` in production during an outage, and
`if (undefined)` is a silent wrong answer nobody notices for a week. Requiring
it forces every call site to state what happens when featurekit is
unavailable — the one decision a flag SDK must not make on your behalf.

When there is no off variation, `OFF` serves the caller's default rather than
inventing a value.

## Prerequisites

A prerequisite is met only when the prerequisite flag is **on** *and* resolves
to the required variation index.

**An off prerequisite always fails**, whatever its off variation happens to be.
"Off" is not "serving variation 1"; a kill switch must propagate to everything
gated behind it. See [decisions §7](../decisions.md).

The first unmet prerequisite is the one reported — that is what the MCP agent
reads back ("`new-checkout` has a prerequisite `payments-v2` requiring
`enabled`…").

The compiler rejects cycles at compile time, so the evaluator never needs cycle
detection on the hot path. A depth cap (default 20) exists anyway as defence
against a corrupt snapshot, and reports
`ERROR / PREREQUISITE_DEPTH_EXCEEDED` rather than blowing the stack.

## Type safety

A variation's value is checked against the flag's declared `kind` before it is
served. A boolean flag must never hand a string to `if (fk.get(key, false))`; a
snapshot claiming otherwise yields `ERROR / WRONG_TYPE` and the caller's
default. `json` flags accept any JSON value, including `null`.

Out-of-range variation indices yield `ERROR / VARIATION_OUT_OF_RANGE`.

## Never throwing

Every path is defensive, and there is a `try/catch` around the whole function
as the belt to those braces — anything reaching it is a bug in this file, and a
bug in this file must still not throw into a request path.

A structurally broken flag returns the caller's default and **does not affect
any other flag** in the snapshot. Tested.

## Fail-closed {#fail-closed}

The single most important behaviour in this file, and the bug §22.3 records.

A clause result is **three-valued**:

```ts
type ClauseResult =
  | { matched: true }
  | { matched: false }
  | { unresolved: true; segmentKey: string };   // never negated
```

A segment is unresolved when its structure cannot be read — a corrupt
snapshot, or a filter in a format this SDK does not decode. Treating that as
"not a match" sounds conservative. **Under negation it is precisely the
opposite:**

```
Rule: user is NOT in "beta_testers"  ->  serve new-checkout

Segment cannot be read:
  clause "in beta_testers"  -> false     (unresolved, treated as a no-match)
  negate: true              -> inverts to TRUE
  -> the rule matches, and every user is served the gated feature.
```

A negated segment clause is the ordinary way to write an exclusion list —
"everyone except the enterprise accounts" — so this is the exclusion list
failing **open**.

The fix is that unresolved never reaches the negation operator:

- `negate` is applied only to a resolved boolean.
- An unresolved clause fails the **whole rule**, in either polarity.
- Evaluation falls through to the next rule and ultimately to the fallthrough
  or off variation — the same place a genuinely non-matching context lands.
- A later, fully-resolvable rule still matches normally.

`tests/evaluation/evaluate.test.ts` asserts both polarities, and the
conformance corpus carries both so every future SDK port is held to it.

## The `unresolved` annotation

`reason` reports what was actually served. `EvaluationDetail.unresolved` names
every rule that was skipped and which segment could not be verified:

```ts
{
  value: false,
  variationIndex: 0,
  reason: { kind: "FALLTHROUGH" },
  unresolved: [{ ruleIndex: 0, ruleId: "r0", segmentKey: "enterprise",
                 reason: "SEGMENT_UNRESOLVED" }],
}
```

So `POST /v1/debug/evaluate` can say "this rule was skipped because a segment
could not be read" rather than "no match" — the difference between a
five-minute diagnosis and an afternoon. The array is allocated lazily; a clean
evaluation allocates none.

See [decisions §5](../decisions.md) for why this is an annotation rather than
the `reason` itself.

## Evaluating without segment state

Legitimate but degraded: every segment clause is unresolved, so every rule
containing one fails closed. It does not throw and it does not grant the feature
under negation. The SDK and the client tier both always pass an index built from
the snapshot, so in practice this means a caller of `evaluate()` that forgot to.
