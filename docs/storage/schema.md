# The schema

`src/db/schema.ts` · `drizzle/` · §7

The schema *is* the design, so it is written out concretely rather than derived.

## The shape that matters most

**`flags` and `flag_environments` are separate tables.** A flag exists once at
the project level; its *configuration* exists once per environment. Environments
are siblings, not a hierarchy. This is the thing every home-grown flag system
gets wrong first, and retrofitting it means rewriting every read path.

**Variations are a table, not a `jsonb` array.** Rules reference a specific
variation. With an array you get bare integer indices with no referential
integrity, and reordering silently rewrites every rule in the project.

## Constraints the database enforces, not the application

| Constraint | What it stops |
| :-- | :-- |
| `fallthrough_xor` | A flag-environment with both a fallthrough variation and a rollout, or neither |
| `rule_outcome_xor` | A rule with both a variation and a rollout, or neither |
| `segments_env_project_fk` | A segment whose `projectId` disagrees with its environment's |
| `prerequisites` `ON DELETE RESTRICT` | Deleting a flag another flag depends on |
| `segment_members.ordinal` generated | An ordinal nobody can reproduce from the key |

All five are asserted from the application side in
`tests/integration/schema.test.ts`, which needs a real Postgres — a check
constraint that exists only in a migration file is a check constraint nobody has
run.

## The ordinal column

```sql
CASE WHEN context_key ~ '^(0|[1-9][0-9]{0,8})$' THEN context_key::bigint END
```

This is the roaring-bitmap eligibility test (§9.7), and it **must agree with the
SDK's `ordinalOf`**. If the database said `"07"` was integral and the SDK said it
was not, the compiler could pick roaring for a segment the SDK then answers
`false` for — a customer who is in the segment and does not get the flag, visible
weeks later.

§7.6 writes the pattern as `^[0-9]{1,9}$`, which admits `"07"`. That is corrected
here: `"07"` and `"7"` are distinct context keys but the same integer, so a
bitmap would answer identically for both and membership would depend on how an
id happened to be formatted. The compiler calls the SDK's own `ordinalOf` rather
than re-implementing the test, so the two cannot drift.

## The partitioned table

`evaluation_summaries` is the only high-volume table, which means it is also the
only one that will hurt if it is wrong. It is partitioned and single-writer from
the first migration rather than retrofitted while on fire.

**drizzle-kit cannot emit `PARTITION BY`.** It generated a plain `CREATE TABLE`
for this table, which would have silently shadowed the partitioned one — the
application would have worked, and the retention story would simply not have
existed. That statement is stripped from `0000_init.sql`, and
`0001_partitioning.sql` is the authority for this table's DDL.

**Partition lifecycle belongs to the database, not the application.**
`pg_partman` under `pg_cron`, with seven days of premake. An in-house Node worker
fails three well-known ways: two schedulers racing on `CREATE TABLE` during a
rolling deploy, a DST shift moving the boundary, and — the one that actually
bites — the worker being down at midnight so the next insert has nowhere to land.

**No `DEFAULT` partition. Ever.** It converts a loud failure into a silent trap:
one row in it and future partition creation errors out permanently, against a
table that is still happily accepting inserts. Asserted absent in the integration
suite.

For managed Postgres with a locked extension allow-list,
`featurekit_ensure_partitions(days_ahead)` is idempotent declarative DDL an
external scheduler can call. The rule is unchanged and is the actual decision:
**table lifecycle never runs inside the Node process.** The application's one job
is `featurekit_partition_runway_days()`, which backs a readiness check that pages
when runway drops below two days.

## Migrations

```
0000_init.sql              every table except evaluation_summaries
0001_partitioning.sql      the partitioned DDL, pg_partman/pg_cron, helper
                           functions, and the member FKs drizzle could not declare
0002_snapshot_version.sql  environments.snapshot_version
```

`0001` also adds the `members(id)` foreign keys for
`flag_environments.updated_by`, `scheduled_changes.created_by` and
`change_requests.requested_by` / `reviewed_by`: `members` is declared later in
`schema.ts` than the tables that reference it, and a forward `references()`
callback hits the temporal dead zone. Declaring them in SQL keeps the §7 reading
order intact.
