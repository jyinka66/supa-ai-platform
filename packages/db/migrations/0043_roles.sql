-- ───────────────────────────────────────────────
-- 0043_roles.sql
-- Custom roles as data — roles table + membership.role_id.
--
-- Roles are DATA, not code. Each workspace can define custom roles with
-- granular permissions. Built-in roles (owner/admin/member/guest) are
-- immutable (built_in=true). The permission registry is a closed enum
-- in code (src/authz/permissions.ts) — admins pick from it, never invent
-- strings.
--
-- membership.role (text) becomes membership.role_id (uuid FK to roles).
-- Migration backfills built-in roles + updates memberships to point at them.
--
-- has_role() pg function is NOT upgraded here — the v1 `is_ws_member(ws_id, 'admin')`
-- still works (it checks the text role column). A future migration would
-- upgrade has_role to check the permissions array, but that's a larger
-- change that touches every RLS policy. For now, both systems coexist:
--   v1: is_ws_member(ws_id, 'admin') — checks the text role.
--   v2: has_permission(ws_id, 'member:invite') — checks the roles.permissions array.
-- The CI linter verifies no NEW policy references raw role names except
-- owner/admin (the built-in hierarchy).
-- ───────────────────────────────────────────────

create table roles (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  built_in boolean not null default false,     -- owner/admin/member/guest immutable.
  permissions text[] not null default '{}',   -- checked against the permission registry.
  created_at timestamptz not null default now(),
  unique (ws_id, name)
);

alter table roles enable row level security;
-- Admin+ only (role management is sensitive — permissions grant access).
create policy roles_admin on roles for all to supa_app
  using (is_ws_member(ws_id, 'admin'))
  with check (is_ws_member(ws_id, 'admin'));

comment on table roles is '@tenant_table — custom roles as data (permissions from closed registry)';

create index on roles (ws_id);

-- Force RLS.
alter table roles force row level security;

-- ───────────────────────────────────────────────
-- Backfill built-in roles for every existing workspace.
-- ───────────────────────────────────────────────

insert into roles (ws_id, name, built_in, permissions)
select w.id, 'owner', true,
       array['file:read','file:write','file:share','member:invite','member:remove',
             'role:manage','webhook:manage','sso:manage','audit:read','billing:manage']
from workspaces w
where not exists (select 1 from roles r where r.ws_id = w.id and r.name = 'owner');

insert into roles (ws_id, name, built_in, permissions)
select w.id, 'admin', true,
       array['file:read','file:write','file:share','member:invite','member:remove',
             'webhook:manage','audit:read']
from workspaces w
where not exists (select 1 from roles r where r.ws_id = w.id and r.name = 'admin');

insert into roles (ws_id, name, built_in, permissions)
select w.id, 'member', true,
       array['file:read','file:write']
from workspaces w
where not exists (select 1 from roles r where r.ws_id = w.id and r.name = 'member');

insert into roles (ws_id, name, built_in, permissions)
select w.id, 'guest', true,
       array['file:read']
from workspaces w
where not exists (select 1 from roles r where r.ws_id = w.id and r.name = 'guest');

-- ───────────────────────────────────────────────
-- Add role_id to memberships (FK to roles).
-- ───────────────────────────────────────────────

alter table memberships
  add column if not exists role_id uuid references roles(id) on delete set null;

-- Backfill: map the text role to the built-in role_id.
update memberships m
set role_id = r.id
from roles r
where r.ws_id = m.ws_id and r.built_in = true and r.name = m.role;

-- ───────────────────────────────────────────────
-- has_permission() — check if the current user has a specific permission.
--
-- Checks: any role assigned to the user (via membership.role_id) whose
-- permissions array contains the required permission. Owner is implied-all
-- (the owner role has all permissions, so this is handled by the permissions
-- array, not a special case).
--
-- SECURITY DEFINER: runs as table owner (bypasses RLS on memberships + roles,
-- so the function can read membership + role rows without infinite recursion).
-- ───────────────────────────────────────────────

create or replace function has_permission(
  _ws uuid,
  _permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.ws_id = _ws
      and m.user_id = public.current_uid()
      and m.status = 'active'
      and (_permission = any (r.permissions)
           or r.name = 'owner')  -- owner is implied-all.
  )
$$;

comment on function has_permission(uuid, text) is
  'Check if the current user has a specific permission in the workspace. Owner is implied-all.';

grant execute on function has_permission(uuid, text) to supa_app;
grant execute on function has_permission(uuid, text) to supa_system;
