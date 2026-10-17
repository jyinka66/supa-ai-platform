-- ───────────────────────────────────────────────
-- 0057_phase14_platform.sql
-- Phase 14 — Autonomous Global Platform Expansion.
--
-- The platform's nervous system: tool registry, agent templates, marketplace,
-- developer orgs, vertical editions, enterprise deployments, and policy rules.
--
-- All global_system (platform-level, not tenant-scoped).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- tool_registry — every capability is a typed tool.
-- Auto-registered when the underlying capability ships.
-- ───────────────────────────────────────────────

create table tool_registry (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,           -- 'search.web', 'file.upload', 'agent.run', etc.
  name            text not null,
  description     text not null,
  category        text not null check (category in ('ai','search','files','agents','integrations','compute','data','communication','security','other')),
  input_schema    jsonb not null default '{}',     -- JSON Schema for the tool's input.
  output_schema   jsonb not null default '{}',     -- JSON Schema for the tool's output.
  version         text not null default '1.0.0',   -- semver.
  status          text not null default 'active' check (status in ('active','deprecated','retired')),
  deprecated_at   timestamptz,
  retired_at      timestamptz,
  billable        boolean not null default false,
  price_per_call_usd numeric(10,6) default 0,
  rate_limit_per_min integer,                       -- per-workspace rate limit.
  auto_registered boolean not null default false,   -- true if auto-registered (capability shipped).
  owner           text not null,                    -- team responsible.
  metadata        jsonb not null default '{}',      -- extra context (endpoint, auth type, etc.).
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_tool_registry_category on tool_registry (category, status);
create index idx_tool_registry_status on tool_registry (status);

comment on table tool_registry is
  'global_system — tool registry. Every capability is a typed tool. Discoverable, callable, versionable, deprecable, billable, observable. Auto-registered when capabilities ship.';

-- ───────────────────────────────────────────────
-- marketplace_items — self-governing marketplace.
-- ───────────────────────────────────────────────

create table marketplace_items (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('template','agent','connector','vertical','tool')),
  slug            text not null unique,
  title           text not null,
  description     text not null,
  author_org_id   uuid,                            -- the developer org that published it.
  author_name     text not null,
  version         text not null default '1.0.0',
  status          text not null default 'draft' check (status in ('draft','pending_review','published','suspended','taken_down')),
  -- Self-governing: automated publish for low-risk, escalated for high-risk.
  review_type     text not null check (review_type in ('automated','manual','escalated')),
  review_result   jsonb,                            -- { checks: [...], passed: bool, notes: string }.
  -- Reputation + discovery.
  rating_avg      numeric(3,2) not null default 0,   -- 0.00 to 5.00.
  rating_count    integer not null default 0,
  install_count   integer not null default 0,
  revenue_share_pct numeric(5,2) not null default 70, -- % to the author (default 70%).
  -- Content.
  manifest        jsonb not null default '{}',     -- the item's config (prompt, tools, connectors, etc.).
  tags            text[] not null default '{}',
  -- Takedown (algorithmic first, human second).
  takedown_reason text,
  takedown_at     timestamptz,
  takedown_by     text,                              -- 'algorithm' or 'human:<admin_id>'.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);

create index idx_marketplace_kind_status on marketplace_items (kind, status);
create index idx_marketplace_rating on marketplace_items (rating_avg desc, install_count desc) where status = 'published';
create index idx_marketplace_author on marketplace_items (author_org_id);
create index idx_marketplace_tags on marketplace_items using gin (tags);

comment on table marketplace_items is
  'global_system — self-governing marketplace. Automated publish where safe, escalated where risky. Reputation drives trust. Ratings drive discovery. Revenue share drives participation. Takedowns algorithmic first, human second.';

-- ───────────────────────────────────────────────
-- developer_orgs — self-serve developer ecosystem.
-- ───────────────────────────────────────────────

create table developer_orgs (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  description     text,
  owner_user_id  uuid not null,
  -- Reputation.
  reputation_score numeric(5,2) not null default 50, -- 0-100 (50 = neutral, >70 = trusted, <30 = untrusted).
  verified        boolean not null default false,    -- verified org (badge).
  -- Revenue.
  total_revenue_usd numeric(12,2) not null default 0,
  payout_method   text,                               -- 'stripe', 'paypal', etc.
  payout_address  text,                               -- email or account id.
  -- Status.
  status          text not null default 'active' check (status in ('active','suspended','banned')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_developer_orgs_reputation on developer_orgs (reputation_score desc) where status = 'active';

comment on table developer_orgs is
  'global_system — developer orgs. Self-serve, self-paced, self-growing. Reputation drives trust. Revenue share drives participation.';

-- ───────────────────────────────────────────────
-- vertical_editions — generated from templates.
-- ───────────────────────────────────────────────

create table vertical_editions (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,               -- 'legal', 'healthcare', 'finance', 'education', etc.
  name            text not null,
  description     text not null,
  -- The vertical template (what gets assembled).
  template        jsonb not null default '{}',        -- { prompts: [...], agents: [...], connectors: [...], compliance: [...], tools: [...] }.
  -- Assembly status.
  status          text not null default 'template' check (status in ('template','assembling','reviewing','published','deprecated')),
  assembled_at    timestamptz,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  published_at    timestamptz,
  -- Domain-specific compliance.
  compliance_rules jsonb not null default '{}',       -- { hipaa: true, gdpr: true, soc2: true, etc. }.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table vertical_editions is
  'global_system — vertical editions. Generated from templates: domain-specific prompts, agents, connectors, compliance. Assembled by the platform, reviewed by humans once, then replicated autonomously.';

-- ───────────────────────────────────────────────
-- enterprise_deployments — automated VPC/on-prem/dedicated.
-- ───────────────────────────────────────────────

create table enterprise_deployments (
  id              uuid primary key default gen_random_uuid(),
  ws_id           uuid not null references workspaces(id) on delete cascade,
  deployment_type text not null check (deployment_type in ('cloud','vpc','on_prem','dedicated')),
  -- Template parameters (customer-specific).
  region          text not null,
  capacity_tier   text not null check (capacity_tier in ('small','medium','large','xl')),
  custom_domain   text,
  -- Provisioning state.
  status          text not null default 'pending' check (status in ('pending','provisioning','running','upgrading','degraded','terminated')),
  provisioned_at  timestamptz,
  last_upgrade_at timestamptz,
  -- Infrastructure metadata (opaque — the IaC layer interprets).
  infra_config    jsonb not null default '{}',
  -- Safety gates for upgrades.
  upgrade_safety_gates jsonb not null default '{"canary": true, "rollback_on_error": true, "max_failure_rate": 0.01}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_enterprise_deployments_ws on enterprise_deployments (ws_id, status);

comment on table enterprise_deployments is
  'global_system — enterprise deployments. VPC, on-prem, dedicated. Provisioned from templates with customer-specific parameters. Upgrades roll out automatically with safety gates.';

-- ───────────────────────────────────────────────
-- policy_rules — policy as code (versioned, runtime-evaluated).
-- ───────────────────────────────────────────────

create table policy_rules (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,              -- 'marketplace.publish.auto_approve', 'agent.autonomous.low_risk', etc.
  category        text not null check (category in ('approval','rate_limit','budget','compliance','tax','routing','takedown','scaling')),
  description     text not null,
  -- The policy (JSON: condition + action).
  rule            jsonb not null,                    -- { condition: {...}, action: {...} }.
  version         text not null default '1.0.0',
  status          text not null default 'active' check (status in ('active','draft','deprecated')),
  -- Scope (which entities this policy applies to).
  scope           text not null default 'global' check (scope in ('global','region','vertical','workspace','tool')),
  scope_filter    jsonb not null default '{}',       -- { region: 'eu', vertical: 'healthcare', ws_id: '...' }.
  -- Evaluation.
  priority        integer not null default 100,      -- lower = higher priority (evaluated first).
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_policy_rules_category_status on policy_rules (category, status, priority);
create index idx_policy_rules_scope on policy_rules (scope, status);

comment on table policy_rules is
  'global_system — policy as code. Approval, rate limits, budgets, compliance, tax, routing, takedowns, scaling. Versioned. Evaluated at runtime. Scoped (global/region/vertical/workspace/tool).';

-- ───────────────────────────────────────────────
-- Seed the tool registry with core tools.
-- ───────────────────────────────────────────────

insert into tool_registry (key, name, description, category, version, billable, owner) values
  ('search.web',      'Web Search',         'Search the web for real-time information.', 'search', '1.0.0', true, 'team-platform'),
  ('file.upload',     'File Upload',         'Upload a file to workspace storage.',     'files', '1.0.0', false, 'team-platform'),
  ('file.download',   'File Download',       'Download a file from workspace storage.',  'files', '1.0.0', false, 'team-platform'),
  ('agent.run',       'Run Agent',           'Execute an autonomous agent with tools.',  'agents', '1.0.0', true, 'team-platform'),
  ('chat.complete',   'Chat Completion',     'Get an AI completion for a prompt.',       'ai', '1.0.0', true, 'team-platform'),
  ('chat.stream',     'Chat Stream',         'Stream an AI completion token-by-token.',  'ai', '1.0.0', true, 'team-platform'),
  ('workspace.create','Create Workspace',    'Create a new workspace.',                   'data', '1.0.0', false, 'team-platform'),
  ('email.send',      'Send Email',          'Send an email notification.',              'communication', '1.0.0', true, 'team-platform'),
  ('webhook.deliver', 'Deliver Webhook',     'Deliver a webhook to an external endpoint.','communication', '1.0.0', false, 'team-platform'),
  ('pdf.generate',    'Generate PDF',        'Generate a PDF document from content.',    'compute', '1.0.0', true, 'team-platform')
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- Seed default policy rules.
-- ───────────────────────────────────────────────

insert into policy_rules (key, category, description, rule, scope, priority) values
  ('marketplace.publish.auto_approve',
   'approval',
   'Auto-approve marketplace items from verified orgs with reputation > 70.',
   '{"condition": {"author_verified": true, "author_reputation_gte": 70, "kind_in": ["template", "tool"]}, "action": {"auto_approve": true}}',
   'global', 100),
  ('marketplace.publish.escalate_high_risk',
   'approval',
   'Escalate marketplace items from unverified orgs or high-risk kinds.',
   '{"condition": {"author_verified": false, "kind_in": ["agent", "connector", "vertical"]}, "action": {"escalate": true, "review_type": "manual"}}',
   'global', 90),
  ('agent.autonomous.low_risk',
   'approval',
   'Auto-approve low-risk autonomous agents (read-only tools, bounded budget).',
   '{"condition": {"tools_read_only": true, "budget_limit_usd_lte": 1.0}, "action": {"auto_approve": true}}',
   'global', 100),
  ('rate_limit.api_per_workspace',
   'rate_limit',
   'Default API rate limit: 100 requests per minute per workspace.',
   '{"condition": {"plan": "default"}, "action": {"limit_per_min": 100}}',
   'global', 100),
  ('rate_limit.enterprise',
   'rate_limit',
   'Enterprise workspaces get 10000 requests per minute.',
   '{"condition": {"plan": "enterprise"}, "action": {"limit_per_min": 10000}}',
   'global', 90),
  ('takedown.algorithmic.low_rating',
   'takedown',
   'Auto-suspend items with rating < 2.0 and > 50 ratings.',
   '{"condition": {"rating_avg_lt": 2.0, "rating_count_gte": 50}, "action": {"suspend": true, "reason": "low_rating"}}',
   'global', 100),
  ('takedown.algorithmic.malware',
   'takedown',
   'Auto-take-down items flagged as malware by automated scanning.',
   '{"condition": {"malware_detected": true}, "action": {"take_down": true, "reason": "malware"}}',
   'global', 50)
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on tool_registry to supa_app;
grant select on marketplace_items to supa_app;
grant select on developer_orgs to supa_app;
grant select on vertical_editions to supa_app;
grant select on enterprise_deployments to supa_app;
grant select on policy_rules to supa_app;

grant select, insert, update, delete on tool_registry to supa_system;
grant select, insert, update, delete on marketplace_items to supa_system;
grant select, insert, update, delete on developer_orgs to supa_system;
grant select, insert, update, delete on vertical_editions to supa_system;
grant select, insert, update, delete on enterprise_deployments to supa_system;
grant select, insert, update, delete on policy_rules to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0057',
    'admin.phase14.platform.created',
    jsonb_build_object('tables', array['tool_registry','marketplace_items','developer_orgs','vertical_editions','enterprise_deployments','policy_rules'], 'tools_seeded', 10, 'policies_seeded', 7),
    'migration 0057 — Phase 14 autonomous global platform expansion',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
