# Context

`src/sdk/evaluation/context.ts` · §9.8

Multi-context exists from day one because retrofitting it is brutal, but
`"user"` is implicit and default everywhere so the simple case stays simple.

```ts
// Single — the only shape most callers ever write
fk.get("new-checkout", { key: "usr_123", plan: "pro", country: "DE" }, false);

// Multi — on for a beta org, on a supported device
fk.get("new-checkout", {
  kind: "multi",
  user:         { key: "usr_123", plan: "pro" },
  organization: { key: "org_9", tier: "enterprise" },
  device:       { key: "dev_abc", os: "ios", osVersion: "17.2" },
}, false);
```

A clause names its `contextKind`; **if that kind is absent, the clause does not
match**, and that is a resolved answer rather than an unknown one.

## Validity

`normalizeContext` returns `null` — never throws — for: a non-object, a missing
or non-string `key`, a blank key, a multi-context with no kinds, or a
multi-context member that is not an object or lacks a key. The evaluator turns
`null` into the caller's default with `reason: ERROR / MALFORMED_CONTEXT`.

## Attribute resolution

| Attribute | Resolves to |
| :-- | :-- |
| `"key"` | the context key |
| `"plan"` | own property `plan` |
| `"address.country"` | nested walk through own plain objects |
| `"kind"` | **always `undefined`** — reserved |
| anything on an absent kind | `undefined` |

**Only own properties are ever read.** A rule author writing `constructor`, or
a context deserialised from user-controlled JSON carrying `__proto__`, must not
reach `Object.prototype`. Tested explicitly.

Arrays are returned whole, so the operator layer can apply the "matches if any
element matches" rule (§9.6).

## Shape, and why it looks like this

This file is on the hot path. The first implementation allocated a `Map` and
copied every attribute into a fresh object per evaluation — **290 ns**, twenty
times the whole budget in §1. Two changes removed nearly all of it:

- **`SingleKindContext`** holds the caller's own object by reference. No Map, no
  copy. The multi-context path still uses a `Map`, which satisfies the
  `NormalizedContext` interface structurally.
- **`getAttribute` does not `split(".")`** unless the attribute contains a dot.
  It was allocating an array on every attribute read; the overwhelming majority
  of attributes are flat.

The cost of not copying is that **`kind` is reserved**: it is the discriminator
in the single-context shape, and a rule that could read it in a multi-context
but not a single one would be worse than one that can read it in neither. See
[decisions §8](../decisions.md).

## Bucketing values

`bucketValue(context, kind, bucketBy)` returns the string a rollout hashes, or
`null`.

Strings pass through; finite numbers and booleans are stringified, since each
has one unambiguous spelling in every language. **Objects and arrays return
`null`** — `JSON.stringify` is key-order dependent, so bucketing on one would
be inconsistent across SDKs. Missing and `null` attributes return `null` too.
