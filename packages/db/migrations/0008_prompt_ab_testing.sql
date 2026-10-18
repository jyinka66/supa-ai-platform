-- ============ PROMPT A/B TESTING TABLES ============
-- Tracks prompt versions + their promotion history so we can run
-- controlled experiments and measure approval rates per version.

-- ============ PROMPT_VERSIONS ============
-- One row per (mode, language, version) combination.
-- The `is_active` flag marks the current winner for each slot.
-- The cron job in lib/feedback/evaluate.ts promotes new winners.
create table if not exists public.prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  mode        text not null check (mode in ('chat','write','rewrite','summarize','translate','code','image','document','plan')),
  language    text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  version     text not null,  -- e.g. "chat-v3.2.1" — matches prompts/index.ts
  system      text not null, -- the actual system prompt text (for audit/reproducibility)
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (mode, language, version),
);

-- PostgreSQL supports partial unique indexes (not filtered table constraints).
create unique index if not exists prompt_versions_one_active_per_slot
  on public.prompt_versions(mode, language) where is_active = true;

comment on table public.prompt_versions is
  'Prompt A/B test registry. Each (mode, language) slot has at most one active version.';

-- ============ PROMPT_PROMOTIONS ============
-- Audit log of every promotion decision (who won, who lost, the z-score).
create table if not exists public.prompt_promotions (
  id              uuid primary key default gen_random_uuid(),
  slot            text not null,  -- e.g. "chat:en" — mode + language
  winner_version  text not null,
  loser_version   text not null,
  z_score         numeric(10,6) not null,
  winner_approval numeric(5,4),
  loser_approval  numeric(5,4),
  winner_n        integer,
  loser_n         integer,
  decided_at      timestamptz not null default now()
);

create index if not exists idx_prompt_promotions_slot
  on public.prompt_promotions(slot, decided_at desc);

comment on table public.prompt_promotions is
  'Audit log of A/B promotion decisions — who won, who lost, and the statistical evidence.';

-- ============ RLS ============
-- Only service_role can read/write these tables (admin-only).
alter table public.prompt_versions enable row level security;
alter table public.prompt_promotions enable row level security;

drop policy if exists prompt_versions_select on public.prompt_versions;
drop policy if exists prompt_versions_write on public.prompt_versions;
drop policy if exists prompt_promotions_select on public.prompt_promotions;
drop policy if exists prompt_promotions_write on public.prompt_promotions;

create policy prompt_versions_select on public.prompt_versions
  for select using (auth.role() = 'service_role');
create policy prompt_versions_write on public.prompt_versions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy prompt_promotions_select on public.prompt_promotions
  for select using (auth.role() = 'service_role');
create policy prompt_promotions_write on public.prompt_promotions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
