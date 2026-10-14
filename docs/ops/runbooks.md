# Runbooks

Written for the person who was asleep twenty minutes ago. Every entry states
what the system does on its own first, because in most of these the correct
first action is *nothing*, and knowing that is the difference between a
five-minute incident and an hour of well-intentioned damage.

The single most important fact, and the one to keep in mind in every runbook
below:

> **A control plane outage does not turn flags off.** Server SDKs evaluate from
> an in-memory snapshot and keep serving the last known good configuration.
> Restarted SDK processes fall back to their persisted snapshot, then to their
> bootstrap, then to the caller's default. Nothing on the evaluation path calls
> the control plane.

---

## Streaming SDKs miss changes that polling SDKs see

**What it looks like.** A change saves and the dashboard shows it, but streaming
SDKs keep the old value; SDKs that poll or reconnect get the new one. If no SDK
sees it, see [snapshot age is climbing](#snapshot-age-is-climbing--changes-are-not-reaching-sdks)
instead: that is a compile failure, not delivery.

**Why it happens.** Nodes learn about changes through Postgres `LISTEN/NOTIFY`.
A node whose listening connection is down hears nothing, so its open streams are
not pushed the change. Its own reads still catch up within 10 seconds, because a
cached snapshot is re-validated against the database on that interval.

**Do.**

1. Behind pgbouncer in transaction mode, `LISTEN` cannot work through it. Set
   `DATABASE_LISTEN_URL` to a direct Postgres address.
2. Look for `snapshot store error` in the logs. The listener reconnects on its
   own after a database restart or network blip, and catches its streams up when
   it does.
3. If one node is stuck, restarting it re-establishes the listener; its SDKs
   reconnect and receive the current snapshot.

---

## The cache tables have been emptied

**What it looks like.** Nothing, usually. The cache tables are UNLOGGED, so a
Postgres crash or a failover to a replica empties them.

**What the system does.** Every row is rebuildable. The first request per
environment recompiles from the configuration tables under the compile lock and
writes the result back. Streaming SDKs that reconnect get a full snapshot rather
than a resume, which is correct.

**Watch for.** A recompile burst if this coincides with a deploy: many cold
nodes, no cached snapshots. The compile lock and the single-flight guard bound
this to one compile per environment at a time.

**Do.** Nothing, unless snapshot compile duration is above a few seconds — in
which case pre-warm by hitting `/v1/snapshot/:env` once per environment before
shifting traffic.

---

## Postgres is down

**What the system does.** SDKs keep serving. The control plane keeps serving any
snapshot already in its memory. `/ready` fails, so nodes leave the load
balancer — correct here, because a node that can neither read config nor accept
a change has nothing useful to add.

**What is lost.** All writes. No flag changes, no kill switches through the API,
no new SDK keys. Analytics buffers in memory and is dropped past
`EVENT_BUFFER_MAX` (counted in `featurekit_events_dropped_total`).

**If a flag must be turned off while Postgres is down.** The management API
cannot help. Options, in order of preference:

1. If the SDKs still hold a good snapshot and the flag must be off *for one
   service*, use that service's own kill mechanism (its bootstrap snapshot, or
   its caller default).
2. Restore Postgres. Everything else is worse.

---

## Snapshot age is climbing / changes are not reaching SDKs

**Alert.** `featurekit_snapshot_age_seconds` above ~5 minutes for an environment
that is being changed, or `featurekit_snapshot_compile_failures_total` rising.

**Diagnose, in order.**

1. `curl -s $HOST/health | jq .snapshotAgeSeconds` — is it one environment or
   all of them?
2. Compile failures in the logs: `"snapshot pipeline error"`. A compile that
   throws leaves the previous snapshot serving, so the symptom is silence, not
   an error at the SDK.
3. The usual cause is a configuration that will not compile — most often a
   prerequisite cycle or a rule referencing a variation that no longer exists.
   The management API rejects both at write time, so this points at data
   changed outside the API.

**Recover.** Fix the configuration, then force propagation with any write to
that flag (a no-op PATCH with the current version is enough).

---

## Partition runway below two days

**Alert.** `featurekit_partition_runway_days < 2`. Readiness also fails, which
is intentional: this is the failure that otherwise appears as total analytics
ingest failure at midnight with no warning.

**Cause.** `pg_partman` maintenance has stopped running — usually `pg_cron` is
not installed, is disabled, or the job is erroring.

**Recover now (safe, idempotent):**

```sql
SELECT featurekit_ensure_partitions(7);
```

**Then fix the cause:**

```sql
SELECT * FROM cron.job;                         -- is partman-maintenance there?
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
CALL partman.run_maintenance_proc();            -- run it by hand, watch for errors
```

**Never** create a DEFAULT partition as a workaround. One row in DEFAULT within
a range a future partition would cover makes `CREATE TABLE ... PARTITION OF`
fail permanently, and recovery is a manual detach/relocate/reattach under an
exclusive lock on the busiest table in the system.

---

## Rollup backlog / analytics not appearing

**Alert.** `featurekit_rollup_lag_seconds` climbing, or
`featurekit_rollup_dlq_total` rising.

**Triage by reason label:**

| Reason | Meaning | Action |
| :-- | :-- | :-- |
| `missing_partition` | Partition maintenance stopped | Runbook above |
| `write_failed` | Postgres rejecting or unavailable | Check Postgres |
| `buffer_full` | Ingest outrunning the drain | Expected under load spikes; if sustained, raise `EVENT_BUFFER_MAX` or shorten `EVENT_FLUSH_INTERVAL_MS` |

**Remember what this is not.** Analytics loss is an accepted trade (§14). No
part of this affects evaluation correctness, and no action here should involve
restarting nodes that are serving flags correctly.

---

## SSE connections saturated

**Alert.** `featurekit_stream_connections{tier="server"}` approaching
`MAX_STREAM_CONNECTIONS`, or `featurekit_stream_rejections_total` rising.

**What the system does.** Above the cap it returns 503 with a message telling
the SDK to fall back to polling, and the SDK takes the hint. The tier degrades
on a curve rather than a cliff.

**Do.** Add nodes. The cap is per node; connections rebalance as SDKs reconnect.

---

## Reconnect storm after an outage

**Symptom.** A spike of connection attempts, some rate-limited, after the
control plane or the network recovers.

**What the system does.** SDK reconnects are jittered; a graceful shutdown sends
each stream a `reconnect` event with an individual delay so a rolling deploy
returns as a ramp. The stream rate limit is per identity and bounds the rest.

**Do.** Let it drain. If a node is unhealthy under the load, remove it from the
load balancer — the SDKs it drops will spread across the others.

---

## SDK key compromised

1. Revoke it: `DELETE /v1/admin/projects/:project/environments/:env/keys/:keyId`.
2. Revocation is effective within `SDK_KEY_CACHE_TTL_MS` (default 30s) on every
   node, and immediately on the node that processed the revoke. The revoked row
   is kept, not deleted — the audit log references it.
3. Mint a replacement and roll it out. Server keys are shown once.
4. Check the audit log for anything the key's environment saw:
   `GET /v1/admin/projects/:project/audit`.

A leaked **client** key is not an incident by itself — client keys are public by
construction and buy only evaluated values for a context the holder can prove.
A leaked **server** key is: it grants the full ruleset.

---

## Secure-mode secret rotation

Two ordinary deploys, no flag day:

1. Set `SECURE_MODE_SECRET=<new>,<old>` and deploy. Signing uses the first,
   verification tries all — so both old and new signatures verify.
2. Once every signer is issuing with the new secret, set
   `SECURE_MODE_SECRET=<new>` and deploy again.

Rotating in one step invalidates every outstanding signature simultaneously, and
every browser drops to caller defaults until it re-identifies.

---

## Bad control-plane deploy

**The property to rely on.** A bad deploy cannot make every SDK lose a valid
configuration: SDKs hold their snapshot in memory and do not re-fetch to keep
serving. The worst case is that changes stop propagating.

1. Roll back the deployment. Migrations are forward-only (see
   `docs/ops/deployment.md`); a rollback of code is safe, a rollback of schema
   is not, which is why migrations are additive.
2. Verify: `/ready` healthy, `featurekit_snapshot_age_seconds` falling.
3. Verify propagation end to end with a no-op change on a test flag.

---

## Restoring a flag configuration someone broke

Every mutation writes an audit row with the full before and after.

1. Find it: `GET /v1/admin/projects/:project/audit?flag=<key>`.
2. Revert:
   `POST /v1/admin/projects/:project/environments/:env/flags/:flag/revert`
   with `{"auditId": "..."}`.

The revert replays through the same validation and version check as any other
write, and is itself audited as `flag.reverted`.
