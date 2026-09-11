# Clause operators

`src/sdk/evaluation/operators.ts` · §9.6

Three rules govern the whole file.

1. **Type mismatch is `false`** — never a throw, never a coercion.
2. **Multi-valued attributes match if *any* element matches.**
3. **Nothing throws.** A malformed rule that can throw into the customer's
   request path is worse than no flag library.

Clauses within a rule are ANDed; rules are ORed by first-match. There is no
nested boolean expression tree, deliberately (§7.5): the UI for one is bad, the
semantics are hard to explain at 3am, and anything genuinely more complex
belongs in a segment.

## The operators

| Group | Operators | Notes |
| :-- | :-- | :-- |
| Equality | `in` | Strict, plus structural equality for objects/arrays. No coercion: `"42" in [42]` is false |
| String | `startsWith` `endsWith` `contains` | Both sides must be strings |
| Regex | `matches` | Unanchored. Invalid pattern → false. Capped at 1,000 chars |
| Numeric | `lessThan` `lessThanOrEqual` `greaterThan` `greaterThanOrEqual` | Finite numbers only. Booleans are not numbers; NaN and ±∞ never match |
| Date | `before` `after` | ISO-8601 strings or epoch ms, mixable. Equal instants are neither |
| Version | `semVerEqual` `semVerLessThan` `semVerGreaterThan` | Full semver precedence |
| Segment | `segmentMatch` | Handled in `evaluate.ts` — it needs the unresolved third state |

An **unknown operator is false**, so an SDK older than a rule degrades instead
of throwing. A snapshot may legitimately be newer than the SDK reading it.

## Regexes

The dashboard length-caps and complexity-checks patterns at write time (§9.6),
but a snapshot is a wire format arriving over the network and the SDK does not
get to assume the writer validated it. So the cap is enforced here too, and a
pattern that fails to compile yields `false` rather than an exception. A rule
author with a regex is a rule author with a ReDoS, running inside the
customer's request path.

## semver

Accepts partial versions (`"17.2"` → 17.2.0), because real attributes carry
them. Rejects leading zeros, per spec. Build metadata is ignored for
precedence. Prerelease ordering follows the spec exactly:

```
1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.9 < 1.0.0-alpha.10 < 1.0.0-beta < 1.0.0
1.0.0-1 < 1.0.0-alpha          numeric identifiers rank below alphanumeric
```

`1.0.0-alpha.9 < 1.0.0-alpha.10` is the case a lexical comparison gets wrong.

## Multi-valued attributes

`groups: ["a","b"]` against `in: ["b"]` matches. This applies to **every**
operator, not just `in`:

```ts
["acme-eu", "other"]  startsWith ["acme"]   // true
[1, 50]               greaterThan [10]      // true
```

Nested arrays are not flattened: `[["b"]]` does not match `in: ["b"]`.

## Negation

`negate` inverts **after** evaluation, so a non-match caused by a missing
attribute becomes a match under negation — the semantics people expect from "is
not in".

`negate` never inverts an **unresolved** clause. Unresolved is a third state
that short-circuits the rule before negation is applied, and that is enforced
one level up in [the evaluator](evaluator.md#fail-closed).
