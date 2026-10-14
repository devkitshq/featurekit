# Fingerprint-keyed fan-out

`src/evaluation-service/fanout.ts` · §11.5, §22.1

## The problem

The naive fan-out is a thundering herd pointed at your own control plane. Toggle
one flag with 50,000 connected browsers and the control plane immediately owes
50,000 evaluations and 50,000 distinct SSE writes — a self-inflicted load spike,
triggered by the most routine action in the product, at exactly the moment an
operator is most likely to be flipping a kill switch during an incident.

Sharding the API tier does not fix it. It distributes the same total work while
multiplying the connection state.

## The observation that collapses it

**An evaluation is a function of the attributes the flag's rules actually
reference, and nothing else.** The compiler already emits that set
(`referencedAttributes`, §10.1), so contexts are normalised down to those
attributes and grouped:

```
compiler emitted: referencedAttributes("new-checkout") = ["user.country", "user.plan"]
connection ctx:   { key: "usr_9f3", country: "US", plan: "pro", email: …, signupAt: … }
fingerprint:      "user.country=US|user.plan=pro"        // the key is NOT included
```

50,000 contexts collapse to the few hundred distinct `(country, plan)` pairs that
actually exist. Evaluation count drops from *connections* to *distinct attribute
combinations*.

Measured in `tests/client-tier/fanout.test.ts`: 50,000 connections spanning 20
distinct pairs produce **20 evaluations**, not 50,000.

## Three details that make it correct rather than approximately correct

**1. Percentage rollouts break the collapse, and are handled separately.** A
rollout buckets on the context *key*, so such a flag has a per-context answer by
construction. The compiler marks these (`perContext`) and their fan-out computes
the value per connection — but that is an integer hash (§9.3, tens of ns), not a
rule evaluation, so 50,000 of them is under a millisecond of CPU. The test
asserts a 50/50 rollout still splits 50/50 across connections.

**2. Individual targets break it too**, in the same way and with the same
handling: `targets` is a key lookup. So does a segment clause, since membership
resolves by key. All three set `perContext`.

**3. The fingerprint excludes the context key** — that is the entire point. It is
what makes the cache safe to share across users: two contexts with the same
fingerprint are, for these flags, indistinguishable. It also means the cache must
be invalidated on a snapshot version bump, so it is keyed
`(environmentId, version, flagKey, fingerprint)` — **a bump invalidates by
construction rather than by an explicit sweep** someone eventually forgets to
call. The environment is in the key because one instance serves every
environment and versions restart at 1 in each; without it, two environments at
the same version shared cached values.

## What crosses to the browser

Only the reason *kind*. `ruleIndex` and `ruleId` would disclose the shape of the
ruleset the client tier exists to withhold — the same leak as shipping the rules,
one field at a time. Asserted: the response for a rule match contains
`"reason":"RULE_MATCH"` and not the rule's id.

Flags without `clientAvailable` are never evaluated for the client tier and their
keys never appear in a payload, so an unreleased feature's *existence* stays
private, not just its value.

## Why this is in M2/M5 and not later

§22.1 is explicit. The cache itself is small, late work. What is *not* small is
the compiler emitting referenced-attribute sets, the wire format carrying them,
and the evaluator being structured so a rule outcome can be computed once and
specialised per connection. Retrofitting that into a shipped evaluator is the
rewrite r2 was worried about; emitting the sets in M2 cost almost nothing.
