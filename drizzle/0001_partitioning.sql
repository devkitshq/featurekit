-- Evaluation analytics: partitioned from day one (§7.9).
--
-- This is the ONLY high-volume table in the system, which means it is also the
-- only one that will hurt if it is wrong. It is partitioned and single-writer
-- from the first migration rather than retrofitted while on fire.
--
-- Drizzle cannot emit `PARTITION BY`, so this migration is the authority for
-- the DDL. `src/db/schema.ts` describes the shape for type-safe reads only.
--
-- Postgres requires every unique constraint on a partitioned table to include
-- the partition key. `bucket_at` is in the primary key already -- that is a
-- requirement being satisfied, not a coincidence, and it must survive edits.

CREATE TABLE "evaluation_summaries" (
	"environment_id" uuid NOT NULL,
	"flag_key" varchar NOT NULL,
	"variation_idx" integer,
	"reason" varchar NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"count" bigint NOT NULL,
	"unique_sketch" bytea,
	CONSTRAINT "evaluation_summaries_pk"
		PRIMARY KEY ("environment_id", "flag_key", "variation_idx", "reason", "bucket_at")
) PARTITION BY RANGE ("bucket_at");
--> statement-breakpoint

CREATE INDEX "eval_summary_time_idx"
	ON "evaluation_summaries" USING btree ("environment_id", "bucket_at");
--> statement-breakpoint

-- The FK that `src/db/schema.ts` documents but cannot declare: `members` is
-- defined further down that file than `flag_environments`, and a forward
-- `references()` callback is resolved eagerly enough by drizzle to hit the
-- temporal dead zone. Declaring it here keeps the §7 reading order intact.
ALTER TABLE "flag_environments"
	ADD CONSTRAINT "flag_environments_updated_by_members_id_fk"
	FOREIGN KEY ("updated_by") REFERENCES "members"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "scheduled_changes"
	ADD CONSTRAINT "scheduled_changes_created_by_members_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "members"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "change_requests"
	ADD CONSTRAINT "change_requests_requested_by_members_id_fk"
	FOREIGN KEY ("requested_by") REFERENCES "members"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "change_requests"
	ADD CONSTRAINT "change_requests_reviewed_by_members_id_fk"
	FOREIGN KEY ("reviewed_by") REFERENCES "members"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Partition lifecycle belongs to the DATABASE, not to the application.
--
-- Dropping a partition is a catalog operation while deleting 400M rows is not,
-- so the mechanism was never in question -- the *owner* was. An in-house Node
-- scheduler that creates tomorrow's partition is a single point of failure with
-- three well-known ways to fail: two schedulers racing on CREATE TABLE during a
-- rolling deploy, a DST shift putting the boundary an hour off, and -- the one
-- that actually bites -- the worker being down at midnight, so the next insert
-- has no partition to land in and the entire ingest path starts throwing.
--
-- `p_premake => 7` is the part that matters: maintenance can miss a week of
-- runs and inserts still land.
--
-- *** NO DEFAULT PARTITION. EVER. ***
-- The instinct here is a catch-all so a late row always has somewhere to land.
-- It converts a loud failure into a silent trap: once a single row sits in
-- DEFAULT within a range a future partition will cover, CREATE TABLE ...
-- PARTITION OF ... FOR VALUES FROM ... TO ... *errors out* -- Postgres must
-- scan DEFAULT and cannot move rows that would now belong elsewhere. Partition
-- creation stops, pg_partman maintenance fails on every run, and it fails
-- against a table still happily accepting inserts. Nothing looks wrong until
-- someone tries to drop old data and finds a year of rows in one heap.
-- Recovery is a manual detach/relocate/reattach under an exclusive lock on the
-- busiest table in the system.
--
-- The alternative is already specified: 7 days of runway, and
-- `togglekit_partition_runway_days` pages when it drops below two.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman') THEN
		BEGIN
			CREATE SCHEMA IF NOT EXISTS partman;
			CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;

			PERFORM partman.create_parent(
				p_parent_table => 'public.evaluation_summaries',
				p_control      => 'bucket_at',
				p_interval     => '1 day',
				p_premake      => 7
			);

			UPDATE partman.part_config
			   SET retention                = '90 days',
			       retention_keep_table     = false,
			       infinite_time_partitions = true
			 WHERE parent_table = 'public.evaluation_summaries';

			IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
				BEGIN
					CREATE EXTENSION IF NOT EXISTS pg_cron;
					PERFORM cron.schedule(
						'partman-maintenance', '@hourly', $cron$CALL partman.run_maintenance_proc()$cron$
					);
				EXCEPTION WHEN OTHERS THEN
					RAISE WARNING 'togglekit: pg_cron could not be enabled in this database (%). Relying on external scheduler or togglekit_ensure_partitions().', SQLERRM;
				END;
			ELSE
				RAISE WARNING
					'togglekit: pg_partman installed but pg_cron is not. Schedule partman.run_maintenance_proc() externally.';
			END IF;
		EXCEPTION WHEN OTHERS THEN
			RAISE WARNING 'togglekit: pg_partman could not be configured (%). Falling back to togglekit_ensure_partitions().', SQLERRM;
		END;
	ELSE
		-- Fallback for managed Postgres with a locked extension allow-list.
		-- The rule is unchanged and is the actual decision: TABLE LIFECYCLE
		-- NEVER RUNS INSIDE THE NODE PROCESS. Whatever scheduler the operator
		-- already runs calls togglekit_ensure_partitions() instead.
		RAISE WARNING
			'togglekit: pg_partman unavailable. Falling back to togglekit_ensure_partitions(); schedule it externally at least daily.';
	END IF;
END
$$;
--> statement-breakpoint

-- Idempotent declarative partition creation, for the no-extensions fallback and
-- as a manual recovery tool. Safe to call concurrently and repeatedly.
CREATE OR REPLACE FUNCTION togglekit_ensure_partitions(days_ahead integer DEFAULT 7)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	day date;
	created integer := 0;
	part_name text;
BEGIN
	FOR i IN 0..days_ahead LOOP
		day := (CURRENT_DATE + i);
		part_name := format('evaluation_summaries_p%s', to_char(day, 'YYYYMMDD'));
		IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
			EXECUTE format(
				'CREATE TABLE IF NOT EXISTS %I PARTITION OF evaluation_summaries FOR VALUES FROM (%L) TO (%L)',
				part_name, day, day + 1
			);
			created := created + 1;
		END IF;
	END LOOP;
	RETURN created;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION togglekit_ensure_partitions(days_ahead integer DEFAULT 7)
RETURNS integer LANGUAGE sql AS $$
	SELECT togglekit_ensure_partitions(days_ahead);
$$;
--> statement-breakpoint

-- How many days of partition runway remain. The application's ONE contribution
-- to partition lifecycle: fail readiness loudly when this drops below two, so a
-- silent misconfiguration becomes a page instead of an outage at midnight.
-- Backs `togglekit_partition_runway_days` (§15).
CREATE OR REPLACE FUNCTION togglekit_partition_runway_days()
RETURNS integer LANGUAGE sql STABLE AS $$
	SELECT COALESCE(
		MAX(
			(regexp_replace(c.relname, '^.*_p?(\d{8})$', '\1'))::date - CURRENT_DATE
		),
		-1
	)
	FROM pg_class c
	JOIN pg_inherits i ON i.inhrelid = c.oid
	JOIN pg_class p ON p.oid = i.inhparent
	WHERE p.relname = 'evaluation_summaries'
	  AND c.relname ~ '\d{8}$';
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION togglekit_partition_runway_days()
RETURNS integer LANGUAGE sql STABLE AS $$
	SELECT togglekit_partition_runway_days();
$$;
--> statement-breakpoint

-- Ensure the first week exists regardless of which path above was taken.
SELECT togglekit_ensure_partitions(7);
