-- ───────────────────────────────────────────────
-- 0062_governance_spec.sql
-- Autonomous Governance Specification — the substrate of the platform.
--
-- Tables:
--   - governance_decisions: every decision logged (what/why/by which policy).
--   - governance_delegations: explicit delegation of irreversible actions.
--   - governance_kill_switches: global + scoped kill switches (immediate stop).
--   - governance_transparency_log: user-facing + auditor-facing decision log.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- governance_decisions — every governance decision logged.
-- ───────────────────────────────────────────────

create table governance_decisions (
  id              uuid primary key default gen_random_uuid(),
  -- What.
  action_type     text not null,                     -- 'tool.call', 'agent.run', 'marketplace.publish', etc.
  target_type     text not null,                     -- 'tool', 'agent', 'template', 'connector', 'region', 'vertical', 'deployment'.
  target_id       text not null,
  -- Context.
  ws_id           uuid,                              -- workspace context (if applicable).
  actor_id        text not null,                     -- who/what initiated (user_id, 'system', 'agent:<id>').
  -- Risk assessment.
  risk_level      text not null check (risk_level in ('low','medium','high','critical','irreversible')),
  -- Decision.
  decision        text not null check (decision in ('auto_approved','policy_approved','human_approved','blocked','deferred')),
  policy_key      text,                              -- which policy rule governed this decision.
  policy_version  text,                              -- the policy version at decision time.
  -- Reasoning.
  reasoning       jsonb not null default '{}',      -- { factors: [...], reputation: N, cost: N, compliance: [...] }.
  -- Audit.
  decided_by      text not null default 'system',   -- 'system' (auto) or admin_id (human).
  decided_at      timestamptz not null default now(),
  -- Reversibility.
  reversible      boolean not null default true,
  reversed_at     timestamptz,
  reversed_by     text,
  -- Appeal.
  appealable      boolean not null default true,
  appealed_at     timestamptz,
  appeal_status   text check (appeal_status in ('pending','approved','rejected'))
);

create index idx_gov_decisions_target on governance_decisions (target_type, target_id, decided_at desc);
create index idx_gov_decisions_risk on governance_decisions (risk_level, decision);
create index idx_gov_decisions_ws on governance_decisions (ws_id, decided_at desc) where ws_id is not null;
create index idx_gov_decisions_actor on governance_decisions (actor_id, decided_at desc);

comment on table governance_decisions is
  'global_system — every governance decision logged. Risk-based routing: auto/policy/human/block. Full audit trail.';

-- ───────────────────────────────────────────────
-- governance_delegations — explicit delegation of irreversible actions.
-- ───────────────────────────────────────────────

create table governance_delegations (
  id              uuid primary key default gen_random_uuid(),
  -- What is delegated.
  action_type     text not null,                     -- e.g. 'workspace.delete', 'data.purge', 'license.revoke'.
  target_type     text not null,
  -- Who delegates to whom.
  delegator_id    text not null,                     -- the human who delegates (admin_id).
  delegatee_id    text not null,                    -- who receives the delegation ('system', 'agent:<id>', user_id).
  -- Scope.
  scope_type      text not null check (scope_type in ('global','workspace','region','vertical')),
  scope_filter    jsonb not null default '{}',      -- { ws_id: '...', region: 'eu' }.
  -- Conditions.
  conditions      jsonb not null default '{}',      -- { max_cost_usd: 100, requires_mfa: true, time_window: 'business_hours' }.
  -- Lifecycle.
  status          text not null default 'active' check (status in ('active','revoked','expired')),
  expires_at      timestamptz,                      -- null = perpetual (requires periodic review).
  last_reviewed_at timestamptz not null default now(),
  review_interval_days integer not null default 90, -- must be reviewed every 90 days.
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_reason  text
);

create index idx_gov_delegations_delegatee on governance_delegations (delegatee_id, status);
create index idx_gov_delegations_action on governance_delegations (action_type, status);

comment on table governance_delegations is
  'global_system — explicit delegation of irreversible actions. Scope-limited, condition-gated, periodically reviewed, revocable.';

-- ───────────────────────────────────────────────
-- governance_kill_switches — global + scoped kill switches.
-- ───────────────────────────────────────────────

create table governance_kill_switches (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,              -- 'global.agent_autonomy', 'marketplace.publishing', 'region.eu.data_flows'.
  scope_type      text not null check (scope_type in ('global','feature','region','vertical','workspace','tool','agent')),
  scope_filter    jsonb not null default '{}',      -- { region: 'eu', tool_key: 'search.web' }.
  description     text not null,
  -- State.
  is_active       boolean not null default false,     -- true = KILL SWITCH ENGAGED (action blocked).
  activated_at    timestamptz,
  activated_by    text not null default 'system',   -- 'system' (auto) or admin_id (human).
  activation_reason text,
  -- Auto-recovery.
  auto_deactivate_at timestamptz,                   -- auto-deactivate after this time (if safe).
  -- Audit.
  deactivated_at  timestamptz,
  deactivated_by  text,
  deactivation_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_kill_switches_active on governance_kill_switches (is_active, scope_type);

comment on table governance_kill_switches is
  'global_system — kill switches. Global + scoped. Immediate stop. Auto-recovery with time limit. Full audit.';

-- ───────────────────────────────────────────────
-- governance_transparency_log — user-facing + auditor-facing.
-- ───────────────────────────────────────────────

create table governance_transparency_log (
  id              uuid primary key default gen_random_uuid(),
  -- Who.
  user_id         uuid,                              -- the user whose data/action this concerns (null for platform-level).
  ws_id           uuid,
  -- What.
  action_type     text not null,
  target_type     text not null,
  target_id       text not null,
  -- Decision summary (no PII).
  decision        text not null,
  risk_level      text not null,
  policy_key      text,
  reasoning_summary text not null,                   -- human-readable, no PII.
  -- For users.
  user_visible    boolean not null default true,     -- can the user see this in their transparency dashboard?
  user_message    text,                               -- the user-facing explanation.
  -- For auditors (no user data).
  auditor_visible boolean not null default false,
  auditor_evidence jsonb not null default '{}',     -- evidence for compliance (no PII).
  -- Timestamps.
  created_at      timestamptz not null default now()
);

create index idx_transparency_user on governance_transparency_log (user_id, created_at desc) where user_id is not null;
create index idx_transparency_ws on governance_transparency_log (ws_id, created_at desc) where ws_id is not null;
create index idx_transparency_auditor on governance_transparency_log (auditor_visible, created_at desc) where auditor_visible = true;

comment on table governance_transparency_log is
  'global_system — transparency log. Users see what happened on their behalf. Auditors verify decisions without accessing user data.';

-- ───────────────────────────────────────────────
-- Seed default kill switches (all inactive).
-- ───────────────────────────────────────────────

insert into governance_kill_switches (key, scope_type, description) values
  ('global.agent_autonomy',   'global',  'Kill switch for all autonomous agent actions globally.'),
  ('global.marketplace',      'global',  'Kill switch for all marketplace publishing/takedowns.'),
  ('global.regional_expansion','global', 'Kill switch for all regional auto-activation.'),
  ('global.scaling',          'global',  'Kill switch for all auto-scaling decisions.'),
  ('global.billing',          'global',  'Kill switch for all automated billing/revenue share.'),
  ('feature.tool_autoreg',    'feature', 'Kill switch for auto-registration of new tools.'),
  ('feature.auto_deprecation','feature', 'Kill switch for auto-deprecation of zero-usage tools.'),
  ('feature.policy_autotune', 'feature', 'Kill switch for policy auto-tuning proposals.')
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on governance_decisions to supa_app;
grant select on governance_delegations to supa_app;
grant select on governance_kill_switches to supa_app;
grant select on governance_transparency_log to supa_app;

grant select, insert, update, delete on governance_decisions to supa_system;
grant select, insert, update, delete on governance_delegations to supa_system;
grant select, insert, update on governance_kill_switches to supa_system;
grant select, insert on governance_transparency_log to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0062',
    'admin.governance.spec.created',
    jsonb_build_object('tables', array['governance_decisions','governance_delegations','governance_kill_switches','governance_transparency_log'], 'kill_switches_seeded', 8),
    'migration 0062 — Autonomous Governance Specification substrate',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
