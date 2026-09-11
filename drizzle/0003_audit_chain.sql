-- Tamper evidence for the audit log (§7.10, review PR-E7).
--
-- The audit log is the answer to "who turned this on at 14:02", which makes it
-- the first thing worth editing by anyone who would rather that answer were
-- different. Rows are already append-only by convention; this makes an edit
-- *detectable* rather than merely discouraged.
--
-- Each row carries the hash of the previous row in its project's chain, so
-- altering or deleting any row breaks every hash after it. That is not
-- prevention — a determined operator with UPDATE on the table can recompute the
-- whole chain — and it is not meant to be. It converts silent tampering into
-- tampering that requires deliberate effort and leaves a verifiable trail,
-- which is the honest thing a single-database audit log can offer.
--
-- Nullable, and verification tolerates nulls: existing rows predate the chain
-- and there is nothing to gain by refusing to read them.

-- A total order over the log.
--
-- `created_at` is NOT one: it defaults to `now()`, which in Postgres is
-- transaction-start time, so every row written inside one transaction shares a
-- timestamp and rows from transactions starting in the same microsecond tie.
-- A chain needs "the row before this one" to have exactly one answer, and with
-- ties the writer and the verifier can disagree about which row that was — the
-- chain then fails to verify on a log nobody touched.
ALTER TABLE "audit_log" ADD COLUMN "seq" bigserial NOT NULL;
--> statement-breakpoint

ALTER TABLE "audit_log" ADD COLUMN "prev_hash" varchar;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entry_hash" varchar;
--> statement-breakpoint

-- Finding the chain head is a per-project lookup on every write, so it gets an
-- index. Without it, an audit log with a million rows makes every flag change
-- pay a sequential scan.
CREATE INDEX "audit_chain_head_idx" ON "audit_log" USING btree ("project_id", "seq" DESC);
