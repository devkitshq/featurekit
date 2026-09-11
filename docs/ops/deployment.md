# Deployment, migrations, backup and recovery

## Starting the thing

```bash
npm run build
DATABASE_URL=... REDIS_URL=... npm run migrate     # once, as a deploy step
DATABASE_URL=... REDIS_URL=... ADMIN_TOKEN=... npm start
```

`npm start` runs `dist/main.js`, which loads configuration, fails loudly and
completely on anything missing (every missing variable at once — three restarts
to discover three missing variables is three outages), and binds the port.

Local development, with containers:

```bash
docker compose up -d          # postgres + redis
npm run migrate
npm run dev
```

---

## Migrations

**Migrations never run inside a booting node.** `npm run migrate` is a separate
deploy step, run once. Every node running them on startup is a lock convoy: N
nodes take the same locks in the same order at the same moment, one of them
holding an ACCESS EXCLUSIVE lock on a large table while the others queue behind
it — during a deploy, while traffic is shifting.

The script takes a Postgres advisory lock first, so two concurrent runs (a
retried deploy, two CI jobs) are safe: the second waits and then finds nothing
to do. It also calls `featurekit_ensure_partitions(7)`, because a deploy that
leaves the analytics table without partitions has not finished — it has just not
failed yet.

```bash
npm run migrate            # apply
npm run migrate:check      # report applied count and partition runway
```

Those two are repository scripts. As an installed dependency, the same thing is
a function — `scripts/` is not in the published package, and for a while that
made the advice on this page unfollowable for anyone who had `npm i featurekit`
rather than a checkout:

```js
import { migrate, migrationStatus } from "featurekit/migrate";

await migrate();                                   // apply
const { applied, partitionRunwayDays } = await migrationStatus();
```

It reads `DATABASE_URL` or takes `{ databaseUrl }`, and refuses to default to
anything: a deploy job with a missing variable migrating the wrong database is
worse than a failed deploy. `FeaturekitServer`'s `autoMigrate` calls the same
function, so the boot-time path and the deploy step apply the same SQL under the
same advisory lock rather than being two implementations that drift.

A separate entry point because a deploy job should not load the route layer,
Redis and the metrics registry to run one statement.

**Migrations are forward-only, and additive by policy.** Rolling back code is
safe; rolling back schema is not. The policy that makes both true:

- New columns are nullable or defaulted. Never `NOT NULL` without a default in
  the same migration that populates it.
- Columns are not dropped or renamed in the release that stops using them. Two
  releases: stop writing, then drop.
- Indexes on large tables use `CREATE INDEX CONCURRENTLY`, outside a transaction.
- `evaluation_summaries` DDL lives in hand-written SQL, not drizzle-kit output —
  drizzle cannot emit `PARTITION BY`, and its plain `CREATE TABLE` would silently
  shadow the partitioned one.

**Order for a normal release:** migrate → deploy new nodes → drain old nodes.
This works because migrations are additive: old code runs against the new schema
for the length of the rollout.

---

## Rolling deploys and draining

Shutdown is ordered, and the order is the point:

1. `SIGTERM` arrives; `/ready` starts answering 503 so the load balancer stops
   sending work **before** the socket stops accepting it.
2. The server stops accepting new connections.
3. Every open SSE stream is sent a `reconnect` event carrying an individual,
   jittered delay. Without this, severing thousands of streams at once produces
   a synchronised reconnect storm against the nodes still up — on every release.
4. In-flight requests finish, bounded by `SHUTDOWN_GRACE_MS` (default 10s).
5. Sockets close; the rollup worker flushes once more; Postgres and Redis
   handles close.

A second `SIGTERM` during the drain exits immediately — the operator's escape
hatch.

**Configure the orchestrator to match.** The termination grace period must
exceed `SHUTDOWN_GRACE_MS`, or the drain is killed halfway and step 3 was
pointless. For Kubernetes: `terminationGracePeriodSeconds: 30` against the
10-second default.

**Probes:**

| Probe | Path | Notes |
| :-- | :-- | :-- |
| Liveness | `/live` | Never touches a dependency. A liveness probe that checks Postgres restarts every node during a database blip. |
| Readiness | `/ready` | Fails on Postgres and on partition runway; *degrades* rather than fails on Redis. |

---

## Backup and recovery

### Postgres is the only thing backed up

| | |
| :-- | :-- |
| **RPO** | 5 minutes (continuous WAL archiving) |
| **RTO** | 1 hour (restore + replay + verify) |
| **What is lost at RPO** | Up to 5 minutes of flag configuration changes and audit rows |

Requirements:

- Nightly base backup plus continuous WAL archiving. Point-in-time recovery is
  the feature that matters here — the realistic disaster is not disk loss, it is
  a bad bulk change, and "restore to 14:02" is the recovery for it.
- **Rehearse it.** An unrehearsed restore is a hypothesis. Quarterly, restore to
  a scratch instance and run `npm run migrate:check` plus a snapshot compile
  against it.

### Redis is not backed up, deliberately

Every key in Redis is rebuildable from Postgres, and the rebuild cost of each is
documented in `src/redis/keys.ts`. Persistence (RDB/AOF) is optional and buys
only a faster warm-up. Backing it up would create a second source of truth for
configuration, which is the failure mode the whole storage design avoids.

**One consequence to state plainly:** restoring Postgres to an earlier point
in time rolls `environments.snapshot_version` backwards. SDKs reject snapshots
whose version is not greater than what they hold, so after a point-in-time
restore, bump every environment's `snapshot_version` past the highest value the
fleet has seen:

```sql
UPDATE environments SET snapshot_version = snapshot_version + 10000;
```

Then force a recompile per environment. Skipping this leaves the fleet frozen on
its last good snapshot with nothing in the logs to explain why.

### Analytics

`evaluation_summaries` is retained 90 days and is explicitly not part of the
recovery objective. Losing it loses reporting, not flag behaviour.

---

## Capacity

### Configured ceilings

| Resource | Limit | Set by |
| :-- | :-- | :-- |
| Server SSE connections | 10,000 | `MAX_STREAM_CONNECTIONS`; above it, SDKs are told to poll |
| Client SSE connections | 50,000 | `MAX_CLIENT_CONNECTIONS` |
| Buffered analytics rows | 100,000 | `EVENT_BUFFER_MAX`; drop-oldest past it |
| Segment members per compile | 2,000,000 | `SEGMENT_MEMBER_CEILING`; past it the compile fails loudly |
| Postgres connections | 10 | `DB_MAX_CONNECTIONS` |

### Measured, on one machine

From `node tools/load.mjs --connections 2000 --requests 3000`, Node 22.19 on
win32/x64 (a developer laptop, not a server). **These are measurements, not
projections.** Extrapolating to a fleet is the reader's job, and the loopback
overhead below is part of why.

| Scenario | p50 | p99 | p99.9 | Note |
| :-- | --: | --: | --: | :-- |
| Compile 100 flags | 0.8ms | 3.6ms | 3.6ms | |
| Compile 1,000 flags | 5.5ms | 9.2ms | 9.2ms | 0.4 MB snapshot |
| Compile 10,000 flags | 59.8ms | 89.1ms | 89.1ms | 3.9 MB snapshot |
| `GET /v1/snapshot` (500 flags) | 14.5ms | 19.6ms | 26.4ms | |
| `GET /v1/snapshot` → 304 | 13.7ms | 17.8ms | 24.3ms | |
| `POST /v1/client/state` (200 flags) | 6.6ms | 8.9ms | 11.9ms | |
| Fan-out, 2,000 connections × 20 flags | 47.6ms | 56.9ms | 56.9ms | 15 distinct fingerprints |
| SSE connect, 1,000 streams | 4.1ms | 6.5ms | 11.0ms | **5.4 KB RSS per connection** |
| Analytics ingest, 200-row batch | 0.08ms | 0.18ms | 3.2ms | |

**Read the 304 row first.** It is the same request with no body and no work, and
it costs 13.7ms — so roughly 13–14ms of every HTTP number above is loopback and
`fetch` overhead on this machine, not featurekit. The server-side work in a
500-flag snapshot poll is closer to **1ms**; it was ~6ms before the serialised
snapshot was cached per version, which is a change this harness is what found.

**What the numbers say for planning:**

- **Memory per SSE connection is ~5.4 KB.** 10,000 server connections is
  ~54 MB, which is why `MAX_STREAM_CONNECTIONS` at 10,000 is a sane default for
  a 512 MB container and why 50,000 client connections wants more.
- **Snapshot compilation is the first thing that hurts.** At 10,000 flags it is
  60ms p50 and the snapshot is 3.9 MB — per environment, on every change,
  before it is written to Redis and pushed to every SDK. An environment with
  tens of thousands of flags needs the compile debounce raised and should expect
  propagation in the hundreds of milliseconds rather than under 300ms.
- **Fan-out scales with connections, not with flags.** 2,000 connections and 20
  changed flags is 48ms because only 15 distinct fingerprints existed — the
  §11.5 collapse is doing its job. Per-context flags (rollouts, targets) do not
  collapse, and a snapshot where most flags are per-context is the case to watch.

### The first bottleneck

On this evidence: **snapshot compilation and fan-out at high connection counts,
not evaluation.** Evaluation is 50–177 ns (`docs/evaluation/benchmarks.md`) and
is nowhere near being the limit.

### Not yet measured

- Sustained load over hours (soak), so no statement about leak-free operation.
- Real network latency, TLS, or a load balancer in front.
- 100k+ connections, 10k environments, or 10M-member segments.
- Postgres and Redis under production-sized data.

Do not plan a fleet from this table alone.

