-- ───────────────────────────────────────────────
-- 0047_admin.sql
-- Admin identity & auth — the control plane floor.
--
-- Separate app, separate domain, separate auth. Admin sessions share NOTHING
-- with product sessions: separate token, separate cookie, separate expiry,
-- separate auth middleware. A product session compromise grants ZERO admin
-- surface (no is_admin boolean on users, no shared session table, no role
-- escalation path from product → admin).
--
-- The admin identity links to product identity ONLY for authentication
-- (the user logs in via the product auth, then steps up to admin auth via
-- MFA). The admin_users row is the single source of truth for "is this user
-- an admin" — the product users table gains NO is_admin column.
--
-- ── Fixes from the pasted spec ──
-- 1. `references users(id)` → `references auth.users(id)` — the codebase
--    pattern (migration 0003): user identity lives in Supabase's auth schema,
--    not a public `users` table. Drizzle can't reference auth schema, so
--    the FK is added via raw SQL.
-- 2. `mfa_secret text not null` → `mfa_secret text` (nullable). The spec
--    had mfa_secret NOT NULL but mfa_enrolled defaults false — you can't
--    create the row (invite) without a secret you don't have yet. Fixed:
--    nullable + CHECK `mfa_enrolled = true IMPLIES mfa_secret IS NOT NULL`.
-- 3. Added CHECK `idle_expires_at <= expires_at` on admin_sessions (the spec
--    comments "hard cap 8h, 30min idle" but didn't enforce the relationship).
-- 4. Added indexes on admin_sessions(admin_id) + (expires_at) — for the
--    session lookup hot path + the reaper cron.
-- 5. `invited_by uuid` → FK to admin_users(user_id) (only an existing admin
--    can invite). Self-reference is fine in SQL.
-- 6. Did NOT create `is_admin_guard` — the spec's `create table is_admin_guard
--    as select 1 where false` is a design NOTE ("no — the flag lives on
--    admin_users"), not real DDL. Creating it would be a bug.
-- 7. `token_hash` is argon2id of the session token (same pattern as
--    sessions.token_hash migration 0036 — the spec didn't specify, but the
--    codebase baseline is argon2id for all bearer tokens). Documented in
--    the comment; the service layer enforces.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- admin_users — the admin identity (single source of truth for "is admin")
-- ───────────────────────────────────────────────

create table admin_users (
  user_id          uuid primary key,
  role             text not null check (role in ('owner','senior','standard','support','read_only')),
  mfa_secret       text,                        -- TOTP seed, KMS-encrypted at rest (nullable until enrolled).
  mfa_enrolled     boolean not null default false,
  hardware_key     jsonb,                       -- optional WebAuthn credential.
  ip_allowlist     text[],                      -- null OR empty = deny all (default deny). Non-empty = allowlist.
  invited_by       uuid,                        -- FK to admin_users(user_id) — only an admin can invite.
  invited_at       timestamptz,
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  quarterly_reviewed_at timestamptz,
  created_at       timestamptz not null default now(),
  -- Cannot accept the invite without enrolling MFA.
  check (mfa_enrolled or accepted_at is null),
  -- If MFA is enrolled, there must be a secret.
  check (not mfa_enrolled or mfa_secret is not null)
);

comment on table admin_users is
  'global_system — admin identity. Separate from product identity; links via FK to auth.users for authn only. Single source of truth for is_admin (no boolean on users).';

-- FK to auth.users (raw SQL — Drizzle can't reference the auth schema).
-- ON DELETE CASCADE: if the product user is deleted, the admin row is too
-- (the user no longer exists; their admin access is moot).
do $$
begin
  execute 'alter table admin_users
            add constraint admin_users_user_id_fk
            foreign key (user_id)
            references auth.users(id)
            on delete cascade';
exception when duplicate_object then null;
end $$;

-- Self-reference: invited_by → admin_users(user_id).
-- ON DELETE SET NULL: if the inviting admin is removed, the invite record
-- survives (the invitee may already be accepted — we don't want to orphan
-- their admin row).
alter table admin_users
  add constraint admin_users_invited_by_fk
  foreign key (invited_by)
  references admin_users(user_id)
  on delete set null;

-- ───────────────────────────────────────────────
-- admin_sessions — admin session tokens (separate from product sessions)
-- ───────────────────────────────────────────────

create table admin_sessions (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid not null references admin_users(user_id) on delete cascade,
  token_hash      text unique not null,        -- argon2id of the raw session token.
  ip              inet not null,               -- bound to the issuing IP (no roaming).
  user_agent      text,                        -- for the device list UI.
  mfa_ok          boolean not null default false, -- MFA was satisfied for this session.
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,        -- hard cap: 8h. Re-auth required after.
  idle_expires_at timestamptz not null,        -- 30 min idle timeout, sliding.
  revoked_at      timestamptz,
  check (idle_expires_at <= expires_at)        -- idle can't outlive the absolute cap.
);

comment on table admin_sessions is
  'global_system — admin sessions. Separate from product sessions (no shared cookie, no shared token). 8h hard cap, 30min sliding idle, MFA-gated, IP-bound.';

create index idx_admin_sessions_admin on admin_sessions (admin_id);
create index idx_admin_sessions_expires on admin_sessions (expires_at) where revoked_at is null;
create index idx_admin_sessions_token on admin_sessions (token_hash) where revoked_at is null;

-- ───────────────────────────────────────────────
-- Audit: the admin control plane gets its own audit entries (ws_id null —
-- global system event). Uses the existing enterprise_audit_log_append().
-- ───────────────────────────────────────────────

do $$
begin
  perform enterprise_audit_log_append(
    null::uuid, 'system', 'migration-0047', 'admin.control_plane.created',
    jsonb_build_object('tables', array['admin_users','admin_sessions']),
    null::inet, null::text
  );
end $$;
