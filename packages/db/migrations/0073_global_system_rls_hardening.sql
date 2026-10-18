-- 0073_global_system_rls_hardening.sql
-- Explicit RLS for platform-wide ledgers and records that carry optional
-- workspace metadata. The global_system comment is a classification, not an
-- exemption from RLS. supa_system is the trusted background/admin role;
-- supa_app only sees tenant rows allowed by current_uid()/is_ws_member().
--
-- Do not FORCE RLS here: migrations run as the table owner, while runtime
-- app/system roles are controlled by the policies below.

alter table cost_ledger enable row level security;
alter table support_tickets enable row level security;
alter table enterprise_deployments enable row level security;
alter table sandbox_workspaces enable row level security;
alter table partner_integrations enable row level security;
alter table enterprise_licenses enable row level security;
alter table enterprise_slas enable row level security;
alter table compliance_evidence enable row level security;
alter table policy_evaluations enable row level security;
alter table billing_events enable row level security;
alter table governance_decisions enable row level security;
alter table governance_transparency_log enable row level security;
alter table build_sessions enable row level security;

-- cost_ledger is append-only. Appends must be tied to the authenticated user
-- and an active workspace membership where a workspace is present.
drop policy if exists cost_ledger_app_insert on cost_ledger;
create policy cost_ledger_app_insert on cost_ledger
  for insert to supa_app
  with check (
    user_id = current_uid()
    and (ws_id is null or is_ws_member(ws_id, 'member'))
  );
create policy cost_ledger_system_all on cost_ledger
  for all to supa_system using (true) with check (true);

-- Support tickets: users can see their own requests; workspace admins can see
-- workspace tickets. New requests must be attributed to the authenticated user.
create policy support_tickets_user_select on support_tickets
  for select to supa_app
  using (
    user_id = current_uid()
    or (ws_id is not null and is_ws_member(ws_id, 'admin'))
  );
create policy support_tickets_user_insert on support_tickets
  for insert to supa_app
  with check (
    user_id = current_uid()
    and (ws_id is null or is_ws_member(ws_id, 'member'))
  );
create policy support_tickets_system_all on support_tickets
  for all to supa_system using (true) with check (true);

-- Enterprise control-plane records are visible to workspace admins only.
create policy enterprise_deployments_admin_select on enterprise_deployments
  for select to supa_app using (is_ws_member(ws_id, 'admin'));
create policy enterprise_deployments_system_all on enterprise_deployments
  for all to supa_system using (true) with check (true);

create policy sandbox_workspaces_admin_select on sandbox_workspaces
  for select to supa_app using (ws_id is not null and is_ws_member(ws_id, 'admin'));
create policy sandbox_workspaces_system_all on sandbox_workspaces
  for all to supa_system using (true) with check (true);

create policy partner_integrations_admin_select on partner_integrations
  for select to supa_app using (is_ws_member(ws_id, 'admin'));
create policy partner_integrations_system_all on partner_integrations
  for all to supa_system using (true) with check (true);

create policy enterprise_licenses_admin_select on enterprise_licenses
  for select to supa_app using (is_ws_member(ws_id, 'admin'));
create policy enterprise_licenses_system_all on enterprise_licenses
  for all to supa_system using (true) with check (true);

create policy enterprise_slas_admin_select on enterprise_slas
  for select to supa_app using (is_ws_member(ws_id, 'admin'));
create policy enterprise_slas_system_all on enterprise_slas
  for all to supa_system using (true) with check (true);

create policy compliance_evidence_admin_select on compliance_evidence
  for select to supa_app using (is_ws_member(ws_id, 'admin'));
create policy compliance_evidence_system_all on compliance_evidence
  for all to supa_system using (true) with check (true);

-- Audit and telemetry rows are readable only in their tenant context.
-- Platform-wide records (no ws_id) remain restricted to supa_system.
create policy policy_evaluations_workspace_select on policy_evaluations
  for select to supa_app using (ws_id is not null and is_ws_member(ws_id, 'admin'));
create policy policy_evaluations_system_all on policy_evaluations
  for all to supa_system using (true) with check (true);

create policy billing_events_user_select on billing_events
  for select to supa_app
  using (
    user_id = current_uid()
    or (ws_id is not null and is_ws_member(ws_id, 'admin'))
  );
create policy billing_events_system_all on billing_events
  for all to supa_system using (true) with check (true);

create policy governance_decisions_audit_select on governance_decisions
  for select to supa_app
  using (
    actor_id = current_uid()::text
    or (ws_id is not null and is_ws_member(ws_id, 'admin'))
  );
create policy governance_decisions_system_all on governance_decisions
  for all to supa_system using (true) with check (true);

create policy governance_transparency_user_select on governance_transparency_log
  for select to supa_app
  using (
    (user_visible and user_id = current_uid())
    or (ws_id is not null and is_ws_member(ws_id, 'admin'))
  );
create policy governance_transparency_system_all on governance_transparency_log
  for all to supa_system using (true) with check (true);

-- Build sessions are workspace admin features; a creator can read their own
-- build session even if their membership role is below admin.
create policy build_sessions_owner_select on build_sessions
  for select to supa_app
  using (owner_id = current_uid() or is_ws_member(ws_id, 'admin'));
create policy build_sessions_owner_insert on build_sessions
  for insert to supa_app
  with check (owner_id = current_uid() and is_ws_member(ws_id, 'admin'));
create policy build_sessions_system_all on build_sessions
  for all to supa_system using (true) with check (true);
