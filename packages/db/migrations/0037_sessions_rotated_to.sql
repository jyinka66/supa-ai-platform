-- ───────────────────────────────────────────────
-- 0037_sessions_rotated_to.sql
-- Add `rotated_to` column to sessions for v2 reuse detection.
--
-- When a refresh token is rotated, the old session's `rotated_to` is set
-- to the new session's id. If the old token is presented again (reuse),
-- the `rotated_to` field is non-null → the session was already rotated →
-- stolen session → kill the entire family (revoke all sessions for the user).
--
-- This is different from the v1 `rotated_at` timestamp (migration 0032):
--   v1: `rotated_at` = timestamp (reuse = rotated_at IS NOT NULL).
--   v2: `rotated_to` = the new session's id (reuse = rotated_to IS NOT NULL,
--       and we can follow the chain to find the active session).
-- ───────────────────────────────────────────────

alter table sessions
  add column if not exists rotated_to uuid;

-- Self-referential FK (rotated_to → sessions.id). ON DELETE SET NULL
-- (if the new session is deleted, the old one's rotated_to is nullified —
-- the old session was already revoked_at, so this is just cleanup).
alter table sessions
  drop constraint if exists sessions_rotated_to_fkey;
alter table sessions
  add constraint sessions_rotated_to_fkey
  foreign key (rotated_to) references sessions(id) on delete set null;

-- Index for reuse detection: find sessions by rotated_to (follow the chain).
create index if not exists idx_sessions_rotated_to on sessions (rotated_to)
  where rotated_to is not null;
