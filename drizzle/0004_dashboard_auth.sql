-- Human logins for the dashboard (§7.11, dashboard/PLAN.md §2).
--
-- The management API authenticates a personal access token, which is right for
-- CI and wrong for a person: a token in a browser is a bearer credential with
-- no expiry, no logout and no way to tell two people apart in the audit log.
--
-- Both paths resolve to the same `Principal`, so every role and environment
-- scope check already written applies unchanged, and `audit_log.actor_id` names
-- a member either way.

-- Nullable on purpose: a member who only ever uses a PAT never sets one, and a
-- NOT NULL column would force a fake password on every existing row.
ALTER TABLE members ADD COLUMN IF NOT EXISTS password_hash varchar;

-- Recorded so an operator can answer "when did they last use this account",
-- which is the question that precedes deactivating one.
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Sessions are rows, not signed cookies.
--
-- A stateless JWT cannot be revoked before it expires, and "log this person out
-- now" is the first thing anyone asks for after "someone left the company". The
-- cost is one indexed lookup per request, cached in front of it.
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Only the hash. The plaintext lives in the cookie and nowhere else, so a
  -- database leak does not hand over live sessions.
  token_hash   varchar NOT NULL UNIQUE,
  user_agent   varchar,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

-- Expiry sweeps read this; so does "show me every session for this member"
-- before revoking them.
CREATE INDEX IF NOT EXISTS dashboard_sessions_member_idx
  ON dashboard_sessions (member_id);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expires_idx
  ON dashboard_sessions (expires_at);
