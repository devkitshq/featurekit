# The client tier over plain HTTP

`src/routes/client.ts` · §11.5, §14, §16

There are two SDKs — `togglekit` for server-side JavaScript, `togglekit-client`
for everything else that runs JavaScript. There is no Swift SDK, no Kotlin SDK,
no Go SDK, and none is planned. The client tier is two HTTP endpoints and a
JSON body; a language that can POST can implement it in an afternoon, and that
is a better guarantee than a client library we update when we remember to.

```
POST /v1/client/state    context in -> evaluated values out
GET  /v1/client/stream   SSE value updates for that connection's context
```

`togglekit-client` is a reference implementation of exactly this. When
something here is ambiguous, `packages/client/src/index.ts` is the answer.

## Authentication

A **client** key (`tk_clt_…`) or a **mobile** key (`tk_mob_…`), in either the
`Authorization` header or a `key` query parameter:

```
Authorization: Bearer tk_clt_…
```

The query parameter exists because `EventSource` cannot set headers. Use the
header wherever you can — a key in a URL lands in access logs and `Referer`.

A **server** key is rejected here, deliberately and symmetrically: the server
tier refuses client keys too. A server key on this tier would mean a browser
holding the whole ruleset, which is the thing the tier split exists to prevent.

Client keys are public by construction. They ship in a page, a binary, an APK
anyone can unzip. That is safe because a client key buys evaluated values for
one context — never the rules that produced them.

## POST /v1/client/state

```http
POST /v1/client/state HTTP/1.1
Authorization: Bearer tk_clt_…
Content-Type: application/json

{
  "context": { "key": "u-ana", "plan": "free", "tenureMonths": 2 },
  "seq": 1,
  "signature": "9f2c…",
  "expiresAt": 1789000000
}
```

| field | required | meaning |
| :-- | :-- | :-- |
| `context` | yes | The identity to evaluate as. `key` is the stable identifier; every other field is an attribute rules may target. |
| `seq` | no | Any monotonically increasing integer of yours. Echoed verbatim. See [ordering](#ordering-is-your-problem-too). |
| `signature` | in production | HMAC over the context. See [secure mode](#secure-mode). |
| `expiresAt` | with `signature` | Unix seconds. The signature covers it. |

```json
{
  "contextHash": "3f9a…",
  "seq": 1,
  "version": 412,
  "connectionId": "c_8Xk2…",
  "values": {
    "new-checkout":     { "value": false, "variationIndex": 0, "reason": "FALLTHROUGH" },
    "loyalty-discount": { "value": 0,     "variationIndex": 0, "reason": "FALLTHROUGH" },
    "promo-banner":     { "value": "Upgrade to Pro and save 10%.", "variationIndex": 1, "reason": "RULE_MATCH" }
  }
}
```

`values` is the entire payload. There are no rules in it, no rollout
percentages, no segment definitions, and no `ruleIndex` telling you *which* rule
matched — only the reason kind. Flags marked `clientAvailable: false` are absent
rather than filtered: the existence of an unreleased feature is itself withheld.

`connectionId` is the handle for the stream. An empty string means the node is
at its connection cap and is asking you to poll instead — treat it as "no
stream available", not as an error.

### Errors

| status | body `error` | what to do |
| :-- | :-- | :-- |
| 400 | `MISSING_CONTEXT` | You sent no `context`, or it failed the schema. |
| 400 | `CONTEXT_TOO_LARGE`, and siblings | The context exceeded a size limit. Send less. |
| 401 | `MISSING_SDK_KEY` | No key in header or query. |
| 401 | `SDK_KEY_*` | Wrong kind of key, revoked, or unknown. |
| 401 | `SIGNATURE_MISSING` / `SIGNATURE_INVALID` | Fall back to your own defaults. Do **not** retry unsigned. |
| 401 | `SIGNATURE_EXPIRED` | Distinct on purpose: keep serving the values you hold, mint a fresh signature, retry. Not an identity change. |
| 500 | `SECURE_MODE_UNCONFIGURED` | Server-side misconfiguration; it fails closed rather than serving unsigned. |

Every failure path ends at *your* default. A client that returns `null` or
throws on an outage pushes an `if (undefined)` into the caller's code, which is
a silently wrong answer rather than a visibly missing one.

## GET /v1/client/stream

```http
GET /v1/client/stream?connection=c_8Xk2…&key=tk_clt_… HTTP/1.1
Accept: text/event-stream
```

Standard SSE. Frames are separated by a blank line:

```
event: ready
data: {"version":412}

event: values
data: {"version":413,"values":{"new-checkout":{"value":true,"variationIndex":1,"reason":"RULE_MATCH"}}}
```

- **`ready`** — the stream is live at that version.
- **`values`** — a **delta**. Merge it into what you hold; do not replace. Only
  flags whose value actually changed for *this* context are sent, so a targeted
  toggle reaches the few connections it affects and nobody else.

The stream carries no context of its own, which is why `POST /v1/client/state`
must come first — inventing an identity here would mean evaluating as somebody
nobody proved.

**`409 UNKNOWN_CONNECTION`** means the handle is unknown or has expired. Re-POST
`/v1/client/state` to get a new one. This is ordinary: it happens after a server
restart, and after a handle sits unused past its TTL (900s by default).

When the stream ends for any reason, re-POST and re-open. `togglekit-client`
waits 1.5s before doing so; anything in that neighbourhood is fine, with jitter
if you have many clients.

## Ordering is your problem too

This is the part an implementation gets wrong, and the failure is a privacy bug
rather than a glitch.

**On a context-key change, discard what you hold before you ask.** Between a
login and its response, return your caller's defaults — not the previous user's
values. An attribute-only change on the same key can keep serving; those values
are stale but not misattributed.

**Apply responses in call order, not arrival order.** Two identifies in flight:

```
POST state {key: "user_A", seq: 1}    slow
POST state {key: "user_B", seq: 2}    fast, applied
                                      seq 1 lands late — must be dropped
```

An account switcher, a doubled effect, or a login right after an anonymous
identify all produce this. Track the highest `seq` you have applied and drop
anything below it, and separately record which context key each request was
issued for and drop responses for a key you are no longer on. **Both checks,
not either**: `seq` catches reordering, the key catches a stale response for a
context that was re-identified back to an equal value. `contextHash` is there
for the same purpose if you would rather compare server-side hashes.

## Secure mode

In a production environment the context must be signed, because the server
evaluates *as* the identity it is given. Without a signature, anyone holding
the public client key could evaluate as any named account and read the flags
targeted at it.

Your own backend mints the signature, where the session is already trusted.
`togglekit/secure-mode` exports both halves so nobody has to reimplement them:

```ts
import { signContext, contextHash } from "togglekit/secure-mode";

app.get("/api/togglekit-signature", requireSession, (req, res) => {
  const context = { key: req.user.id, plan: req.user.plan };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  res.json({
    signature: signContext(context.key, expiresAt, SECRETS, contextHash(context)),
    expiresAt,
  });
});
```

A separate entry point from `togglekit` because of what it does not load: the
main entry is the control plane, so importing it pulls Drizzle, a Postgres
driver, ioredis and pino into a service whose only job is signing a string.
This one reaches `node:crypto` and nothing else, and `tools/check-package.mjs`
fails the build if that ever stops being true.

**Sign the attributes, not only the key.** The server also accepts a signature
over `"{key}:{expiresAt}"` alone, because deployments exist that mint them, and
it is the weaker form: it authenticates *who* the context claims to be and
nothing about what it claims to be true. A user holding a valid signature for
their own key can then send `{ key: "u-ana", plan: "enterprise" }` and be
evaluated as an enterprise customer. Passing `contextHash(context)` closes that.

Implementing it in another language, the payload is:

```
signature = HMAC_SHA256(secret, "{key}:{expiresAt}:{attributesHash}")
```

where `attributesHash` is the first 32 hex characters of the SHA-256 of the
canonicalised context — JSON with object keys sorted at every level, no
whitespace, arrays canonicalised elementwise:

```
{"key":"u-ana","plan":"free","tenureMonths":2}
```

Send the hex digest as `signature` and the same `expiresAt` you signed. TTLs
above the server's maximum (86,400s by default) are rejected outright, before
the HMAC is even checked — so a validly-signed decade-long token is refused
rather than honoured.

The expiry is load-bearing. A signature over the key alone would be a bearer
credential that never expires — captured once from a proxy log, an APM trace or
an error report, it would grant permanent ability to poll as that user, and the
only revocation would be rotating the secret for everybody at once. This bounds
replay rather than preventing it, which is stated plainly so nobody mistakes it
for something stronger.

Refresh before expiry rather than after: a signature that dies mid-flight
produces a 401 the user did not need to experience.

## Polling instead of streaming

Streaming is an optimisation, not a requirement. Re-POST `/v1/client/state` on
an interval and you have a correct client — one that is a poll interval stale
instead of a second, at the cost of a request per interval per client. That is
the right trade in a background job, a CLI, or any runtime where holding a
socket open is more trouble than it is worth.

## CORS

Only this tier answers browsers, so only this tier has CORS, and never with
`*` — the response body is a user's evaluated flag values. Configure exact
origins on the control plane:

```js
corsAllowedOrigins: ["https://app.acme.com"]
```

An origin that is not on the list gets no CORS headers and the browser refuses
the response, which is the correct outcome and needs no error of ours. Native
apps send no `Origin` and are not subject to any of it.

## A minimal implementation

```python
import json, urllib.request

def state(base, key, context, seq):
    body = json.dumps({"context": context, "seq": seq}).encode()
    request = urllib.request.Request(
        f"{base}/v1/client/state",
        data=body,
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)

values = state("https://flags.acme.com", CLIENT_KEY, {"key": "u-ana", "plan": "free"}, 1)["values"]

def get(flag, default):
    found = values.get(flag)
    if found is None:
        return default
    # A wrong-typed value must not reach the caller in place of its default.
    return found["value"] if isinstance(found["value"], type(default)) else default
```

That is a working client tier consumer. Add the stream, the ordering guards and
secure mode as you need them.
