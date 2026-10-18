-- ───────────────────────────────────────────────
-- 0033_base_rls_pattern.sql
-- The non-negotiable RLS core: supa_app role + current_uid() + is_ws_member()
-- canonical predicate + FORCE ROW LEVEL SECURITY on all tenant tables.
--
-- This migration establishes the RLS pattern that ALL later migrations must
-- follow (enforced by CI lint via the @tenant_table comment).
--
-- DIVERGENCE from the pasted spec:
--   The spec's `create table workspaces/memberships/invitations/users` would
--   COLLIDE with existing tables (0001 created workspaces + invites; 0029
--   created memberships; auth.users exists in Supabase's auth schema). This
--   migration adds the RLS INFRASTRUCTURE on top of the existing tables —
--   the supa_app role, the helper functions, FORCE RLS, and @tenant_table
--   comments — WITHOUT recreating the tables.
--
--   The `users` table from the spec is NOT created (we use auth.users). The
--   `role_locked_by_owner` column from the spec is NOT added (we dropped it
--   in the members service — the `role <> 'owner'` guard in syncRole is the
--   equivalent).
-- ───────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ───────────────────────────────────────────────
-- supa_app role — the non-bypass application role.
-- The app NEVER connects as superuser or table owner. All queries run as
-- supa_app, which is subject to RLS on every tenant table.
-- ───────────────────────────────────────────────
do $$
begin
  -- Create the role if it doesn't exist (idempotent).
  if not exists (select 1 from pg_roles where rolname = 'supa_app') then
    create role supa_app login password null;  -- password injected via secret store.
  end if;
end
$$;

-- Trusted system role used by audited administrative and background jobs.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supa_system') then
    create role supa_system login password null;
  end if;
end
$$;

grant usage on schema public to supa_system;

-- Revoke CREATE on public schema (supa_app can't create tables).
revoke create on schema public from supa_app;

-- Revoke default privileges (supa_app gets only what's explicitly granted).
alter default privileges revoke all on tables from supa_app;
alter default privileges revoke all on sequences from supa_app;

-- Grant USAGE on public schema (supa_app can query tables it has SELECT on).
grant usage on schema public to supa_app;

-- ───────────────────────────────────────────────
-- current_uid() — extract the user id from the JWT claims.
--
-- The app sets `request.jwt.claims` per request (Supabase's PostgREST does
-- this automatically from the Authorization header). This function extracts
-- the `sub` claim (the user's UUID).
--
-- FIX from the pasted spec: the spec's function body was corrupted (duplicated
-- fragments + invisible Unicode zero-width chars). Replaced with a clean
-- single-statement function.
-- ───────────────────────────────────────────────
create or replace function current_uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims.sub', true), '')::uuid
$$;

comment on function current_uid() is
  'Extract the user id from the JWT claims. Returns null if not authenticated.';

-- ───────────────────────────────────────────────
-- is_ws_member(_ws, min_role) — the canonical RLS predicate.
--
-- Single canonical predicate, reused by EVERY policy on EVERY tenant table.
-- This is the non-negotiable core: all RLS policies call this function, not
-- inline `auth.uid() → workspace_members join` logic. Centralizing the
-- predicate means:
--   1. One place to fix tenancy bugs (not N policies to update).
--   2. The role hierarchy (owner > admin > member > viewer > custom) is
--      defined once, not duplicated per table.
--   3. The `status='active'` check is enforced (suspended/erased members
--      are blocked).
--
-- SECURITY DEFINER: runs as the table owner (bypasses RLS on memberships,
-- so the function can read membership rows without infinite recursion).
-- SET search_path = '': prevents search-path injection.
--
-- FIX from the pasted spec: the spec's function body was corrupted (no spaces,
-- duplicated, invisible Unicode). Replaced with a clean function.
--
-- NOTE: this function uses the EXISTING `memberships` table (migration 0029),
-- not the spec's `memberships` with `role_locked_by_owner`. The `role_locked_by_owner`
-- concept (admin-pinned role that IdP sync can't override) is NOT implemented —
-- the `role <> 'owner'` guard in syncRole is the equivalent (owner is never
-- demoted by IdP sync; other roles can be synced).
-- ───────────────────────────────────────────────
create or replace function is_ws_member(
  _ws uuid,
  min_role text default 'member'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.ws_id = _ws
      and m.user_id = public.current_uid()
      and m.status = 'active'
      and case min_role
            when 'viewer' then m.role in ('owner', 'admin', 'member', 'viewer', 'custom')
            when 'member' then m.role in ('owner', 'admin', 'member', 'custom')
            when 'admin'  then m.role in ('owner', 'admin')
            when 'owner'  then m.role = 'owner'
            else false
          end
  )
$$;

comment on function is_ws_member(uuid, text) is
  'Canonical RLS predicate: is the current user an active member of _ws with at least min_role?';

-- ───────────────────────────────────────────────
-- FORCE ROW LEVEL SECURITY on all tenant tables.
--
-- FORCE means: RLS applies even to the table OWNER (not just non-owner roles).
-- Without FORCE, a table owner bypasses RLS. With FORCE, even the migration
-- role (which owns the tables) is subject to RLS when connected as supa_app.
--
-- This is the "belt + suspenders" the spec calls out:
--   Belt:  revoke bypassrls from supa_app.
--   Suspenders: alter role supa_app set row_security = on + FORCE RLS.
--
-- The existing tables already have RLS enabled (via their migration CREATE
-- policies). This migration adds FORCE (which is stronger — applies to owners).
-- ───────────────────────────────────────────────

-- supa_app can't bypass RLS.
alter role supa_app nobypassrls;

-- supa_app has row_security = on (can't disable it).
alter role supa_app set row_security = on;

-- FORCE RLS on all tenant tables (applies even to table owners).
-- The existing tables (workspaces, memberships, etc.) already have RLS enabled;
-- FORCE is the stronger form.
alter table workspaces force row level security;
alter table memberships force row level security;
alter table agents force row level security;
alter table agent_memory force row level security;
alter table runs force row level security;
alter table run_steps force row level security;
alter table approvals force row level security;
alter table budget_entries force row level security;
alter table agent_idempotency force row level security;
alter table agent_triggers force row level security;
alter table agent_teams force row level security;
alter table custom_roles force row level security;
alter table sso_configs force row level security;
alter table sso_nonces force row level security;
alter table scim_tokens force row level security;
alter table scim_groups force row level security;
alter table scim_log force row level security;
alter table scim_refs force row level security;
alter table api_keys force row level security;
alter table enterprise_audit_log force row level security;
alter table retention_policies force row level security;
alter table webhook_endpoints force row level security;
alter table webhook_deliveries force row level security;
alter table sessions force row level security;

-- ───────────────────────────────────────────────
-- @tenant_table comments — CI lint marker.
--
-- Every tenant table has a `@tenant_table` comment. The CI lint scans for
-- these comments + verifies:
--   1. The table has RLS enabled + FORCED.
--   2. The table has a policy that calls `is_ws_member(ws_id)`.
--   3. The table carries `ws_id` (the tenancy spine).
--
-- A table that's missing any of these is a CI failure (blocks merge).
-- This is the "enforced by CI lint" the spec calls out.
-- ───────────────────────────────────────────────

comment on table workspaces is '@tenant_table — root tenant entity';
comment on table memberships is '@tenant_table — enterprise memberships (SSO/SCIM/MFA state)';
comment on table agents is '@tenant_table — agent definitions';
comment on table agent_memory is '@tenant_table — agent memory (PII-redacted)';
comment on table runs is '@tenant_table — agent run execution';
comment on table run_steps is '@tenant_table — agent run step log';
comment on table approvals is '@tenant_table — approval inbox (two-gate)';
comment on table budget_entries is '@tenant_table — budget ledger (hold/capture/refund)';
comment on table agent_idempotency is '@tenant_table — tool call idempotency cache';
comment on table agent_triggers is '@tenant_table — schedules/events/webhooks';
comment on table agent_teams is '@tenant_table — delegation graph edges';
comment on table custom_roles is '@tenant_table — custom role definitions (Enterprise)';
comment on table sso_configs is '@tenant_table — SSO config (OIDC/SAML)';
comment on table sso_nonces is '@tenant_table — SAML replay defense';
comment on table scim_tokens is '@tenant_table — SCIM bearer tokens';
comment on table scim_groups is '@tenant_table — SCIM group→role mapping';
comment on table scim_log is '@tenant_table — SCIM request log (admin-only)';
comment on table scim_refs is '@tenant_table — SCIM external ID → local user mapping';
comment on table api_keys is '@tenant_table — workspace API keys';
comment on table enterprise_audit_log is '@tenant_table — hash-chained audit log (SET NULL on ws delete)';
comment on table retention_policies is '@tenant_table — retention + legal hold';
comment on table webhook_endpoints is '@tenant_table — webhook delivery targets';
comment on table webhook_deliveries is '@tenant_table — webhook delivery attempts';
comment on table sessions is '@tenant_table — session security + device management (user-scoped, not ws-scoped)';
