-- ============ ANALYTICS VIEWS ============
-- Rollup views for the admin metrics dashboard.
-- Each view is a thin SQL layer over the chat core tables (migration 0003)
-- + the message_meta table. Designed for read-heavy dashboards — query
-- these from the admin UI, not from per-request code paths.

-- ============ PROVIDER_STATS_DAILY ============
-- Per-provider daily rollup: requests, tokens, cost, latency percentiles,
-- retry/fallback counts. Used by the admin "Provider Health" dashboard.
--
-- Joins message_meta → messages → conversations so we can scope by
-- workspace_id when needed (the view itself doesn't filter by workspace;
-- callers add WHERE workspace_id = ... when scoping).
create or replace view provider_stats_daily as
select
  date_trunc('day', m.created_at)                                     as day,
  mm.provider,
  count(*)                                                            as requests,
  coalesce(sum(mm.output_tokens), 0)                                 as output_tokens,
  coalesce(sum(mm.input_tokens), 0)                                   as input_tokens,
  round(coalesce(sum(mm.cost_usd), 0)::numeric, 4)                    as cost_usd,
  round(avg(mm.latency_first_token_ms)::numeric, 0)                   as avg_ttfb_ms,
  percentile_disc(0.95) within group (order by mm.latency_first_token_ms) as p95_ttfb_ms,
  percentile_disc(0.95) within group (order by mm.latency_total_ms)       as p95_total_ms,
  count(*) filter (where mm.retries > 0)                              as retry_count,
  count(*) filter (where mm.fallback_path != '[]'::jsonb
                       and mm.fallback_path::text != '[]')             as fallback_count
from message_meta mm
inner join messages m on m.id = mm.message_id
group by 1, 2;

comment on view provider_stats_daily is
  'Daily per-provider rollup: requests, tokens, cost, latency p95, retry/fallback counts.';

-- ============ WORKSPACE_BUDGET_BURN ============
-- Per-scope budget burn with month-to-date spend, % used, and projected
-- 30-day spend based on the 7-day daily average.
--
-- The LATERAL join aggregates spend per budget row, scoped by either
-- user_id or workspace_id depending on the budget's scope_type.
create or replace view workspace_budget_burn as
select
  b.id                  as budget_id,
  b.scope_type,
  b.scope_id,
  b.cost_limit_usd,
  b.alert_threshold,
  coalesce(spend.mtd_usd, 0)                                                         as mtd_usd,
  round((coalesce(spend.mtd_usd, 0) / nullif(b.cost_limit_usd, 0) * 100)::numeric, 1) as pct_used,
  coalesce(spend.daily_avg, 0) * 30                                                  as projected_30d_usd,
  case
    when coalesce(spend.mtd_usd, 0) >= b.cost_limit_usd then 'exceeded'
    when coalesce(spend.mtd_usd, 0) >= b.cost_limit_usd * b.alert_threshold then 'alert'
    else 'ok'
  end                                                                                as status
from usage_budgets b
left join lateral (
  select
    sum(mm.cost_usd) filter (
      where m.created_at >= date_trunc('month', now())
    ) as mtd_usd,
    sum(mm.cost_usd) filter (
      where m.created_at >= now() - interval '7 days'
    ) / nullif(7.0, 0) as daily_avg
  from message_meta mm
  inner join messages m on m.id = mm.message_id
  inner join conversations c on c.id = m.conversation_id
  where (b.scope_type = 'user'      and c.user_id = b.scope_id)
     or (b.scope_type = 'workspace' and c.workspace_id = b.scope_id)
) spend on true;

comment on view workspace_budget_burn is
  'Per-scope budget burn: MTD spend, % used, projected 30-day spend, status.';

-- ============ FAILURE_FORENSICS ============
-- Failed-message forensics: which provider, which hour, how often, and what
-- fallback paths were observed. Used by the admin "Failure Analysis" dashboard.
--
-- NOTE: our schema doesn't have an `error_code` column on `messages` —
-- the error code is inferred from `message_meta.fallback_path` (the list of
-- providers that were tried before success/failure) and `messages.status`.
-- If you need granular error codes (e.g. 429 vs 500 vs ECONNRESET), add an
-- `error_code text` column to `message_meta` in a future migration.
create or replace view failure_forensics as
select
  mm.provider,
  date_trunc('hour', m.created_at)                     as hour,
  count(*)                                              as failures,
  count(*) filter (where mm.retries > 0)                as retried_failures,
  avg(mm.retries)                                       as avg_retries,
  array_agg(distinct mm.fallback_path)                  as observed_fallback_paths,
  -- Extract the conversation IDs so admins can click through to the
  -- actual failed conversations for debugging.
  array_agg(distinct m.conversation_id)                 as affected_conversation_ids
from messages m
inner join message_meta mm on mm.message_id = m.id
where m.status = 'error'
  and m.created_at >= now() - interval '7 days'
group by 1, 2;

comment on view failure_forensics is
  'Failed-message forensics: provider, hour, failure count, retry stats, fallback paths.';

-- ============ CONVERSATION_ACTIVITY_HOURLY ============
-- Hourly conversation + message counts, used by the "Activity" dashboard.
-- Filters out system messages (role = 'system') so the count reflects
-- user-visible activity only.
create or replace view conversation_activity_hourly as
select
  date_trunc('hour', m.created_at)       as hour,
  c.workspace_id,
  count(distinct m.conversation_id)       as active_conversations,
  count(*) filter (where m.role = 'user')      as user_messages,
  count(*) filter (where m.role = 'assistant' and m.status = 'completed') as successful_responses,
  count(*) filter (where m.role = 'assistant' and m.status = 'error')     as failed_responses,
  count(*) filter (where m.role = 'assistant' and m.status = 'aborted')  as aborted_responses
from messages m
inner join conversations c on c.id = m.conversation_id
where m.role != 'system'
  and m.created_at >= now() - interval '7 days'
group by 1, 2;

comment on view conversation_activity_hourly is
  'Hourly activity per workspace: active conversations, message counts by status.';

-- ============ SHARE_LINK_USAGE ============
-- Active vs expired share links, grouped by conversation.
-- Useful for auditing external access patterns.
create or replace view share_link_usage as
select
  c.id                       as conversation_id,
  c.workspace_id,
  c.title,
  count(sl.id)               as total_links,
  count(sl.id) filter (where sl.revoked_at is not null)    as revoked_links,
  count(sl.id) filter (where sl.revoked_at is null
                            and sl.expires_at > now())     as active_links,
  count(sl.id) filter (where sl.expires_at <= now())       as expired_links,
  max(sl.created_at)         as last_link_created_at
from conversations c
left join share_links sl on sl.conversation_id = c.id
group by 1, 2, 3;

comment on view share_link_usage is
  'Share-link audit: active, revoked, expired links per conversation.';
