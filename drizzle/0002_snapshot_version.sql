-- Monotonic per-environment snapshot version (§10.4).
--
-- In Postgres rather than a Redis counter because Redis is explicitly allowed
-- to be lost (§8). A counter that reset on a Redis restart would make the
-- version go backwards, and the SDK's version guard would then reject every
-- subsequent patch as stale -- an environment frozen on its last good snapshot,
-- with nothing in the logs to say why.
ALTER TABLE "environments" ADD COLUMN "snapshot_version" integer DEFAULT 1 NOT NULL;
