# Server-tier delivery

`src/routes/sdk.ts` · `src/http/` · §10.2, §12

```
GET  /v1/stream/:envKey     SSE ruleset stream (server keys only)
GET  /v1/snapshot/:envKey   Poll fallback (ETag / 304)
POST /v1/events             Batched evaluation summaries
```

## No HTTP framework

§2 lists the `featurekit` package's runtime dependencies as drizzle, postgres,
ioredis, pino, prom-client and zod. No HTTP framework — a deliberate signal
rather than an omission. The control plane serves a handful of routes plus two
long-lived SSE endpoints, and SSE is the one thing framework abstractions
reliably get in the way of.

`src/http/router.ts` is ~150 lines and distinguishes 404 from 405, because "wrong
URL" versus "wrong verb" is most of the debugging time on a REST client.

## Authorisation is the tier split

| Check | Why |
| :-- | :-- |
| Server keys only on `/v1/stream` and `/v1/snapshot` | A client key here hands a browser the rules the entire client tier exists to withhold |
| Client/mobile keys only on `/v1/client/*` | A server key used from a browser is a leaked ruleset |
| Path environment must match the key's | Otherwise a valid staging key reads production by editing the URL |
| One 401 for every rejection | Distinguishing "unknown" from "revoked" is a key-probing oracle |

A revoked key is kept rather than deleted — the audit log references it — so
"found in the database" is never sufficient on its own.

## Polling is first class, not degraded

`GET /v1/snapshot/:envKey` with `If-None-Match` returns 304 and no body when the
poller is current. At a few thousand SDKs on a 30s poll, the body is the entire
cost of this endpoint.

Corporate proxies eat SSE, and some runtimes have no long-lived connections. The
SDK also *falls back* to polling when the server sheds it.

## SSE

`id:` is the snapshot version, which is what `Last-Event-ID` resumes from.

Two headers are load-bearing: `X-Accel-Buffering: no` and `setNoDelay(true)`. A
proxy that buffers, or a socket that coalesces, turns a sub-300ms kill switch
into whatever the flush interval happens to be.

Heartbeats every 30s by default, so proxies do not reap an idle connection — a
flag that changes once a week must not need a reconnect to be delivered.

### The resume bug this found

An empty replay — a client reconnecting that is *already current* — left the
sent-version at 0 and triggered a full `put` of the entire snapshot. A fleet
flapping its connections would each pull a complete snapshot for no reason, which
is precisely what resume exists to avoid. Fixed by initialising the sent version
from `Last-Event-ID` before applying replayed patches;
`tests/control-plane/sdk-routes.test.ts` has a regression test that asserts a
current client receives *nothing*.

### Live updates reuse the resume path

On a broadcast, the connection asks `patchesSince(sent)` rather than trusting the
message payload. That path is already correct about the three full-`put` cases,
and it means a node that missed a message still converges.

## Capacity shedding

Above `MAX_STREAM_CONNECTIONS` a new stream gets 503 `STREAM_CAPACITY` rather
than a connection the node cannot serve. The SDK takes the hint and polls. The
tier degrades on a curve instead of a cliff.

## Events

`POST /v1/events` returns **202 even when ingest fails**. Analytics loss is
acceptable; blocking an SDK is not (§14). Failing the request would make the SDK
retry a batch that is already stale, on the same connection that carries nothing
else important.
