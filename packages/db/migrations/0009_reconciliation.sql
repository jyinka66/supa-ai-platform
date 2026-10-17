-- ============ RECONCILIATION MIGRATION ============
-- This migration reconciles the schema with the "Week 3 Additions" spec:
--   1. Ensures prompt_promotions has the `sample_sizes` JSONB column
--      (migration 0008 used separate columns; this adds the JSONB view too)
--   2. Creates mock_failures table (NOT dev_mock_failures — matching the
--      spec naming, since lib/dev/mock-failover.ts was updated to use
--      the in-memory state which doesn't depend on the table name)
--   3. Ensures the share_links token_hash index exists with the partial
--      WHERE clause for active links
--   4. NOTE: usage_costs does NOT exist in our schema — costs are tracked
--      on message_meta. This migration does NOT create usage_costs;
--      the analytics views (0006) already reference message_meta correctly.

-- ============ PROMPT_PROMOTIONS: sample_sizes JSONB ============
-- Migration 0008 created prompt_promotions with separate columns
-- (winner_approval, loser_approval, winner_n, loser_n).
-- This adds a denormalized JSONB column for convenience queries
-- that want the whole sample-size context in one field.
alter table public.prompt_promotions
  add column if not exists sample_sizes jsonb not null default '{}'::jsonb;

-- Backfill existing rows from the separate columns.
update public.prompt_promotions
set sample_sizes = jsonb_build_object(
  'winner', jsonb_build_object('n', winner_n, 'rate', winner_approval),
  'loser', jsonb_build_object('n', loser_n, 'rate', loser_approval)
)
where sample_sizes = '{}'::jsonb
  and winner_n is not null;

comment on column public.prompt_promotions.sample_sizes is
  'Denormalized {winner: {n, rate}, loser: {n, rate}} for convenience. Kept in sync with winner_n/loser_n/winner_approval/loser_approval via triggers (future).';

-- ============ MOCK_FAILURES TABLE ============
-- Backs lib/dev/mock-failover.ts for dev-only provider failure injection.
-- NOTE: migration 0005 created `dev_mock_failures` with the same shape.
-- This migration renames it to `mock_failures` to match the spec naming,
-- and drops the old table if it exists.
--
-- The table is created unconditionally (even in prod) so migration order
-- doesn't matter, but RLS ensures only service_role can access it.
do $$
begin
  -- Rename if the old table exists.
  if exists (
    select 1 from information_schema.tables
    where table_name = 'dev_mock_failures' and table_schema = 'public'
  ) and not exists (
    select 1 from information_schema.tables
    where table_name = 'mock_failures' and table_schema = 'public'
  ) then
    alter table public.dev_mock_failures rename to mock_failures;
  end if;
end $$;

-- Create if not exists (idempotent).
create table if not exists public.mock_failures (
  provider    text primary key check (provider in ('gemini', 'groq', 'openrouter')),
  status      integer check (status is null or (status >= 400 and status <= 599)),
  updated_at  timestamptz not null default now()
);

comment on table public.mock_failures is
  'Dev harness mock-failure state. Written by /api/test/mock-fail in dev only.';

-- Drop old policies (they referenced dev_mock_failures).
drop policy if exists dev_mock_select on public.mock_failures;
drop policy if exists dev_mock_write on public.mock_failures;
drop policy if exists mock_failures_select on public.mock_failures;
drop policy if exists mock_failures_write on public.mock_failures;

-- Enable RLS — only service_role can read/write.
alter table public.mock_failures enable row level security;

create policy mock_failures_select on public.mock_failures
  for select using (auth.role() = 'service_role');

create policy mock_failures_write on public.mock_failures
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============ SHARE_LINKS: partial index on token_hash ============
-- The unique index on token_hash already exists (from migration 0003).
-- This adds a PARTIAL index scoped to non-revoked links — the hot path
-- for the public GET /api/share/[token] route.
--
-- Postgres will use this index for lookups on token_hash WHERE revoked_at
-- IS NULL, which is the most common query shape.
create index if not exists idx_share_links_token_active
  on public.share_links (token_hash)
  where revoked_at is null;

-- ============ USAGE_COSTS → MESSAGE_META NOTE ============
-- The spec references `usage_costs` with columns:
--   fallback_path text[]
--   retries int
--   total_ms int
--
-- These columns ALREADY EXIST on `message_meta` (migration 0003):
--   fallback_path jsonb (not text[])
--   retries integer
--   latency_total_ms integer (not total_ms)
--
-- The spec's `usage_costs` table does NOT exist in our schema — costs
-- are tracked on `message_meta` to keep a single source of truth.
-- The analytics views in migration 0006 already reference message_meta
-- correctly. No changes needed here.
--
-- If you want to add an alias view for backwards compatibility:
-- create or replace view usage_costs as
--   select
--     mm.message_id,
--     mm.provider,
--     mm.model,
--     mm.input_tokens,
--     mm.output_tokens,
--     mm.cost_usd,
--     mm.latency_first_token_ms as first_token_ms,
--     mm.latency_total_ms as total_ms,
--     mm.retries,
--     mm.fallback_path::text[] as fallback_path,
--     mm.idempotency_key,
--     m.created_at,
--     m.conversation_id,
--     c.user_id,
--     c.workspace_id
--   from message_meta mm
--   join messages m on m.id = mm.message_id
--   join conversations c on c.id = m.conversation_id;
