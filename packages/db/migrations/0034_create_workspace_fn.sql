-- ───────────────────────────────────────────────
-- 0034_create_workspace_fn.sql
-- Security-definer function for workspace creation (bootstrap).
--
-- Workspace creation needs to bypass RLS (no membership row exists yet →
-- is_ws_member returns false → can't insert the workspace). The function
-- runs as SECURITY DEFINER (the table owner) for the INSERT only, then
-- inserts the owner membership + default retention policy + builtin approver
-- role + audit entry — all in one transaction.
--
-- After creation, the workspace has an owner membership, so `is_ws_member`
-- works for all subsequent queries (via `withUser`).
--
-- The function takes (name, slug, region, created_by) — the created_by is
-- the user who will become the owner. Returns the workspace id.
-- ───────────────────────────────────────────────

create or replace function create_workspace(
  p_name text,
  p_slug text,
  p_region text default 'eu',
  p_created_by uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws_id uuid;
begin
  -- Insert the workspace (bypasses RLS via SECURITY DEFINER).
  insert into workspaces (name, slug, region, plan, kind, billing_owner_id)
  values (p_name, p_slug, p_region, 'free', 'team', p_created_by)
  returning id into v_ws_id;

  -- Insert the owner membership (the creator is the owner).
  insert into memberships (ws_id, user_id, role, status, joined_at)
  values (v_ws_id, p_created_by, 'owner', 'active', now());

  -- Insert the builtin 'approver' custom role.
  insert into custom_roles (ws_id, name, perms, builtin, created_by)
  values (v_ws_id, 'approver',
          '["chat.read","work.read","approvals.decide"]'::jsonb,
          true, p_created_by);

  -- Insert a default retention policy.
  insert into retention_policies (ws_id, chat_days, work_days, audit_days, legal_hold)
  values (v_ws_id, 365, 3650, 3650, false);

  -- Audit the creation (via the security-definer append function).
  perform enterprise_audit_log_append(
    v_ws_id, 'user', p_created_by::text, 'ws.created',
    jsonb_build_object('name', p_name, 'slug', p_slug, 'region', p_region),
    null::inet, null::text
  );

  return v_ws_id;
end;
$$;

comment on function create_workspace(text, text, text, uuid) is
  'Security-definer: bootstrap workspace creation. Bypasses RLS for the INSERT only (no membership exists yet). Creates owner membership + builtin approver role + default retention policy + audit entry in one transaction.';

-- Grant execute to supa_app (the function is callable by the app role;
-- the SECURITY DEFINER attribute handles the privilege escalation).
grant execute on function create_workspace(text, text, text, uuid) to supa_app;
grant execute on function create_workspace(text, text, text, uuid) to supa_system;
