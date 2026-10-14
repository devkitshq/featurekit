-- What Redis used to hold, in Postgres.
--
-- Every table here is a cache or a lease: losing any of it loses no flag
-- configuration, because the configuration tables are the truth and these are
-- rebuilt from them. So they are UNLOGGED — no write-ahead log, which makes the
-- writes cheap, and a crash empties them, which is exactly the contract Redis
-- had. They are also not replicated to standbys; after a failover they start
-- empty and refill.
--
-- Keys are plain text with no foreign keys: the store treats an environment id
-- as opaque, and a cache must never be able to block a write to the tables it
-- caches.

-- The compiled snapshot per environment, as served to SDKs. Read through each
-- node's memory; a node rereads a row when LISTEN/NOTIFY says it changed.
CREATE UNLOGGED TABLE "snapshot_cache" (
	"environment_id" text PRIMARY KEY,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Recent patches per environment, so a reconnecting SDK is sent what it missed
-- rather than everything. Capped per environment on every write.
CREATE UNLOGGED TABLE "snapshot_patches" (
	"id" bigserial PRIMARY KEY,
	"environment_id" text NOT NULL,
	"version" integer NOT NULL,
	"op" varchar NOT NULL,
	"flag_key" varchar NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "snapshot_patches_env_idx" ON "snapshot_patches" USING btree ("environment_id", "id");
--> statement-breakpoint

-- Client-tier connection handle -> the context it was issued for, so a
-- browser whose POST and stream land on different nodes is taken over rather
-- than refused.
CREATE UNLOGGED TABLE "client_connections" (
	"id" text PRIMARY KEY,
	"record" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_connections_expires_idx" ON "client_connections" USING btree ("expires_at");
--> statement-breakpoint

-- One compile per environment at a time across the fleet. A lease with an
-- expiry rather than an advisory lock, so it works through a transaction-mode
-- pooler and a crashed holder cannot keep it.
CREATE UNLOGGED TABLE "compile_locks" (
	"environment_id" text PRIMARY KEY,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
