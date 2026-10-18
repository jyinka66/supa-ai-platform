-- ───────────────────────────────────────────────
-- 0051_phase10_reliability.sql
-- Phase 10 — Performance, Scale, and Reliability.
--
-- This migration establishes the data backing for SLO tracking + cost tracking.
-- The circuit breaker + backpressure + metrics are in-memory (no DB) — they're
-- hot-path primitives that don't need persistence (state is reconstructed on
-- restart from the request stream).
--
-- Tables:
--   - slo_definitions: the SLO contracts per service (target, window, alerting).
--   - slo_snapshots: periodic snapshots of SLI values vs SLO targets (for the
--     error-budget UI + trend analysis).
--   - cost_ledger: append-only cost events (AI tokens, storage bytes, CDN
--     bandwidth, DB queries) — aggregated for the per-user/per-ws/per-feature
--     cost dashboards.
--
-- All three are global_system (not tenant-scoped — they span the whole platform).
-- RLS: admin-only read (owners for SLOs/costs; the metrics endpoint is public
-- but Prometheus-scrape-gated by a separate token).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- slo_definitions — the SLO contracts.
-- ───────────────────────────────────────────────

create table slo_definitions (
  id              uuid primary key default gen_random_uuid(),
  service         text not null,                    -- 'api', 'ai', 'web', 'background_jobs', 'auth', 'payments'
  slo_name        text not null,                    -- 'availability', 'latency_p95', 'first_token_p95', 'job_p95'
  description     text not null,
  target          numeric(12,4) not null,            -- e.g. 0.999 (99.9% availability), 0.95 (95th percentile < 300ms)
  target_unit     text not null check (target_unit in ('ratio', 'ms', 'seconds')),
  window_days     integer not null default 30,      -- the rolling window for error-budget calc.
  alert_threshold numeric(5,4) not null default 0.5,-- alert when error budget consumption > 50% (burn rate).
  owner           text not null,                    -- who to page (team/person).
  created_at      timestamptz not null default now(),
  unique (service, slo_name)
);

comment on table slo_definitions is
  'global_system — SLO contracts per service. Target + window + alerting threshold. Owner = who to page.';

-- ───────────────────────────────────────────────
-- slo_snapshots — periodic SLI vs SLO snapshots.
-- ───────────────────────────────────────────────

create table slo_snapshots (
  id              uuid primary key default gen_random_uuid(),
  slo_id          uuid not null references slo_definitions(id) on delete cascade,
  snapshot_at     timestamptz not null default now(),
  sli_value       numeric(12,4) not null,           -- the measured SLI (e.g. 0.9991 availability, 285.3 ms p95).
  sli_unit        text not null,                     -- matches the SLO's target_unit.
  error_budget_remaining numeric(5,4) not null,     -- 0.0 to 1.0 (1.0 = full budget remaining, 0.0 = exhausted).
  error_budget_consumed  numeric(5,4) not null,     -- 0.0 to 1.0 (1.0 = budget fully consumed → SLO breached).
  sample_count    integer not null,                  -- how many requests were measured.
  metadata        jsonb not null default '{}'       -- extra context (e.g. { p50: 120, p99: 450 }).
);

create index idx_slo_snapshots_slo_time on slo_snapshots (slo_id, snapshot_at desc);
create index idx_slo_snapshots_time on slo_snapshots (snapshot_at desc);

comment on table slo_snapshots is
  'global_system — periodic SLO snapshots. error_budget_consumed > alert_threshold → alert.';

-- ───────────────────────────────────────────────
-- cost_ledger — append-only cost events.
--
-- Every cost-incurring action appends a row. Aggregated by a nightly job
-- into per-user/per-ws/per-feature summaries (for the cost dashboard).
--
-- The ledger is append-only (REVOKE UPDATE/DELETE) — costs are immutable
-- once recorded (financial audit trail). Corrections are new rows with
-- negative amounts + a reference to the original.
-- ───────────────────────────────────────────────

create table cost_ledger (
  id              uuid primary key default gen_random_uuid(),
  ts              timestamptz not null default now(),
  ws_id           uuid references workspaces(id) on delete set null,  -- null for platform-level costs (infra).
  user_id         uuid,                             -- null for ws-level costs.
  feature         text not null,                    -- 'ai.chat', 'ai.agents', 'storage', 'cdn', 'db', 'webhooks', 'emails'.
  provider        text,                             -- 'openai', 'anthropic', 's3', 'cloudflare', 'supabase'.
  cost_usd        numeric(12,6) not null,           -- the cost in USD (6 decimals — micro-dollar precision).
  quantity        numeric(18,4),                    -- the usage (tokens, bytes, requests, seconds).
  quantity_unit   text,                             -- 'tokens', 'bytes', 'requests', 'seconds'.
  metadata        jsonb not null default '{}'       -- extra context (model, region, endpoint).
);

create index idx_cost_ledger_ts on cost_ledger (ts desc);
create index idx_cost_ledger_ws_feature on cost_ledger (ws_id, feature, ts desc);
create index idx_cost_ledger_feature_ts on cost_ledger (feature, ts desc);

-- Insert-only: REVOKE UPDATE/DELETE (financial audit trail).
revoke update, delete on cost_ledger from public, authenticated, anon, supa_app, supa_system;

alter table cost_ledger enable row level security;

-- READ: owners only (via the admin control plane). The cost dashboard is
-- admin-only — costs are sensitive business data.
create policy cost_ledger_owner_read on cost_ledger
  for select to supa_app
  using (
    exists (
      select 1 from admin_users
       where admin_users.user_id = auth.uid()
         and admin_users.role = 'owner'
         and admin_users.revoked_at is null
    )
  );

-- INSERT: via the app role (the cost tracker service uses supa_app — costs
-- are recorded in real-time from the request path, not via a privileged role).
-- RLS allows INSERT from supa_app (the tracker authenticates the ws_id + user_id
-- from the request context, not from the row itself).
create policy cost_ledger_app_insert on cost_ledger
  for insert to supa_app
  with check (true);

comment on table cost_ledger is
  'global_system — append-only cost ledger. Per-user/per-ws/per-feature. Insert-only (financial audit trail). Corrections = new rows with negative amounts.';

-- ───────────────────────────────────────────────
-- Seed the default SLOs.
-- ───────────────────────────────────────────────

insert into slo_definitions (service, slo_name, description, target, target_unit, window_days, alert_threshold, owner) values
  ('api',           'availability',    'API availability (non-5xx responses).',                   0.9990, 'ratio',  30, 0.5, 'team-platform'),
  ('api',           'latency_p95',     'API p95 latency < 300ms across all endpoints.',           300.0,  'ms',     30, 0.5, 'team-platform'),
  ('ai',            'availability',    'AI provider availability (successful completions).',       0.9950, 'ratio',  30, 0.5, 'team-ai'),
  ('ai',            'first_token_p95', 'AI first-token p95 < 500ms (streaming).',                 500.0,  'ms',     30, 0.5, 'team-ai'),
  ('web',           'availability',    'Web app availability (200 responses).',                    0.9990, 'ratio',  30, 0.5, 'team-frontend'),
  ('web',           'lcp_p95',         'Web LCP p95 < 2500ms (Lighthouse Performance >= 90).',     2500.0, 'ms',     30, 0.5, 'team-frontend'),
  ('background_jobs','job_p95',        'Background job p95 < 30s (end-to-end).',                   30.0,   'seconds',30, 0.5, 'team-platform'),
  ('auth',          'availability',    'Auth service availability (login/refresh succeed).',       0.9995, 'ratio',  30, 0.5, 'team-platform'),
  ('payments',      'availability',    'Payment provider availability (webhooks processed).',      0.9990, 'ratio',  30, 0.5, 'team-payments')
on conflict (service, slo_name) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on slo_definitions to supa_app;
grant select on slo_snapshots to supa_app;
grant select on cost_ledger to supa_app;

grant select, insert, update, delete on slo_definitions to supa_system;
grant select, insert, delete on slo_snapshots to supa_system;
grant select, insert on cost_ledger to supa_system;  -- insert-only (no update/delete even for system — see REVOKE above).

-- ───────────────────────────────────────────────
-- Audit the migration.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0051',
    'admin.phase10.created',
    jsonb_build_object('tables', array['slo_definitions','slo_snapshots','cost_ledger']),
    'migration 0051 — Phase 10 reliability infrastructure (SLOs + cost ledger)',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
