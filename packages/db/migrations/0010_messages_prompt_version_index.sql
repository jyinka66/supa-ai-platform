-- ============ MESSAGES: prompt_version partial index ============
-- The `prompt_version` column already exists on `messages` (migration 0003).
-- This adds a partial index scoped to non-null values — the hot path for
-- the A/B test evaluation query (which filters `WHERE prompt_version IS NOT NULL`).
--
-- Postgres will use this index for:
--   - The daily cron's `GROUP BY prompt_version` query
--   - The admin metrics `promptPerf` query
--   - Any future "find messages by prompt version" lookup
--
-- Without the partial index, Postgres would scan the entire messages table
-- (which grows fast). With it, only non-null rows are indexed — typically
-- a small subset (user messages don't have a prompt_version).

-- Column already exists — just verify (idempotent check).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'messages'
      and column_name = 'prompt_version'
      and table_schema = 'public'
  ) then
    alter table public.messages add column prompt_version text;
  end if;
end $$;

-- Partial index — only non-null prompt_version rows.
create index if not exists idx_messages_prompt_version
  on public.messages (prompt_version)
  where prompt_version is not null;

comment on index public.idx_messages_prompt_version is
  'Partial index for A/B test evaluation queries. Only non-null prompt_version rows are indexed.';
