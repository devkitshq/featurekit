-- The audit list filters by flag key (`?flag=`) inside one project, newest
-- first. Without this index that filter walks the project's whole history for
-- a key that rarely or never appears, and the route is open to the reader role.
CREATE INDEX IF NOT EXISTS "audit_proj_entity_key_time_idx"
  ON "audit_log" ("project_id", "entity_key", "created_at" DESC);
