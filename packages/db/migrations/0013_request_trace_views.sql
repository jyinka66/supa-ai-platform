-- ============ REQUEST TRACE VIEW ============
-- Support-ticket lookup view: given a requestId, find the exact provider,
-- model, latency, token counts, cost, and fallback path for that request.
--
-- Usage:
--   select * from request_trace where request_id = '<uuid-from-ticket>';
--
-- This closes the support loop:
--   1. User reports "my reply was slow at 3pm"
--   2. Support finds the requestId from the client's network tab
--      (X-Request-Id response header) or from the user's session
--   3. Query this view → get exact provider, latency, cost, fallback path
--   4. If fallback_path is non-empty, the primary provider failed —
--      check failure_forensics for that provider's error pattern.

create or replace view request_trace as
select
  mm.request_id,
  mm.message_id,
  m.conversation_id,
  c.workspace_id,
  c.user_id,
  mm.provider,
  mm.model,
  m.prompt_version,
  mm.input_tokens,
  mm.output_tokens,
  mm.cost_usd,
  mm.latency_first_token_ms,
  mm.latency_total_ms,
  mm.retries,
  mm.fallback_path,
  m.status as message_status,
  m.content as message_content,  -- included for support debugging
  m.created_at
from message_meta mm
inner join messages m on m.id = mm.message_id
inner join conversations c on c.id = m.conversation_id
where mm.request_id is not null;

comment on view request_trace is
  'Support-ticket lookup: given a requestId, find the exact provider/latency/cost. Includes message content for debugging.';

-- ============ FAILURE FORENSICS: add request_id ============
-- Update the failure_forensics view to include request_id so failed
-- requests can be traced to specific HTTP requests.
create or replace view failure_forensics as
select
  mm.provider,
  date_trunc('hour', m.created_at)                     as hour,
  count(*)                                              as failures,
  count(*) filter (where mm.retries > 0)                as retried_failures,
  avg(mm.retries)                                       as avg_retries,
  array_agg(distinct mm.fallback_path)                  as observed_fallback_paths,
  array_agg(distinct m.conversation_id)                 as affected_conversation_ids,
  mm.request_id
from messages m
inner join message_meta mm on mm.message_id = m.id
where m.status = 'error'
  and m.created_at >= now() - interval '7 days'
group by 1, 2, 8;

comment on view failure_forensics is
  'Failed-message forensics: provider, request_id, hour, failure count, retry stats, fallback paths.';

-- ============ PROVIDER_STATS_DAILY: add request coverage ============
-- Update the provider_stats_daily view to include the percentage of
-- messages that have a request_id (should be 100% after this migration).
-- This is a data-quality check — if coverage drops, it means the
-- stream route isn't passing requestId to persistMessage().
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
                       and mm.fallback_path::text != '[]')             as fallback_count,
  count(*) filter (where mm.request_id is not null)                   as requests_with_trace_id,
  round(
    count(*) filter (where mm.request_id is not null)::numeric
    / nullif(count(*), 0) * 100,
    1
  )                                                                   as trace_id_coverage_pct
from message_meta mm
inner join messages m on m.id = mm.message_id
group by 1, 2;

comment on view provider_stats_daily is
  'Daily per-provider rollup: requests, tokens, cost, latency p95, retry/fallback counts, trace-ID coverage.';
