-- ───────────────────────────────────────────────
-- 0061_phase14_governance_observability.sql
-- Phase 14 — Policy as Code + Governance + Observability + Billing + Scaling + Security.
--
-- Tables:
--   - policy_versions: versioned policy history (commit, review, rollback).
--   - policy_evaluations: every policy evaluation logged + searchable.
--   - governance_actions: marketplace/developer/regional/vertical/enterprise governance decisions.
--   - billing_events: usage-based billing for every billable action.
--   - scaling_events: auto-scaling/partitioning/indexing/caching decisions.
--   - security_scans: vulnerability/threat/access review scans + results.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- policy_versions — versioned policy history.
-- ───────────────────────────────────────────────

create table policy_versions (
  id              uuid primary key default gen_random_uuid(),
  policy_key      text not null,                     -- references policy_rules.key.
  version         text not null,                     -- semver.
  rule_snapshot   jsonb not null,                    -- the full rule at this version.
  changelog       text,
  committed_by    text not null default 'system',
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  status          text not null default 'committed' check (status in ('committed','reviewed','rolled_back','superseded')),
  simulation_results jsonb,                          -- { traffic_sample, matches, impact }.
  created_at      timestamptz not null default now(),
  unique (policy_key, version)
);

create index idx_policy_versions_key on policy_versions (policy_key, version desc);

comment on table policy_versions is
  'global_system — versioned policy history. Every change is a commit, reviewed, simulated, rollback-capable.';

-- ───────────────────────────────────────────────
-- policy_evaluations — every policy evaluation logged.
-- ───────────────────────────────────────────────

create table policy_evaluations (
  id              uuid primary key default gen_random_uuid(),
  policy_key      text,
  category        text not null,
  context         jsonb not null,                    -- the evaluation context.
  action          jsonb,                              -- the resulting action.
  matched         boolean not null default false,
  evaluated_at    timestamptz not null default now(),
  ws_id           uuid,                              -- the workspace context (if applicable).
  tool_key        text                               -- the tool being called (if applicable).
);

create index idx_policy_evaluations_time on policy_evaluations (evaluated_at desc);
create index idx_policy_evaluations_category on policy_evaluations (category, evaluated_at desc);
create index idx_policy_evaluations_policy on policy_evaluations (policy_key, evaluated_at desc);

comment on table policy_evaluations is
  'global_system — every policy evaluation logged + searchable. Policy observability.';

-- ───────────────────────────────────────────────
-- governance_actions — governance decisions across all domains.
-- ───────────────────────────────────────────────

create table governance_actions (
  id              uuid primary key default gen_random_uuid(),
  domain          text not null check (domain in ('marketplace','developer','regional','vertical','enterprise','ethical_ai')),
  action_type     text not null,                     -- 'review', 'publish', 'suspend', 'takedown', 'reinstate', 'warning'.
  target_id       text not null,                     -- the entity being governed.
  target_type     text not null,                     -- 'template', 'agent', 'connector', 'developer_org', 'region', 'vertical', 'deployment'.
  reason          text not null,
  automated       boolean not null default true,     -- true = algorithmic, false = human.
  reviewer_id     uuid,                              -- the human reviewer (if manual).
  status          text not null default 'completed' check (status in ('pending','completed','appealed','overturned')),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index idx_governance_actions_domain on governance_actions (domain, status);
create index idx_governance_actions_target on governance_actions (target_type, target_id);

comment on table governance_actions is
  'global_system — governance actions across marketplace/developer/regional/vertical/enterprise/ethical AI.';

-- ───────────────────────────────────────────────
-- billing_events — usage-based billing for every billable action.
-- ───────────────────────────────────────────────

create table billing_events (
  id              uuid primary key default gen_random_uuid(),
  ws_id           uuid references workspaces(id) on delete set null,
  user_id         uuid,
  feature         text not null,                     -- 'tool.call', 'agent.run', 'connector.action', 'template.install', etc.
  ref_key         text,                              -- the tool key / agent slug / connector key.
  quantity        numeric(18,4) not null default 1,
  unit            text not null default 'call',     -- 'call', 'token', 'second', 'embed', 'seat'.
  cost_usd        numeric(12,6) not null,
  local_currency  text,
  local_cost      numeric(12,6),
  tax_rate        numeric(5,4) default 0,
  tax_amount      numeric(12,6) default 0,
  total_with_tax  numeric(12,6) default 0,
  region          text,                              -- for regional tax application.
  metadata        jsonb not null default '{}',
  ts              timestamptz not null default now()
);

create index idx_billing_events_ts on billing_events (ts desc);
create index idx_billing_events_ws_feature on billing_events (ws_id, feature, ts desc);
create index idx_billing_events_feature on billing_events (feature, ts desc);

comment on table billing_events is
  'global_system — usage-based billing. Every tool call, agent run, connector action, template install, embed billed automatically.';

-- ───────────────────────────────────────────────
-- scaling_events — auto-scaling decisions.
-- ───────────────────────────────────────────────

create table scaling_events (
  id              uuid primary key default gen_random_uuid(),
  action_type     text not null check (action_type in ('scale_up','scale_down','partition','index','cache','evict','shard','provision_region','cost_optimize')),
  target          text not null,                     -- 'compute', 'storage', 'queue', 'database', 'table:<name>', 'region:<code>'.
  reason          text not null,
  before_state    jsonb,
  after_state     jsonb,
  cost_impact_usd numeric(12,2),
  automated       boolean not null default true,
  created_at      timestamptz not null default now()
);

create index idx_scaling_events_type on scaling_events (action_type, created_at desc);

comment on table scaling_events is
  'global_system — auto-scaling events. Compute/storage/queue/DB scaling, partitioning, indexing, caching, sharding, regioning, cost optimization.';

-- ───────────────────────────────────────────────
-- security_scans — vulnerability/threat/access review scans.
-- ───────────────────────────────────────────────

create table security_scans (
  id              uuid primary key default gen_random_uuid(),
  scan_type       text not null check (scan_type in ('dependency','container','code','threat','access_review','compliance','pen_test','bug_bounty')),
  target          text not null,                     -- 'dependencies', 'image:<name>', 'repo:<name>', 'workspace:<id>'.
  findings        jsonb not null default '[]',      -- [{ severity, title, description, cve, remediation }].
  severity_max    text check (severity_max in ('critical','high','medium','low','none')),
  passed          boolean not null default false,
  scanned_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index idx_security_scans_type on security_scans (scan_type, scanned_at desc);
create index idx_security_scans_unresolved on security_scans (scan_type) where resolved_at is null;

comment on table security_scans is
  'global_system — security scans. Dependency/container/code/threat/access/compliance/pen test/bug bounty.';

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on policy_versions to supa_app;
grant select on policy_evaluations to supa_app;
grant select on governance_actions to supa_app;
grant select on billing_events to supa_app;
grant select on scaling_events to supa_app;
grant select on security_scans to supa_app;

grant select, insert, update, delete on policy_versions to supa_system;
grant select, insert on policy_evaluations to supa_system;
grant select, insert, update, delete on governance_actions to supa_system;
grant select, insert, update, delete on billing_events to supa_system;
grant select, insert, update, delete on scaling_events to supa_system;
grant select, insert, update, delete on security_scans to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0061',
    'admin.phase14.governance_observability.created',
    jsonb_build_object('tables', array['policy_versions','policy_evaluations','governance_actions','billing_events','scaling_events','security_scans']),
    'migration 0061 — Phase 14 policy as code + governance + observability + billing + scaling + security',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
