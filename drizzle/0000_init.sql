CREATE TYPE "flag_kind" AS ENUM('boolean', 'string', 'number', 'json');--> statement-breakpoint
CREATE TYPE "sdk_key_kind" AS ENUM('server', 'client', 'mobile');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" varchar NOT NULL,
	"name" varchar,
	"environment_ids" uuid[],
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"actor_id" uuid,
	"actor_kind" varchar NOT NULL,
	"action" varchar NOT NULL,
	"entity_type" varchar NOT NULL,
	"entity_id" uuid,
	"entity_key" varchar,
	"diff" jsonb NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_environment_id" uuid NOT NULL,
	"patch" jsonb NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"reviewed_by" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_kinds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	CONSTRAINT "context_kinds_project_key_uq" UNIQUE("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar NOT NULL,
	"name" varchar NOT NULL,
	"color" varchar,
	"is_production" boolean DEFAULT false NOT NULL,
	"bucket_salt" varchar NOT NULL,
	"event_sample_ratio" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_project_key_uq" UNIQUE("project_id","key"),
	CONSTRAINT "env_project_id_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
-- `evaluation_summaries` is intentionally NOT created here. It is PARTITIONED
-- BY RANGE (bucket_at) and drizzle-kit cannot emit `PARTITION BY`; a plain
-- table here would silently shadow the partitioned one. See 0001_partitioning.sql.
CREATE TABLE "flag_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"off_variation_id" uuid,
	"fallthrough_variation_id" uuid,
	"fallthrough_rollout" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "flag_environments_flag_env_uq" UNIQUE("flag_id","environment_id"),
	CONSTRAINT "fallthrough_xor" CHECK (num_nonnulls("flag_environments"."fallthrough_variation_id", "flag_environments"."fallthrough_rollout") = 1)
);
--> statement-breakpoint
CREATE TABLE "flag_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_environment_id" uuid NOT NULL,
	"variation_id" uuid NOT NULL,
	"context_kind" varchar DEFAULT 'user' NOT NULL,
	"context_key" text NOT NULL,
	CONSTRAINT "flag_targets_fe_kind_key_uq" UNIQUE("flag_environment_id","context_kind","context_key")
);
--> statement-breakpoint
CREATE TABLE "flag_variations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"name" varchar,
	"description" text,
	"value" jsonb NOT NULL,
	CONSTRAINT "flag_variations_flag_idx_uq" UNIQUE("flag_id","idx")
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"kind" "flag_kind" NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"temporary" boolean DEFAULT true NOT NULL,
	"client_available" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_project_key_uq" UNIQUE("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar NOT NULL,
	"name" varchar,
	"role" varchar DEFAULT 'writer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "prerequisites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_environment_id" uuid NOT NULL,
	"prerequisite_flag_id" uuid NOT NULL,
	"required_variation_id" uuid NOT NULL,
	CONSTRAINT "prerequisites_fe_flag_uq" UNIQUE("flag_environment_id","prerequisite_flag_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar NOT NULL,
	"name" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rule_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"context_kind" varchar DEFAULT 'user' NOT NULL,
	"attribute" text NOT NULL,
	"op" varchar NOT NULL,
	"values" jsonb NOT NULL,
	"negate" boolean DEFAULT false NOT NULL,
	CONSTRAINT "rule_clauses_rule_idx_uq" UNIQUE("rule_id","idx")
);
--> statement-breakpoint
CREATE TABLE "scheduled_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_environment_id" uuid NOT NULL,
	"patch" jsonb NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"failed_reason" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sdk_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" "sdk_key_kind" NOT NULL,
	"key_hash" varchar,
	"key_public" varchar,
	"name" varchar,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdk_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "sdk_keys_key_public_unique" UNIQUE("key_public")
);
--> statement-breakpoint
CREATE TABLE "segment_members" (
	"segment_id" uuid NOT NULL,
	"context_kind" varchar DEFAULT 'user' NOT NULL,
	"context_key" text NOT NULL,
	"ordinal" bigint GENERATED ALWAYS AS (CASE WHEN context_key ~ '^(0|[1-9][0-9]{0,8})$' THEN context_key::bigint END) STORED,
	"excluded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "segment_members_segment_id_context_kind_context_key_pk" PRIMARY KEY("segment_id","context_kind","context_key")
);
--> statement-breakpoint
CREATE TABLE "segment_rule_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_rule_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"context_kind" varchar DEFAULT 'user' NOT NULL,
	"attribute" text NOT NULL,
	"op" varchar NOT NULL,
	"values" jsonb NOT NULL,
	"negate" boolean DEFAULT false NOT NULL,
	CONSTRAINT "segment_rule_clauses_rule_idx_uq" UNIQUE("segment_rule_id","idx")
);
--> statement-breakpoint
CREATE TABLE "segment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"weight" integer,
	"bucket_by" text,
	"context_kind" varchar DEFAULT 'user' NOT NULL,
	CONSTRAINT "segment_rules_segment_idx_uq" UNIQUE("segment_id","idx")
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" varchar NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"external" boolean DEFAULT false NOT NULL,
	"member_count" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_env_key_uq" UNIQUE("environment_id","key")
);
--> statement-breakpoint
CREATE TABLE "targeting_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_environment_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"description" text,
	"variation_id" uuid,
	"rollout" jsonb,
	CONSTRAINT "targeting_rules_fe_idx_uq" UNIQUE("flag_environment_id","idx"),
	CONSTRAINT "rule_outcome_xor" CHECK (num_nonnulls("targeting_rules"."variation_id", "targeting_rules"."rollout") = 1)
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_flag_environment_id_flag_environments_id_fk" FOREIGN KEY ("flag_environment_id") REFERENCES "flag_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_kinds" ADD CONSTRAINT "context_kinds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_environments" ADD CONSTRAINT "flag_environments_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_environments" ADD CONSTRAINT "flag_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_environments" ADD CONSTRAINT "flag_environments_off_variation_id_flag_variations_id_fk" FOREIGN KEY ("off_variation_id") REFERENCES "flag_variations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_environments" ADD CONSTRAINT "flag_environments_fallthrough_variation_id_flag_variations_id_fk" FOREIGN KEY ("fallthrough_variation_id") REFERENCES "flag_variations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_targets" ADD CONSTRAINT "flag_targets_flag_environment_id_flag_environments_id_fk" FOREIGN KEY ("flag_environment_id") REFERENCES "flag_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_targets" ADD CONSTRAINT "flag_targets_variation_id_flag_variations_id_fk" FOREIGN KEY ("variation_id") REFERENCES "flag_variations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_variations" ADD CONSTRAINT "flag_variations_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisites" ADD CONSTRAINT "prerequisites_flag_environment_id_flag_environments_id_fk" FOREIGN KEY ("flag_environment_id") REFERENCES "flag_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisites" ADD CONSTRAINT "prerequisites_prerequisite_flag_id_flags_id_fk" FOREIGN KEY ("prerequisite_flag_id") REFERENCES "flags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prerequisites" ADD CONSTRAINT "prerequisites_required_variation_id_flag_variations_id_fk" FOREIGN KEY ("required_variation_id") REFERENCES "flag_variations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_clauses" ADD CONSTRAINT "rule_clauses_rule_id_targeting_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "targeting_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_changes" ADD CONSTRAINT "scheduled_changes_flag_environment_id_flag_environments_id_fk" FOREIGN KEY ("flag_environment_id") REFERENCES "flag_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_keys" ADD CONSTRAINT "sdk_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_rule_clauses" ADD CONSTRAINT "segment_rule_clauses_segment_rule_id_segment_rules_id_fk" FOREIGN KEY ("segment_rule_id") REFERENCES "segment_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_rules" ADD CONSTRAINT "segment_rules_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_env_project_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "environments"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targeting_rules" ADD CONSTRAINT "targeting_rules_flag_environment_id_flag_environments_id_fk" FOREIGN KEY ("flag_environment_id") REFERENCES "flag_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targeting_rules" ADD CONSTRAINT "targeting_rules_variation_id_flag_variations_id_fk" FOREIGN KEY ("variation_id") REFERENCES "flag_variations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_proj_time_idx" ON "audit_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "flag_env_env_idx" ON "flag_environments" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "flag_target_lookup_idx" ON "flag_targets" USING btree ("flag_environment_id","context_kind");--> statement-breakpoint
CREATE INDEX "flag_tag_idx" ON "flags" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "segment_member_ordinal_idx" ON "segment_members" USING btree ("segment_id","context_kind","ordinal") WHERE ordinal IS NOT NULL;