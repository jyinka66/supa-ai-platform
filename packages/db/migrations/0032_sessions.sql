-- ───────────────────────────────────────────────
-- 0032_sessions.sql
-- Session security + device management.
--
-- Sessions: one row per active session (web/mobile/SSO). The session id (jti)
-- is the JWT id. The refresh token is stored as a hash (never the raw token).
--
-- Refresh token rotation with reuse detection:
--   - Each session belongs to a "family" (identified by family_id).
--   - On refresh, the old refresh token is rotated (rotated_at set) + a new
--     refresh token is issued (same family).
--   - If a ROTATED refresh token is presented again (replay), the ENTIRE
--     family is revoked (all sessions in the family nuked). This is the
--     "reuse detection" defense: an attacker who stole a refresh token + used
--     it gets caught when the legitimate user presents the now-rotated token.
--
-- Device management:
--   - device_hash: a fingerprint of the user agent + IP + accepting language.
--     Used for the device list UI ("Chrome on macOS from 1.2.3.4").
--   - last_seen_at: updated on each request (idle timeout check).
--   - Self-service revoke: user can list + revoke individual sessions or all.
-- ───────────────────────────────────────────────

create table sessions (
  id uuid primary key default gen_random_uuid(),  -- the jti (JWT id)
  user_id uuid not null,  -- FK to auth.users added below
  kind text not null check (kind in ('web', 'mobile', 'sso')),
  ip inet,
  user_agent text,
  device_hash text,  -- fingerprint of UA + IP + language
  family_id uuid not null default gen_random_uuid(),  -- refresh token family
  refresh_token_hash text,  -- sha256 of the current refresh token (null if rotated)
  rotated_at timestamptz,  -- set when the refresh token is rotated (replay = reuse)
  revoked_at timestamptz,  -- set when the session is revoked
  expires_at timestamptz not null,
  sso_originated boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- FK to auth.users.
alter table sessions
  add constraint sessions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Indexes.
create index on sessions (user_id, revoked_at);
create index on sessions (user_id, kind, last_seen_at desc);
create index on sessions (family_id);  -- for reuse detection (nuke family).
create index on sessions (refresh_token_hash) where refresh_token_hash is not null;
create index on sessions (expires_at) where revoked_at is null;  -- for TTL cleanup.

alter table sessions enable row level security;
-- Sessions are user-scoped (not workspace-scoped) — the user can see their own
-- sessions across all workspaces. RLS: user_id = auth.uid().
create policy sessions_self on sessions
  for all using (user_id = auth.uid());

comment on table sessions is
  'Session security + device management. Refresh token rotation with reuse detection: a reused (rotated) refresh token nukes the entire family.';
