# Change propagation

`src/snapshot/service.ts` · `src/snapshot/postgres-store.ts`

```
PATCH /v1/flags/:key/environments/:env
  -> transaction: write config, bump version, write audit row
  -> recompile snapshot (debounced ~200ms, guarded by fk:lock:snapshot:{envId})
  -> SET fk:snap:{envId}:server, XADD fk:patches:{envId}, PUBLISH fk:chan:{envId}
  -> each API node pushes `patch` to its connections
  -> next evaluation reflects it
```

Target: **p99 under 300ms** from dashboard toggle to the flag flipping in a
production process. That number is the product. A flag system whose kill switch
takes 30 seconds is not a kill switch. `tests/sdk/client.test.ts` asserts the
round trip end to end against a real HTTP server.

## `SnapshotStore` is a plugin

"Plugins are a class with one method." This one owns everything nodes share for
the server tier — snapshot, patch history, change delivery, compile lock.

`MemorySnapshotStore` and `PostgresSnapshotStore` run the **same contract
suite**. A store the tests use and a store production uses that are only tested
separately will diverge, and the tests then mean nothing.

**How the Postgres store works.** The snapshot, patch history, client connection
records and compile locks live in UNLOGGED tables: cheap to write, emptied by a
crash. Each node serves snapshots from its own memory. A change commits the
snapshot, its patches and a `pg_notify` in one transaction, and Postgres only
delivers a notification once its transaction commits, so no node is told about a
version it cannot yet read. Nodes that hear it drop their cached copy and push
the change to their streams. A cached snapshot is also re-validated (one integer,
by primary key) at most every 10 seconds, which bounds how stale a node can be
if its `LISTEN` connection dies without anyone noticing.

**A notification is a hint.** NOTIFY is not authenticated, and any role on the
database can send on the channel. So a node never acts on a payload as given:
it re-reads the version from `snapshot_cache`, and keeps the flag key only when
`snapshot_patches` records that key at that version. A forged notification costs
one primary-key read, and only for an environment the node already holds.

**Nothing in the cache tables is authoritative.** The configuration tables are
truth; every method's failure mode is "recompile from them", which is why the
patch history can be lossy without hedging.

## The version is durable

`environments.snapshot_version`, bumped in the same transaction as a config
change, in a logged table — **not** in the snapshot cache.

The cache is explicitly allowed to be lost. A counter that reset when it was emptied
would make the version go *backwards*, and the SDK's version guard would then
reject every subsequent patch as stale: an environment frozen on its last good
snapshot, with nothing in the logs to say why. That failure is silent, total, and
would take a long time to diagnose.

## Binary-safe serialisation

Segment filters are `Uint8Array`. `JSON.stringify` turns one into
`{"0":1,"1":2,...}` and `JSON.parse` gives back a plain object — a filter that
answers `false` for **every** member. Silent, and only visible weeks later as
"the flag didn't turn on for that customer".

So binary fields are tagged (`$fkBytes`, base64) and revived on read. The SDK
carries a byte-identical codec that hand-rolls its base64, because that file
compiles into browser bundles where `Buffer` does not exist.

## Debounce

Per environment, ~200ms. Editing five rules in a dashboard session is five
PATCHes; recompiling and broadcasting five times means every connected SDK
applies five snapshots for one logical change.

Per *environment* rather than globally, so a busy staging cannot delay a
production kill switch.

A burst touching one flag stays a targeted `patch`; a burst touching several
becomes a full recompile, because a patch naming one of them would leave the
others stale on every connected SDK.

## The compile lock

`withCompileLock` returns `undefined` **without running the work** when the lock
is held. A second compile of the same version is waste, not a queue — the node
that skipped receives the result over pub/sub like everyone else.

Release is compare-and-delete: without the token check, a compile that overran
its TTL would delete a lock another node had since acquired.

The lock is released even when the work throws. A failed compile must not lock an
environment out of every future compile.

## A failed compile leaves the last good snapshot serving

Store first, then history, then publish. A subscriber that reacts to the
broadcast by reading the store must never find the old snapshot under the new
version.

If `loadInput` or the compile throws, nothing is written and the previous
snapshot keeps serving. Stale beats wrong, and both beat empty.

## Resume (§10.3)

`resumeFrom` is the §10.3 table, in one place so the four outcomes cannot be
spelled differently in two implementations:

| `Last-Event-ID` vs history | Action |
| :-- | :-- |
| ≥ oldest retained version | Replay from there, then stream live |
| < oldest retained version | Full `put` — more than `depth` changes were missed |
| History empty | Full `put` — the cache was emptied |
| Ahead of current version | Full `put` — indicates a rolled-back database |

The three `put` cases return `null` from `patchesSince` rather than being
distinguished. The response is identical for each, and a caller that had to tell
them apart would eventually get it wrong.

Retention is **depth, not time**: what matters is how many *changes* were missed,
not how long the SDK was away.
