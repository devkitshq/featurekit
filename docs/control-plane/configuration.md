# Configuration

`src/config/index.ts` · §17

**The defaults are for laptops, never for prod.** Development binds to localhost
and points at a local Postgres. Production start fails loudly.

## Production hard-fails

Missing `DATABASE_URL` or `ADMIN_TOKEN` under `NODE_ENV=production`
is a startup error, not a warning — the development defaults must never silently
apply. A control plane pointed at a localhost database is a control plane with no
data, and it will look healthy.

**Every missing variable is named at once.** Three restarts to discover three
missing variables is three outages.

`SECURE_MODE_SECRET` is required only once a client key exists. A
server-tier-only deployment should not be forced to configure a secret it cannot
use, and demanding one would train operators to set a dummy value.

## Database schema

`DATABASE_SCHEMA` (or `databaseSchema` on `FeaturekitServer`) names the one
Postgres schema featurekit owns: every table, enum type, function, analytics
partition, and Drizzle's migration history. It defaults to `public`, and the
migrations create it if it does not exist. Several installs can share a
database in different schemas without seeing each other.

It must be a lowercase identifier (letters, digits, underscores) not starting
with `pg_`, so it never needs quoting.

The schema is applied as each connection's `search_path`, with nothing else on
the path. A table missing from the schema is an error, never a silent read from
`public`.

**Behind pgbouncer**, a `search_path` sent at connect time may be dropped or
refused. Set it on the database role instead:

```sql
ALTER ROLE featurekit SET search_path = featurekit;
```

`FeaturekitServer` checks at startup that its connections really are in the
configured schema and that it is migrated, and refuses to start otherwise with
an error naming the cause. A bare `createApp` still boots and reports it through
`/ready` (`schema missing`, `schema unmigrated` or `schema mismatch`).

## Behind pgbouncer

Nodes tell each other about changes with Postgres `LISTEN/NOTIFY`. `LISTEN`
needs a session that stays on one server connection, which pgbouncer in
transaction mode cannot give. Everything else works through it. Set
`DATABASE_LISTEN_URL` to a direct Postgres address and featurekit opens its one
listening connection per node there, while every query keeps going through
`DATABASE_URL`.

## Rate limits are per node

Each node counts requests in its own memory; there is no shared counter that an
outage could turn off. Behind a load balancer spreading traffic over N nodes, a
caller can reach up to N times a `RATE_LIMIT_*` value in total, so set them per
node.

## Secret rotation without a flag day

```
SECURE_MODE_SECRET=new_secret,old_secret
```

Signing uses the first; verification tries all. Rotation is two ordinary
deploys: add the new secret second, deploy; promote it to first, deploy. Drop the
old one on a third.

## Validation

`SEGMENT_CUCKOO_FINGERPRINT_BITS` accepts only 12 or 16, because the cuckoo wire
format is frozen (§9.7). Any other value would produce filters no other SDK can
read.

`ROLLUP_PARTITION_PREMAKE_DAYS` has a floor of 2, matching the runway alert: a
premake below the alert threshold means the alert fires immediately and forever.

## What is deliberately not read at runtime

`ROLLUP_RETENTION_DAYS` is written into `partman.part_config` at migration time
(§7.9). Nothing re-reads it every night, because nothing in Node owns partition
lifecycle.
