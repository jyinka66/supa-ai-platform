-- ───────────────────────────────────────────────
-- 0036_sessions_v2.sql
-- Sessions v2 — opaque server-side sessions for refresh, stateless JWT (15 min)
-- for API calls. Revocation is instant at the refresh layer; JWTs die fast.
--
-- Design decision: opaque server-side sessions for refresh, stateless JWT
-- (15 min) for API calls. Revocation is instant at the refresh layer; JWTs
-- die fast (15 min max — the JWT is short-lived; the refresh token is the
-- long-lived credential that can be revoked instantly).
--
-- This migration EXTENDS the existing `sessions` table (migration 0032):
--   - `token_hash` (argon2id of the refresh token — the spec calls for this;
--      migration 0032 had `refresh_token_hash` which was SHA-256).
--   - `idle_expires_at` (rolling 14-day idle timeout — the spec calls for this;
--      migration 0032 had only `expires_at` which was the absolute cap).
--   - `device_label` (human-readable device label for the device list UI).
--   - `mfa_satisfied` (whether MFA was satisfied for this session).
--   - `revoked_reason` (why the session was revoked — for audit + UI).
--
-- The existing columns from migration 0032 (family_id, rotated_at, etc.)
-- are kept for backward compat with the refresh token rotation + reuse
-- detection logic.
--
-- NOT a tenant table (user-scoped, spans workspaces) — no ws_id, no RLS ws
-- policy. Access control: the app queries by session (token_hash lookup),
-- not by user. The RLS policy is `user_id = auth.uid()` (the user can only
-- see/modify their own sessions).
-- ───────────────────────────────────────────────

-- Add the new columns (idempotent — IF NOT EXISTS).
alter table sessions
  add column if not exists token_hash text unique,
  add column if not exists idle_expires_at timestamptz not null default now() + interval '14 days',
  add column if not exists device_label text,
  add column if not exists mfa_satisfied boolean not null default false,
  add column if not exists revoked_reason text;

-- Migrate existing data: copy `refresh_token_hash` to `token_hash` (same
-- semantics — the hash of the refresh token, just a different name per the spec).
-- The old `refresh_token_hash` was SHA-256; the new `token_hash` should be
-- argon2id. The migration copies the old SHA-256 hashes (they're still valid
-- for verification — the app layer checks the format). New sessions use argon2id.
update sessions set token_hash = refresh_token_hash where token_hash is null and refresh_token_hash is not null;

-- Add the constraint: `idle_expires_at` must be <= `expires_at` (idle can't
-- exceed the absolute cap).
alter table sessions
  drop constraint if exists sessions_idle_within_absolute;
alter table sessions
  add constraint sessions_idle_within_absolute
  check (idle_expires_at <= expires_at);

-- Index for the token_hash lookup (the auth hot path — O(1) per refresh).
-- The unique constraint already creates an index, but we add a partial one
-- for active (non-revoked) tokens — the hot path only looks up active tokens.
create index if not exists idx_sessions_token_hash_active
  on sessions (token_hash)
  where revoked_at is null and token_hash is not null;

-- Index for idle timeout cleanup (find sessions past their idle_expires_at).
create index if not exists idx_sessions_idle_expires
  on sessions (idle_expires_at)
  where revoked_at is null;

-- Index for absolute expiry cleanup (find sessions past their expires_at).
create index if not exists idx_sessions_expires
  on sessions (expires_at)
  where revoked_at is null;

comment on table sessions is
  'Sessions v2 — opaque server-side sessions for refresh, stateless JWT (15 min) for API calls. Revocation is instant at the refresh layer; JWTs die fast. NOT a tenant table (user-scoped).';
