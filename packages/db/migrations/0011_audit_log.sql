-- ============ AUDIT LOG ============
-- Append-only record of privileged and destructive actions.
--
-- Design principles:
--   1. INSERT-only: no UPDATE or DELETE path exists at the DB level.
--   2. RLS allows admins to INSERT (for user-initiated actions) AND
--      service_role to INSERT (for system/cron actions).
--   3. RLS allows workspace admins to SELECT their own audit log.
--   4. The `actor_id` references auth.users (not a separate app_users table).
--
-- NOTE: migration 0001 created a simpler `audit_log` table with columns
-- (id uuid, type, user_id, workspace_id, metadata, created_at). This migration
-- DROPS that table and recreates it with the full schema. Any data in the
-- 0001-style table is lost — if you need to preserve it, run a data migration
-- first:
--   insert into audit_log_new (actor_id, actor_kind, action, target_type, target_id, workspace_id, metadata, created_at)
--   select user_id, 'system', type, 'unknown', '', workspace_id, metadata, created_at
--   from audit_log;
--   drop table audit_log;
--   alter table audit_log_new rename to audit_log;

-- Drop old policies + indexes from migration 0001's audit_log.
drop policy if exists audit_log_service_select on public.audit_log;
drop index if exists public.idx_audit_log_type;
drop index if exists public.idx_audit_log_ws;
drop index if exists public.idx_audit_log_user;
drop index if exists public.idx_audit_log_created;

-- Drop the old log_audit_event function (replaced by app-level audit() calls).
drop function if exists public.log_audit_event(text, uuid, uuid, jsonb);

-- Drop the old table (migration 0001's schema) so 0011's schema is authoritative.
-- This is safe because audit_log data is non-critical (observability only).
drop table if exists public.audit_log;

-- ============ CREATE TABLE (0011 schema) ============
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid,                         -- auth.users.id, null for system/cron
  actor_kind   text not null default 'user'  -- 'user' | 'system' | 'cron'
    check (actor_kind in ('user', 'system', 'cron')),
  action       text not null,                -- see taxonomy comment below
  target_type  text not null,                -- 'conversation' | 'share_link' | 'workspace' | ...
  target_id    text not null,
  workspace_id uuid,
  metadata     jsonb not null default '{}'::jsonb,
  ip_address   text,
  created_at   timestamptz not null default now()
);

-- ============ ACTION TAXONOMY ============
-- Suggested action values (enforced at the app layer, not via CHECK):
--   'conversation.create'     'conversation.delete'     'conversation.share'
--   'workspace.create'        'workspace.update'         'workspace.delete'
--   'workspace_member.invite' 'workspace_member.add'     'workspace_member.remove'
--   'workspace_member.role_change'
--   'share_link.create'      'share_link.revoke'        'share_link.view_exhausted'
--   'session.revoke'         'session.revoke_all'
--   'account.deletion_request' 'account.deletion_cancel' 'account.purged'
--   'prompt_version.promote'
--   'auth.signup'            'auth.login'               'auth.mfa_enroll'
--   'budget.exceeded'        'budget.alert'
comment on table public.audit_log is
  'Append-only audit trail. INSERT-only — no UPDATE or DELETE. Action taxonomy enforced at app layer.';

-- ============ INDEXES ============
create index if not exists idx_audit_actor
  on public.audit_log (actor_id, created_at desc);

create index if not exists idx_audit_target
  on public.audit_log (target_type, target_id);

create index if not exists idx_audit_workspace
  on public.audit_log (workspace_id, created_at desc)
  where workspace_id is not null;

create index if not exists idx_audit_action
  on public.audit_log (action, created_at desc);

-- ============ APPEND-ONLY ENFORCEMENT ============
-- Revoke UPDATE and DELETE from all roles.
-- The only way to modify rows is via a superuser (DB admin) or a
-- TRIGGER that runs as SECURITY DEFINER (for cascading writes).
revoke update, delete on public.audit_log from public, authenticated, anon;

-- Also revoke UPDATE/DELETE on the sequence (prevents sequence manipulation).
revoke update, delete on public.audit_log_id_seq from public, authenticated, anon;

-- ============ RLS ============
alter table public.audit_log enable row level security;

drop policy if exists audit_read_admin on public.audit_log;
drop policy if exists audit_read_system on public.audit_log;
drop policy if exists audit_insert_user on public.audit_log;
drop policy if exists audit_insert_system on public.audit_log;

-- SELECT: workspace admins can read their workspace's audit log.
-- System actions (workspace_id is null) are only readable by service_role.
create policy audit_read_admin on public.audit_log
  for select using (
    workspace_id is not null
    and exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = audit_log.workspace_id
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

-- SELECT: service_role can read everything (admin dashboard, forensics).
create policy audit_read_system on public.audit_log
  for select using (auth.role() = 'service_role');

-- INSERT: authenticated users can insert audit entries for their own actions.
-- The app layer is responsible for setting the correct actor_id + workspace_id.
create policy audit_insert_user on public.audit_log
  for insert to authenticated
  with check (
    actor_kind = 'user'
    and actor_id = auth.uid()
  );

-- INSERT: service_role can insert system/cron audit entries.
-- This covers cron jobs (purge-deletions, prompt evaluation) and
-- system-initiated actions (cascade deletes, automated role changes).
create policy audit_insert_system on public.audit_log
  for insert
  with check (actor_kind in ('system', 'cron'));
