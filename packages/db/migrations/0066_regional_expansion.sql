-- ───────────────────────────────────────────────
-- 0066_regional_expansion.sql
-- Regional Expansion Pipeline — tables backing the 9-stage playbook.
--
-- Tables:
--   - regional_market_data: per-region market indicators (population,
--     internet penetration, smartphone penetration, freelancer/SMB counts).
--   - regional_evaluation_queue: regions that crossed the detection
--     threshold and are queued for evaluation.
--   - regional_preparation_progress: per-region per-workstream step state.
--   - regional_signal_bundle: the 9 demand signal types per region.
--   - regional_optimization_log: optimization actions implemented per region.
--
-- Referenced by:
--   - lib/expansion/stage-detection.ts (detectDemandSignals, queueForEvaluation)
--   - lib/expansion/stage-evaluation.ts (evaluateMarketFit, etc.)
--   - lib/expansion/stage-prioritization.ts (computePriorityScore)
--   - lib/expansion/stage-preparation.ts (runWorkstream, isPreparationComplete)
--   - lib/expansion/stage-optimization.ts (identifyOptimizationOpportunities)
--   - lib/expansion/measurement-success.ts (measureRegionSuccess)
--   - API routes: POST /api/expansion/detection, /evaluation, /prioritization, etc.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- regional_market_data — per-region demographic + market indicators.
-- ───────────────────────────────────────────────

create table regional_market_data (
  region_code                 text primary key,            -- ISO 3166-1 alpha-2 ('NG', 'KE', 'ZA').
  region_name                 text not null,
  region_type                 text not null check (region_type in ('country', 'state', 'metro')),

  -- Demographics.
  population                  bigint,
  internet_penetration        numeric(5,2),                -- 0-100 (%).
  smartphone_penetration     numeric(5,2),                -- 0-100 (%).
  english_proficiency_score   numeric(3,1),                -- 0-10.

  -- Target segments.
  freelancer_population      bigint,
  smb_population             bigint,
  enterprise_presence        boolean default false,

  -- Competitive landscape.
  competitor_count           int default 0,
  competitor_names           text[] default '{}',

  -- Pricing power.
  median_arpu_usd            numeric(10,2),
  currency_code              text,                        -- 'NGN', 'KES', 'ZAR'.
  payment_method_penetration jsonb default '{}'::jsonb,   -- { 'card': 0.6, 'mobile_money': 0.8, ... }.

  updated_at                 timestamptz not null default now()
);

comment on table regional_market_data is
  'global_system — Per-region market indicators. Updated periodically by the detection cron.';

-- ───────────────────────────────────────────────
-- regional_evaluation_queue — regions queued for evaluation.
-- ───────────────────────────────────────────────

create table regional_evaluation_queue (
  id                    uuid primary key default gen_random_uuid(),
  region_code           text not null references regional_market_data(region_code),
  queued_at             timestamptz not null default now(),
  confidence_score      numeric(5,2) not null,            -- weighted demand signal score.
  signal_bundle         jsonb not null default '{}'::jsonb,
  status                text not null check (status in (
                          'queued', 'evaluating', 'evaluated',
                          'prioritized', 'preparing', 'preparing_blocked',
                          'verified', 'soft_launching', 'launched', 'monitored',
                          'optimizing', 'failed', 'retired'
                        )) default 'queued',
  priority_score       numeric(5,2),
  priority_rank        int,
  current_stage        text default 'detection',
  stage_updated_at     timestamptz not null default now()
);

create index idx_regional_eval_queue_status on regional_evaluation_queue (status, queued_at desc);
create index idx_regional_eval_queue_rank on regional_evaluation_queue (priority_rank) where priority_rank is not null;
create unique index uq_regional_eval_queue_region_unique on regional_evaluation_queue (region_code) where status <> 'retired';

comment on table regional_evaluation_queue is
  'global_system — Regions that crossed the detection threshold and are queued for evaluation. One active row per region (retired regions excluded from the unique constraint).';

-- ───────────────────────────────────────────────
-- regional_preparation_progress — per-region per-workstream step state.
-- ───────────────────────────────────────────────

create table regional_preparation_progress (
  id                    uuid primary key default gen_random_uuid(),
  region_code           text not null references regional_market_data(region_code),
  workstream            text not null check (workstream in (
                          'language', 'content', 'legal', 'tax', 'payments',
                          'infrastructure', 'support', 'marketing', 'cultural'
                        )),
  step_id               text not null,
  step_status           text not null check (step_status in (
                          'pending', 'in_progress', 'completed', 'skipped', 'failed'
                        )) default 'pending',
  completed_by          text,
  completed_at          timestamptz,
  notes                 text,
  unique (region_code, workstream, step_id)
);

create index idx_regional_prep_region on regional_preparation_progress (region_code, workstream);

comment on table regional_preparation_progress is
  'global_system — per-region per-workstream preparation step state. The 9 workstreams × N steps each drive the regional preparation stage.';

-- ───────────────────────────────────────────────
-- regional_optimization_log — optimization actions implemented per region.
-- ───────────────────────────────────────────────

create table regional_optimization_log (
  id                    uuid primary key default gen_random_uuid(),
  region_code           text not null references regional_market_data(region_code),
  area                  text not null check (area in (
                          'pricing', 'packaging', 'onboarding',
                          'support', 'growth', 'retention'
                        )),
  action                text not null,
  reason                text not null,
  implemented_by        text not null,
  implemented_at        timestamptz not null default now(),
  expected_impact       jsonb,                             -- { metric: 'arpu', delta: +5% }.
  observed_impact       jsonb,                             -- filled in after measurement.
  measured_at           timestamptz
);

create index idx_regional_opt_region on regional_optimization_log (region_code, implemented_at desc);

comment on table regional_optimization_log is
  'global_system — log of optimization actions implemented per region. Tracks expected vs observed impact.';
