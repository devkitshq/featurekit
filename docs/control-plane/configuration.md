# Configuration

`src/config/index.ts` · §17

**The defaults are for laptops, never for prod.** Development binds to localhost
and points at a local Postgres and Redis. Production start fails loudly.

## Production hard-fails

Missing `DATABASE_URL`, `REDIS_URL` or `ADMIN_TOKEN` under `NODE_ENV=production`
is a startup error, not a warning — the development defaults must never silently
apply. A control plane pointed at a localhost database is a control plane with no
data, and it will look healthy.

**Every missing variable is named at once.** Three restarts to discover three
missing variables is three outages.

`SECURE_MODE_SECRET` is required only once a client key exists. A
server-tier-only deployment should not be forced to configure a secret it cannot
use, and demanding one would train operators to set a dummy value.

## Secret rotation without a flag day

```
SECURE_MODE_SECRET=new_secret,old_secret
```

Signing uses the first; verification tries all. Rotation is two ordinary
deploys: add the new secret second, deploy; promote it to first, deploy. Drop the
old one on a third.

## Cross-field validation

`SEGMENT_CUCKOO_PATCH_CEILING` must exceed `SEGMENT_CUCKOO_LOAD_FACTOR`. A
ceiling below the sizing target would refuse every segment patch the moment the
filter was built — a configuration that is individually valid on both fields and
useless together.

`SEGMENT_CUCKOO_FINGERPRINT_BITS` accepts only 12 or 16, because the cuckoo wire
format is frozen (§9.7). Any other value would produce filters no other SDK can
read.

`ROLLUP_PARTITION_PREMAKE_DAYS` has a floor of 2, matching the runway alert: a
premake below the alert threshold means the alert fires immediately and forever.

## What is deliberately not read at runtime

`ROLLUP_RETENTION_DAYS` is written into `partman.part_config` at migration time
(§7.9). Nothing re-reads it every night, because nothing in Node owns partition
lifecycle.
