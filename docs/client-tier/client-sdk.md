# The client tier

`packages/client/src/index.ts` · `src/routes/client.ts` · §11.5, §14, §16

```
POST /v1/client/state    context in -> evaluated values out
GET  /v1/client/stream   SSE value updates for the connection's context
```

```ts
const fk = new FeaturekitClient({
  clientKey: PUBLIC_KEY,
  baseUrl: "https://flags.acme.com",
  context: { key: user.id, plan: user.plan },
  contextSignature: serverIssuedHmac,
  contextSignatureExpiresAt: expiresAt,
  onSignatureExpiring: refreshSignature,
  bootstrap: ssrInlinedState,
});

fk.get("new-checkout", false);                  // synchronous, NO context argument
await fk.identify({ key: newUser.id });         // the one async operation
```

Both SDKs read with `get(key, …, default)`. The signature difference is the
context: the server SDK takes one **per call**, because it holds the ruleset and
answers for any identity; this one takes **none**, because the connection *is*
the context and an instance holds one identity at a time.

## One instance, one identity

That design is right for a browser or a phone, where there is one user in front
of the screen. It is a hazard in a process that answers for many users at once:
`identify()` replaces the instance's context and its held values, so a single
shared client whose identity is swapped per request will answer a request for
user B with whatever the last `identify()` left behind.

A backend using this SDK therefore wants **one instance per identity**, which
costs a state round trip per identity. If that is the wrong trade — a request
handler on a hot path, say — use `FeaturekitSDK` from `featurekit` instead: it
holds the compiled ruleset in memory and takes a context per call, so any number
of identities are evaluated synchronously with no network at all.

## One client, no framework bindings

There is no React package, no Vue package, no React Native package. The SDK
runs in a browser, React Native, Node, Deno, Bun and edge runtimes, and knows
about none of them.

A binding is twenty lines over two methods that already exist —
`detail(flagKey)` reads synchronously, `on("change", handler)` returns an
unsubscribe function — and a package per framework turns those twenty lines
into a version matrix: a release owed on somebody else's schedule, a breaking
change nobody chose, and a project on the framework not yet packaged told to
wait for an adapter shorter than the issue they filed.

[Framework adapters](adapters.md) has the twenty lines for React, Vue and
Svelte. Copy the one you need; it is then yours.

## Not writing JavaScript?

There is no Swift, Kotlin or Go SDK either, and none is planned. The two
endpoints above are the whole contract — see
[the client tier over plain HTTP](http.md), which documents the wire format,
the ordering guards, secure mode and a working thirty-line implementation.

## The client tier does not receive the ruleset

Shipping rules to a browser leaks the business, not just the values. A rule
reading `plan == "enterprise" -> new-pricing` tells anyone with devtools that an
unreleased pricing tier exists and what it is called. Segment definitions name
your churn-risk cohort. Rollout percentages disclose release plans. None of that
is fixed by minification.

**The tier split is the security boundary** (§16) — not a filter applied at
serialisation time, which is a filter someone eventually forgets on a new
endpoint. So the client routes accept only client/mobile keys, and the server
routes accept only server keys. Both directions are asserted.

## What this costs, honestly

- **One round trip per context change**, not per evaluation. `identify()` is the
  only async call.
- **On a context-key change, previous values are discarded, not reused.** Serving
  user A's flags to user B after a login is a real bug class and a privacy leak.
  Between `identify()` and its response, every lookup returns the caller's
  default. Attribute-only changes on the same key keep serving the old values —
  stale, but not misattributed.
- **What still leaks:** the keys of flags marked `clientAvailable`, and the
  values *this* context receives. Inherent to any client-side flag system.
  `clientAvailable` defaulting to `false` is what keeps unreleased work out of it
  entirely.

## Responses apply in call order, not response order

Discarding on key change is necessary but **not sufficient** — two rapid calls
reintroduce the same bug through the network:

```ts
fk.identify({ key: "user_A" });   // request 1 -- slow response
fk.identify({ key: "user_B" });   // request 2 -- fast response, applied
                                  // request 1 lands late, overwriting B with A
```

An account switcher, a React effect that fires twice, or a login immediately
after an anonymous identify all produce this, and the result is exactly the
failure the previous rule exists to prevent, arriving by a route that rule does
not cover.

So the SDK holds a monotonically increasing `seq`, allocated **before** the
await, and drops:

- any response whose `seq` is below the highest already applied — catches
  reordering;
- any response requested for a context key that is no longer current — catches
  identity;
- a response whose server `contextHash` disagrees with what was last accepted for
  the same key — catches an attribute change that raced an in-flight request.

**All of them, not one.** The superseded call's promise *resolves* rather than
hanging: it was superseded, not failed. And the stream is re-subscribed only on
the winning response, so a late reply cannot resurrect a closed connection's
context.

`tests/client-tier/client.test.ts` drives this with an artificially delayed
response for A and a fast one for B, and asserts B wins.

## Catch-up on stream open

`POST /v1/client/state` returns values at version V; the SSE stream opens a round
trip later. A change landing in that window is broadcast to connections that
exist *at broadcast time* — and this one did not.

Without a catch-up that change is missed **permanently**, not merely late. So on
stream open the server compares the connection's last-sent version against the
current snapshot and pushes a delta if it is behind. This is the client tier's
equivalent of `Last-Event-ID` replay.

## Secure mode

Because the server evaluates *as* a claimed identity, an unsigned context key
would let anyone evaluate as anyone — including reading flags targeted at a
specific named account.

The signature is `HMAC_SHA256("${key}:${expiresAt}", SECRET)`. Signing the key
alone, as r2 did, makes it a **bearer credential that never expires**: captured
once from a proxy log, an error report carrying request headers, an APM trace, or
a shared browser session, it grants permanent ability to poll as that user. The
only revocation would be rotating the secret, which invalidates every user
simultaneously and so is never done for one leak. A credential whose only
revocation mechanism is a global outage is not revocable.

The server additionally rejects an `expiresAt` further out than
`SECURE_MODE_MAX_TTL_SECONDS`, **checked before the HMAC**, so a validly-signed
decade-long token is refused rather than accepted.

| Rejection | SDK response |
| :-- | :-- |
| `SIGNATURE_EXPIRED` | **Last values keep serving** while `onSignatureExpiring` fetches a fresh pair. Expiry is not an identity change |
| `SIGNATURE_INVALID` / `SIGNATURE_MISSING` | Drop to caller defaults. Never a silent downgrade to unsigned |
| `SIGNATURE_TTL_TOO_LONG` | Refused outright |

**This bounds replay rather than preventing it.** A captured signature is usable
until `expiresAt`. Closing that window entirely needs a server-side nonce per
connection — per-connection write state on a tier explicitly designed not to have
any, to defend a payload that is already only *this* user's flag values. A
bounded, rotatable window matching ordinary session lifetimes is the right trade,
and it is stated here so nobody mistakes it for something stronger.
