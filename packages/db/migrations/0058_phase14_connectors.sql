-- ───────────────────────────────────────────────
-- 0058_phase14_connectors.sql
-- Phase 14 — Autonomous Connector SDK + Tool Enhancements.
--
-- Tables:
--   - connectors: declarative connector specs (auth, actions, triggers, webhooks).
--   - connector_versions: versioned connector manifests (auto-publish, deprecation).
--   - tool_fixtures: test fixtures for each tool (continuous sandbox testing).
--   - tool_usage_stats: per-tool usage analytics (calls, errors, latency, cost).
--   - agent_quality_scores: automated quality scoring for marketplace agents.
--   - connector_official: marks official connectors (Slack, GitHub, etc.).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- connectors — declarative connector specs.
-- ───────────────────────────────────────────────

create table connectors (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,           -- 'slack', 'github', 'gmail', etc.
  name            text not null,
  description     text not null,
  icon            text,                             -- icon URL or emoji.
  category        text not null,                    -- 'communication', 'devops', 'productivity', etc.
  auth_type       text not null check (auth_type in ('oauth2','api_key','basic','none')),
  auth_config     jsonb not null default '{}',     -- { oauth_scopes: [...], token_url: '...', authorize_url: '...' }.
  actions         jsonb not null default '[]',     -- [{ key, name, input_schema, output_schema, side_effect: bool }].
  triggers        jsonb not null default '[]',     -- [{ key, name, event_type, webhook_config }].
  rate_limit_per_min integer default 60,
  error_mapping  jsonb not null default '{}',     -- { 429: 'rate_limited', 500: 'provider_error' }.
  webhook_config  jsonb,                           -- { url, secret, events: [...] }.
  is_official     boolean not null default false,  -- official connectors (Slack, GitHub, etc.).
  publisher_org_id uuid,                           -- community connectors → developer org.
  publisher_name  text not null default 'Supa AI',
  status          text not null default 'active' check (status in ('active','deprecated','retired','pending_review')),
  current_version text not null default '1.0.0',
  auto_published  boolean not null default false,  -- true if auto-published (passed tests).
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_connectors_category on connectors (category, status);
create index idx_connectors_official on connectors (is_official, status) where is_official = true;

comment on table connectors is
  'global_system — declarative connector specs. Auto-published when tests pass. Auto-versioned. Auto-documented.';

-- ───────────────────────────────────────────────
-- connector_versions — versioned manifests.
-- ───────────────────────────────────────────────

create table connector_versions (
  id              uuid primary key default gen_random_uuid(),
  connector_id    uuid not null references connectors(id) on delete cascade,
  version         text not null,                  -- semver.
  manifest        jsonb not null,                  -- the full connector manifest at this version.
  changelog       text,
  status          text not null default 'active' check (status in ('active','deprecated','retired')),
  test_results    jsonb not null default '{}',   -- { passed: bool, tests_run: int, failures: [...] }.
  auto_published  boolean not null default false,
  published_at    timestamptz,
  deprecated_at   timestamptz,
  created_at      timestamptz not null default now(),
  unique (connector_id, version)
);

create index idx_connector_versions_connector on connector_versions (connector_id, version desc);

-- ───────────────────────────────────────────────
-- tool_fixtures — test fixtures for continuous sandbox testing.
-- ───────────────────────────────────────────────

create table tool_fixtures (
  id              uuid primary key default gen_random_uuid(),
  tool_key        text not null,                  -- references tool_registry.key.
  name            text not null,
  description     text,
  input           jsonb not null,                  -- the test input.
  expected_output jsonb,                           -- the expected output (or null for side-effect-only).
  tags            text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create index idx_tool_fixtures_tool on tool_fixtures (tool_key);

comment on table tool_fixtures is
  'global_system — tool test fixtures. Run continuously in the sandbox. Every tool ships with a fixture suite.';

-- ───────────────────────────────────────────────
-- tool_usage_stats — per-tool analytics.
-- ───────────────────────────────────────────────

create table tool_usage_stats (
  id              uuid primary key default gen_random_uuid(),
  tool_key        text not null,
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  total_calls     integer not null default 0,
  error_count     integer not null default 0,
  avg_latency_ms  numeric(10,2),
  p95_latency_ms  numeric(10,2),
  total_cost_usd  numeric(12,6) not null default 0,
  unique_callers  integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (tool_key, period_start)
);

create index idx_tool_usage_stats_tool on tool_usage_stats (tool_key, period_start desc);

comment on table tool_usage_stats is
  'global_system — per-tool analytics. Usage, error rates, latency, cost, unique callers.';

-- ───────────────────────────────────────────────
-- agent_quality_scores — automated quality scoring.
-- ───────────────────────────────────────────────

create table agent_quality_scores (
  id              uuid primary key default gen_random_uuid(),
  marketplace_item_id uuid not null references marketplace_items(id) on delete cascade,
  reliability_score   numeric(5,2) not null default 0,   -- 0-100 (fixture pass rate).
  safety_score        numeric(5,2) not null default 0,   -- 0-100 (permission/budget compliance).
  usefulness_score    numeric(5,2) not null default 0,   -- 0-100 (user ratings + install growth).
  overall_score       numeric(5,2) not null default 0,   -- weighted average.
  test_results     jsonb not null default '{}',         -- { fixtures_run, fixtures_passed, failures: [...] }.
  scored_at        timestamptz not null default now()
);

create index idx_agent_quality_item on agent_quality_scores (marketplace_item_id, scored_at desc);

comment on table agent_quality_scores is
  'global_system — automated agent quality scoring. Reliability + safety + usefulness. Drives discovery + trust.';

-- ───────────────────────────────────────────────
-- Seed official connectors.
-- ───────────────────────────────────────────────

insert into connectors (key, name, description, category, auth_type, is_official, publisher_name, actions, triggers) values
  ('slack',         'Slack',         'Send messages, create channels, manage Slack.', 'communication', 'oauth2', true, 'Supa AI',
    '[{"key":"send_message","name":"Send Message","input_schema":{"channel":"string","text":"string"},"output_schema":{"ok":"boolean","ts":"string"},"side_effect":true}]',
    '[{"key":"message_received","name":"Message Received","event_type":"slack.message"}]'),
  ('github',        'GitHub',        'Manage repos, issues, PRs, actions.', 'devops', 'oauth2', true, 'Supa AI',
    '[{"key":"create_issue","name":"Create Issue","input_schema":{"repo":"string","title":"string","body":"string"},"output_schema":{"number":"integer","url":"string"},"side_effect":true}]',
    '[{"key":"pr_opened","name":"PR Opened","event_type":"github.pull_request"}]'),
  ('gmail',         'Gmail',         'Send and read emails via Gmail.', 'communication', 'oauth2', true, 'Supa AI',
    '[{"key":"send_email","name":"Send Email","input_schema":{"to":"string","subject":"string","body":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('notion',        'Notion',        'Create and read Notion pages.', 'productivity', 'oauth2', true, 'Supa AI',
    '[{"key":"create_page","name":"Create Page","input_schema":{"parent":"string","title":"string"},"output_schema":{"id":"string","url":"string"},"side_effect":true}]',
    '[]'),
  ('google_workspace','Google Workspace','Calendar, Drive, Docs integration.', 'productivity', 'oauth2', true, 'Supa AI',
    '[{"key":"create_event","name":"Create Calendar Event","input_schema":{"calendar":"string","title":"string","start":"string","end":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('microsoft_365', 'Microsoft 365',  'Outlook, Teams, OneDrive integration.', 'productivity', 'oauth2', true, 'Supa AI',
    '[{"key":"send_email","name":"Send Email","input_schema":{"to":"string","subject":"string","body":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('hubspot',       'HubSpot',        'CRM contacts, deals, tickets.', 'crm', 'api_key', true, 'Supa AI',
    '[{"key":"create_contact","name":"Create Contact","input_schema":{"email":"string","firstname":"string","lastname":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('stripe',        'Stripe',         'Payments, subscriptions, invoices.', 'payments', 'api_key', true, 'Supa AI',
    '[{"key":"create_payment_link","name":"Create Payment Link","input_schema":{"amount":"integer","currency":"string"},"output_schema":{"url":"string"},"side_effect":true}]',
    '[{"key":"payment_succeeded","name":"Payment Succeeded","event_type":"stripe.payment"}]'),
  ('paystack',      'Paystack',       'African payments.', 'payments', 'api_key', true, 'Supa AI',
    '[{"key":"initialize_transaction","name":"Initialize Transaction","input_schema":{"amount":"integer","email":"string"},"output_schema":{"authorization_url":"string"},"side_effect":true}]',
    '[]'),
  ('flutterwave',   'Flutterwave',    'African payments.', 'payments', 'api_key', true, 'Supa AI',
    '[{"key":"initiate_payment","name":"Initiate Payment","input_schema":{"amount":"number","currency":"string"},"output_schema":{"link":"string"},"side_effect":true}]',
    '[]'),
  ('linear',        'Linear',         'Issues, projects, cycles.', 'devops', 'oauth2', true, 'Supa AI',
    '[{"key":"create_issue","name":"Create Issue","input_schema":{"team":"string","title":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('jira',          'Jira',           'Atlassian Jira issues + projects.', 'devops', 'oauth2', true, 'Supa AI',
    '[{"key":"create_issue","name":"Create Issue","input_schema":{"project":"string","summary":"string"},"output_schema":{"key":"string"},"side_effect":true}]',
    '[]'),
  ('trello',        'Trello',         'Boards, lists, cards.', 'productivity', 'api_key', true, 'Supa AI',
    '[{"key":"create_card","name":"Create Card","input_schema":{"list":"string","name":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('asana',         'Asana',          'Projects, tasks, sections.', 'productivity', 'oauth2', true, 'Supa AI',
    '[{"key":"create_task","name":"Create Task","input_schema":{"project":"string","name":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]'),
  ('discord',       'Discord',        'Send messages, manage channels.', 'communication', 'api_key', true, 'Supa AI',
    '[{"key":"send_message","name":"Send Message","input_schema":{"channel":"string","text":"string"},"output_schema":{"id":"string"},"side_effect":true}]',
    '[]')
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on connectors to supa_app;
grant select on connector_versions to supa_app;
grant select on tool_fixtures to supa_app;
grant select on tool_usage_stats to supa_app;
grant select on agent_quality_scores to supa_app;

grant select, insert, update, delete on connectors to supa_system;
grant select, insert, update, delete on connector_versions to supa_system;
grant select, insert, update, delete on tool_fixtures to supa_system;
grant select, insert, update, delete on tool_usage_stats to supa_system;
grant select, insert, update, delete on agent_quality_scores to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0058',
    'admin.phase14.connectors.created',
    jsonb_build_object('tables', array['connectors','connector_versions','tool_fixtures','tool_usage_stats','agent_quality_scores'], 'official_connectors', 15),
    'migration 0058 — Phase 14 autonomous connector SDK + tool enhancements',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
