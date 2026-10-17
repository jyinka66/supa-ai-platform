-- ───────────────────────────────────────────────
-- 0059_phase14_templates_partners.sql
-- Phase 14 — Template Marketplace + Developer Sandbox + Embedded + Partner Integrations.
--
-- Tables:
--   - template_items: design/prompt/workflow/business templates.
--   - sandbox_workspaces: isolated developer sandboxes.
--   - embedded_surfaces: white-label embeddable surfaces.
--   - partner_integrations: bidirectional partner integrations.
--   - partner_tokens: encrypted OAuth tokens for partner integrations.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- template_items — all template types (separate from marketplace_items for type-specific fields).
-- ───────────────────────────────────────────────

create table template_items (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('design','prompt','workflow','business')),
  slug            text not null unique,
  title           text not null,
  description     text not null,
  author_org_id   uuid,
  author_name     text not null,
  version         text not null default '1.0.0',
  status          text not null default 'draft' check (status in ('draft','pending_review','published','suspended','taken_down')),
  -- Quality checks.
  schema_validated boolean not null default false,
  render_tested   boolean not null default false,
  safety_reviewed boolean not null default false,
  -- Auto-categorization.
  auto_category  text,                             -- auto-detected from content.
  industry_tags   text[] not null default '{}',    -- auto-detected from content.
  use_case_tags   text[] not null default '{}',
  -- Ratings + revenue.
  rating_avg      numeric(3,2) not null default 0,
  rating_count    integer not null default 0,
  install_count   integer not null default 0,
  revenue_share_pct numeric(5,2) not null default 70,
  is_premium      boolean not null default false,
  price_usd       numeric(10,2) not null default 0,
  -- Content.
  content         jsonb not null default '{}',    -- the template payload (schema-dependent).
  preview_image   text,
  -- Takedown.
  takedown_reason text,
  takedown_at     timestamptz,
  takedown_by     text,
  -- Featured.
  featured_score  numeric(5,2) not null default 0,  -- computed: 0.3*quality + 0.4*rating + 0.3*installs.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);

create index idx_template_items_kind_status on template_items (kind, status);
create index idx_template_items_featured on template_items (featured_score desc) where status = 'published';
create index idx_template_items_category on template_items (auto_category, status);
create index idx_template_items_tags on template_items using gin (industry_tags);

comment on table template_items is
  'global_system — template marketplace. Design/prompt/workflow/business templates. Auto-quality-checked, auto-categorized, featured, revenue-share, algorithmic takedowns.';

-- ───────────────────────────────────────────────
-- sandbox_workspaces — isolated developer sandboxes.
-- ───────────────────────────────────────────────

create table sandbox_workspaces (
  id              uuid primary key default gen_random_uuid(),
  developer_org_id uuid not null,
  ws_id           uuid references workspaces(id) on delete cascade,
  name            text not null,
  api_key_hash    text not null,                  -- hashed sandbox API key.
  -- Limits (generous free tier).
  rate_limit_per_min integer not null default 100,
  monthly_budget_usd numeric(10,2) not null default 10.0,
  max_tools       integer not null default 50,
  max_agents      integer not null default 10,
  -- Lifecycle.
  status          text not null default 'active' check (status in ('active','expired','converted','terminated')),
  expires_at      timestamptz not null,            -- 7-day TTL (renewable).
  converted_to_paid_at timestamptz,
  -- Usage tracking (for conversion prompts).
  total_api_calls integer not null default 0,
  total_cost_usd  numeric(12,6) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_sandbox_workspaces_org on sandbox_workspaces (developer_org_id, status);
create index idx_sandbox_workspaces_expires on sandbox_workspaces (expires_at) where status = 'active';

comment on table sandbox_workspaces is
  'global_system — developer sandboxes. Free tier, self-provisioned, isolated. 7-day TTL, generous limits, conversion prompts.';

-- ───────────────────────────────────────────────
-- embedded_surfaces — white-label embeddable surfaces.
-- ───────────────────────────────────────────────

create table embedded_surfaces (
  id              uuid primary key default gen_random_uuid(),
  partner_org_id  uuid not null,
  surface_type    text not null check (surface_type in ('chat','design','agents','full_app')),
  -- Branding.
  brand_name      text not null,
  brand_logo_url  text,
  brand_colors    jsonb not null default '{}',   -- { primary: '#...', accent: '#...' }.
  custom_domain   text,                           -- e.g. 'ai.acme.com'.
  -- Embedding config.
  allowed_origins text[] not null default '{}',   -- origin allowlist (contract-gated).
  embed_method    text not null default 'iframe' check (embed_method in ('iframe','sdk')),
  version_pinned  text not null default 'latest', -- version pinning.
  auto_update     boolean not null default false, -- auto-update within major version.
  -- Revenue model.
  revenue_model   text not null check (revenue_model in ('revenue_share','per_seat','usage_based')),
  revenue_config  jsonb not null default '{}',    -- { share_pct: 30, per_seat_price: 5.00, usage_rate: 0.001 }.
  -- Compliance.
  verified        boolean not null default false, -- automated compliance checks.
  -- Analytics (aggregated).
  total_embeds    integer not null default 0,
  total_revenue_usd numeric(12,2) not null default 0,
  status          text not null default 'pending' check (status in ('pending','active','suspended','terminated')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_embedded_surfaces_partner on embedded_surfaces (partner_org_id, status);
create index idx_embedded_surfaces_domain on embedded_surfaces (custom_domain) where custom_domain is not null;

comment on table embedded_surfaces is
  'global_system — white-label embedded surfaces. Chat/design/agents/full_app. Origin allowlisting, version pinning, partner analytics, automated compliance.';

-- ───────────────────────────────────────────────
-- partner_integrations — bidirectional integrations with partner systems.
-- ───────────────────────────────────────────────

create table partner_integrations (
  id              uuid primary key default gen_random_uuid(),
  connector_key   text not null,                  -- references connectors.key (e.g. 'slack', 'github').
  ws_id           uuid not null references workspaces(id) on delete cascade,
  -- Direction.
  direction       text not null check (direction in ('read','write','bidirectional')),
  -- OAuth (via Nango/Pipedream Connect).
  oauth_provider  text not null default 'nango',  -- 'nango' or 'pipedream'.
  oauth_connection_id text,                         -- the Nango/Pipedream connection ID.
  -- Auto-scoped permissions.
  requested_scopes text[] not null default '{}',  -- minimum scope per action.
  granted_scopes  text[] not null default '{}',
  -- Self-healing.
  circuit_open    boolean not null default false,
  last_error      text,
  last_error_at   timestamptz,
  retry_count     integer not null default 0,
  -- Analytics.
  total_calls     integer not null default 0,
  error_count     integer not null default 0,
  avg_latency_ms  numeric(10,2),
  -- Status.
  status          text not null default 'active' check (status in ('active','suspended','disconnected','error')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connector_key, ws_id)
);

create index idx_partner_integrations_ws on partner_integrations (ws_id, status);
create index idx_partner_integrations_connector on partner_integrations (connector_key, status);

comment on table partner_integrations is
  'global_system — bidirectional partner integrations. OAuth via Nango/Pipedream. Auto-scoped permissions. Self-healing (retry+circuit breaker). Auto-SDK bindings.';

-- ───────────────────────────────────────────────
-- partner_tokens — encrypted OAuth tokens (stored separately for security).
-- ───────────────────────────────────────────────

create table partner_tokens (
  id              uuid primary key default gen_random_uuid(),
  integration_id  uuid not null references partner_integrations(id) on delete cascade,
  access_token_enc text not null,                   -- AES-256-GCM encrypted.
  refresh_token_enc text,                           -- encrypted refresh token.
  expires_at      timestamptz,                     -- token expiry (auto-refresh before).
  scopes          text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_partner_tokens_integration on partner_tokens (integration_id);

comment on table partner_tokens is
  'global_system — encrypted OAuth tokens. AES-256-GCM. Auto-refresh before expiry. Never logged.';

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on template_items to supa_app;
grant select on sandbox_workspaces to supa_app;
grant select on embedded_surfaces to supa_app;
grant select on partner_integrations to supa_app;

grant select, insert, update, delete on template_items to supa_system;
grant select, insert, update, delete on sandbox_workspaces to supa_system;
grant select, insert, update, delete on embedded_surfaces to supa_system;
grant select, insert, update, delete on partner_integrations to supa_system;
grant select, insert, update, delete on partner_tokens to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0059',
    'admin.phase14.templates_partners.created',
    jsonb_build_object('tables', array['template_items','sandbox_workspaces','embedded_surfaces','partner_integrations','partner_tokens']),
    'migration 0059 — Phase 14 template marketplace + developer sandbox + embedded + partner integrations',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
