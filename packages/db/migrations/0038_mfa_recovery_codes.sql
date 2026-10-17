-- ───────────────────────────────────────────────
-- 0038_mfa_recovery_codes.sql
-- MFA recovery codes — 10 single-use codes per user, argon2id hashed.
--
-- When the user enables MFA (TOTP), they get 10 recovery codes (shown once).
-- If they lose their TOTP device, they can use a recovery code to log in.
-- Recovery codes are single-use (burned on first use) + argon2id hashed
-- (the raw code is never stored — same pattern as API keys + refresh tokens).
-- ───────────────────────────────────────────────

create table mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,  -- FK to auth.users added below.
  code_hash text not null unique,  -- argon2id of the recovery code.
  used_at timestamptz,  -- null = unused. Set when the code is burned.
  created_at timestamptz not null default now()
);

-- FK to auth.users.
alter table mfa_recovery_codes
  add constraint mfa_recovery_codes_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Index for lookup: find unused codes for a user.
create index on mfa_recovery_codes (user_id) where used_at is null;

-- RLS: user-scoped (not workspace-scoped — MFA is per-user, not per-ws).
alter table mfa_recovery_codes enable row level security;
create policy mfa_recovery_codes_self on mfa_recovery_codes
  for all using (user_id = auth.uid());

comment on table mfa_recovery_codes is
  'MFA recovery codes — 10 single-use, argon2id-hashed codes per user. Burned on first use.';
