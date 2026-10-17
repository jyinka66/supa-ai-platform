-- ───────────────────────────────────────────────
-- 0049_feature_flags.sql
-- Feature flags — global control plane (not tenant-scoped, not RLS'd).
--
-- `feature_flags` is a global_system table: a single source of truth for
-- feature toggles + kill switches. Read by the app on every request that
-- gates on a flag (fast lookup, in-memory cached at the app layer).
--
-- Two kinds:
--   - 'feature'    — gradual rollout (enabled + rollout_pct + targets).
--   - 'kill_switch' — emergency off-switch (enabled=false → immediate
--      disable, bypassing the rollout). Used to turn off a broken feature
--      without a deploy.
--
-- Resolution (first-match semantics, evaluated in this order):
--   1. targets.users    — explicit user allowlist (highest precedence).
--   2. targets.workspaces — explicit workspace allowlist.
--   3. targets.plans    — plan-based (e.g. 'pro' gets the feature).
--   4. rollout_pct      — percentage of users (stable hash bucket).
--   5. enabled         — global on/off (lowest precedence).
--
-- The first matching rule wins. If no rule matches, the flag is off.
--
-- `kill_switch` kind: enabled=false takes precedence over everything —
-- the feature is OFF for everyone, immediately (no rollout_pct, no targets).
--
-- This table is NOT RLS'd (it's global config, readable by the app role).
-- Access control: admin-only via the API (owner CRUD). The app reads it
-- via the default pool (supa_app role — SELECT granted).
-- ───────────────────────────────────────────────

create table feature_flags (
  key         text primary key,                          -- e.g. 'new_dashboard', 'agents_v2', 'kill_search_v3'
  kind        text not null default 'feature' check (kind in ('feature','kill_switch')),
  enabled     boolean not null default false,
  rollout_pct integer not null default 0 check (rollout_pct between 0 and 100),
  targets     jsonb not null default '{}',               -- { plans: [...], workspaces: [...], users: [...] }
  description text not null,
  owner       text not null,                              -- who to page when it breaks (team/person/email)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table feature_flags is
  'global_system — feature flags + kill switches. Single source of truth for feature toggles. Not RLS''d (global config, app-readable). Admin-only CRUD via API.';

-- Index for the app-layer lookup (by key — the hot path).
-- The PK already indexes `key`, but we add a partial index for enabled
-- kill_switches (the hot path: "are there any active kill switches?").
create index idx_feature_flags_kill_switches
  on feature_flags (key)
  where kind = 'kill_switch' and enabled = false;

-- ───────────────────────────────────────────────
-- updated_at trigger — bump on every UPDATE.
-- ───────────────────────────────────────────────

create or replace function bump_feature_flags_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_bump_feature_flags_updated_at
  before update on feature_flags
  for each row
  execute function bump_feature_flags_updated_at();

-- ───────────────────────────────────────────────
-- Grants: the app role (supa_app) can SELECT (read flags). Only the system
-- role (supa_system, used by the admin API) can INSERT/UPDATE/DELETE.
-- This enforces "app reads, admin writes" at the DB level.
-- ───────────────────────────────────────────────

-- supa_app: read-only.
grant select on feature_flags to supa_app;

-- supa_system: full CRUD (the admin API uses this role).
grant select, insert, update, delete on feature_flags to supa_system;

-- No RLS — the table is global config. Access control is via role grants
-- (supa_app = read, supa_system = write) + the admin API (owner-only CRUD).

-- ───────────────────────────────────────────────
-- Audit the migration itself (via the admin audit log).
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0049',
    'admin.feature_flags.created',
    jsonb_build_object('table', 'feature_flags'),
    'migration 0049 — create the feature flags control-plane table',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
