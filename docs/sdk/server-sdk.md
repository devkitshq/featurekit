# The server-tier SDK

`src/sdk/client/sdk.ts` · §11.2, §14

```ts
import { FeatkitSDK } from "featkit";

const fk = new FeatkitSDK({
  sdkKey: process.env.FEATKIT_SDK_KEY!,
  baseUrl: "https://flags.internal.acme.com",
  bootstrap: snapshotJson,
  persist: { kind: "file", path: ".featkit/snapshot.json" },
  mode: "streaming",
});

await fk.ready({ timeoutMs: 5_000 });

const on = fk.get("new-checkout", ctx, false);       // synchronous
```

## Three properties this class exists to guarantee

1. **Every evaluation is synchronous** and reads an in-memory snapshot. No
   network call per check, no promise per check.
2. **It survives the server being gone.** Bootstrap → persisted snapshot →
   last-known-good in memory → the caller's default.
3. **`ready()` never rejects.** It times out into "serving defaults", which is a
   legitimate state to run in, not an error. A `ready()` that throws turns a
   control-plane outage into a failed deploy.

All three are asserted in `tests/chaos/reliability.test.ts` against a control
plane that is genuinely killed mid-load: zero evaluation errors, zero changed
values, and 10,000 evaluations against a dead server in well under a frame.

## The default is a required argument

An optional default produces `undefined` in production during an outage, and
`if (undefined)` is a silent wrong answer nobody notices for a week. Requiring it
forces every call site to state what happens when featkit is unavailable — the
one decision a flag SDK must not make on your behalf.

## Zero runtime dependencies

`fetch` and `ReadableStream` directly, no SSE library, so the same file works in
Node, Deno, Bun and an edge runtime. SSE frames are parsed by splitting on a
blank line; anything short of one stays in the buffer as a partial frame.

`node:fs` is reached only through a **dynamic import**, and only when
`persist: { kind: "file" }` is used — so a browser or edge bundle never pulls it
in merely because this file was included.

## Version guards

Two of them, and both matter:

- **Snapshot level.** A `put` older than what is held is ignored. A rolled-back
  database republishing an old version becomes a non-event rather than a silent
  revert.
- **Per flag.** A `patch` at or below the held flag version is discarded (§10.2),
  which makes duplicate broadcasts and out-of-order delivery harmless.

The per-flag guard is easy to mistake for a bug when writing tests: a fixture
that changes a flag's config without bumping `flag_environments.version` models a
database that never recorded the change, and the SDK is *right* to ignore it.
`tests/sdk/client.test.ts` has a test asserting exactly that.

## Reconnect

Jittered exponential backoff, capped at 30s, **full jitter**. Without jitter a
control-plane restart is followed by every SDK in the fleet reconnecting in the
same millisecond — which is how a recovering control plane gets knocked over
again by its own clients.

On reconnect the SDK sends `Last-Event-ID` with the version it holds, so a brief
disconnect costs a couple of patches rather than a whole snapshot.

## Persistence

`persist` takes either `{ kind: "file", path }` or any object with
`load()` / `save()`. A missing or corrupt persisted snapshot is treated as
**absent, not fatal**: it is the ordinary first-run state, and a corrupt file
must not stop the process from starting.

## Event summaries

500 evaluations become **one** bucket, not 500 requests. Buckets are keyed
`(flagKey, variationIndex, reason)` and flushed on an interval.

Two bounds, both drop rather than grow:

- `maxBuckets` caps distinct buckets; over it, records are dropped and counted.
- Distinct context keys per bucket are capped, after which the unique count
  becomes a floor rather than an exact figure.

An unbounded `Set` of context keys here is a memory leak proportional to
traffic — the exact failure the summarizer exists to prevent. Analytics loss is
acceptable; blocking an evaluation is not.

## Modes

| Mode | Behaviour |
| :-- | :-- |
| `streaming` (default) | SSE, with polling fallback if the server sheds it |
| `polling` | `If-None-Match` on an interval |
| `offline` | **Never touches the network.** Bootstrap and persistence only |

`offline` is asserted with an injected `fetch` that throws if called.
