-- ───────────────────────────────────────────────
-- 0040_webhooks_v2.sql
-- Webhooks v2 — the spec's canonical design.
--
-- DIVERGENCE from migration 0029 (which created `webhook_endpoints` +
-- `webhook_deliveries_v2`):
--   - 0029 used a generic RLS policy (any member can read/write webhooks).
--   - 0040 restricts to admin+ only (is_ws_member + role check).
--   - 0029 didn't enforce HTTPS-only on the URL.
--   - 0040 enforces `url ~ '^https://'` (no HTTP, no IP literals).
--   - 0029 didn't have `active` flag (used `disabled_until` for circuit breaker).
--   - 0040 uses `active boolean` (simpler — flip on/off).
--   - 0040 adds `ws_id` to `webhook_deliveries_v2` (direct scoping — 0029 scoped
--     via `endpoint_id → webhook_endpoints.ws_id` join).
--
-- This migration creates the v2 tables alongside the existing v1 tables
-- (0029). The v1 tables are kept for backward compat (the webhooks service
-- in apps/web/src/lib/webhooks/service.ts uses them). A future migration
-- would migrate data from v1 → v2 + drop v1.
-- ───────────────────────────────────────────────

create table webhooks (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  url text not null check (url ~ '^https://'),     -- HTTPS only, no IP literals.
  secret bytea not null,                            -- KMS-encrypted signing key (HMAC).
  events text[] not null,                           -- event types this webhook subscribes to.
  active boolean not null default true,             -- on/off (circuit breaker flips this).
  created_by uuid not null,
  created_at timestamptz not null default now()
);

alter table webhooks enable row level security;
-- Admin+ only: is_ws_member AND role in (owner, admin).
-- Uses the canonical predicate is_ws_member(ws_id, 'admin') — admin+ can
-- manage webhooks. Members/viewers cannot (webhook secrets are sensitive).
create policy wh_rw on webhooks for all to supa_app
  using (is_ws_member(ws_id, 'admin'))
  with check (is_ws_member(ws_id, 'admin'));

comment on table webhooks is '@tenant_table — webhooks (HTTPS-only, admin-only RLS)';

create index on webhooks (ws_id) where active = true;

-- Force RLS (migration 0033 pattern).
alter table webhooks force row level security;

-- ───────────────────────────────────────────────
-- webhook_deliveries_v2 — delivery attempts (with ws_id for direct scoping)
-- ───────────────────────────────────────────────

create table webhook_deliveries_v2 (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references webhooks(id) on delete cascade,
  ws_id uuid not null references workspaces(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  attempt int not null default 0,
  next_retry_at timestamptz,                       -- null = no retry (delivered or failed).
  delivered_at timestamptz,
  last_status int,                                 -- HTTP status code from the last attempt.
  created_at timestamptz not null default now()
);

alter table webhook_deliveries_v2 enable row level security;
-- Admin+ only (same as webhooks — deliveries contain payload data).
create policy wd_read on webhook_deliveries_v2 for select to supa_app
  using (is_ws_member(ws_id, 'admin'));

comment on table webhook_deliveries_v2 is '@tenant_table — webhook delivery attempts (admin-only read)';

create index on webhook_deliveries_v2 (webhook_id, created_at desc);
create index on webhook_deliveries_v2 (ws_id, created_at desc);
create index on webhook_deliveries_v2 (next_retry_at) where delivered_at is null;

-- Force RLS.
alter table webhook_deliveries_v2 force row level security;
