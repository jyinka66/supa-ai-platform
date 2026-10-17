-- ───────────────────────────────────────────────
-- 0068_governance_developer_reputation.sql
-- Developer reputation scores per dimension (5 dimensions).
--
-- Each developer has 5 reputation scores (0-100):
--   1. activity_reputation   — are they active + reliable?
--   2. financial_reputation  — do they pay on time + in full?
--   3. security_reputation  — have they had security incidents?
--   4. quality_reputation    — do their apps pass QA + have low bug rates?
--   5. community_reputation  — do they contribute (reviews, bug reports, etc.)?
--
-- Trust tier derived from mean score:
--   - trusted:      mean >= 70
--   - new:          30 <= mean < 70 (no track record yet)
--   - distrusted:   10 <= mean < 30
--   - banned:       mean < 10
--
-- Referenced by:
--   - lib/governance/reputation-trust.ts (getTrustTier)
--   - lib/governance/decision-engine.ts (actorReputation)
--   - lib/governance/governance-dashboards.ts (reputation distribution)
--   - API route: GET /api/governance/reputation-trust
-- ───────────────────────────────────────────────

create table governance_developer_reputation (
  id                            uuid primary key default gen_random_uuid(),
  developer_id                  text not null unique,            -- user_id or org_id.

  -- The 5 dimensions (each 0-100).
  activity_reputation           numeric(5,2) not null default 50,
  financial_reputation          numeric(5,2) not null default 50,
  security_reputation           numeric(5,2) not null default 50,
  quality_reputation            numeric(5,2) not null default 50,
  community_reputation          numeric(5,2) not null default 50,

  -- Derived tier (computed via trigger from the 5 scores).
  tier                          text not null check (tier in ('trusted', 'new', 'distrusted', 'banned')) default 'new',

  -- Audit.
  last_recomputed_at            timestamptz not null default now(),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create index idx_gov_dev_rep_tier on governance_developer_reputation (tier);

-- Trigger to recompute tier on any score change.
create or replace function recompute_developer_tier()
returns trigger as $$
declare
  v_mean numeric(5,2);
  v_tier text;
begin
  v_mean := (coalesce(new.activity_reputation, 0) + coalesce(new.financial_reputation, 0) +
             coalesce(new.security_reputation, 0) + coalesce(new.quality_reputation, 0) +
             coalesce(new.community_reputation, 0)) / 5;

  if v_mean >= 70 then v_tier := 'trusted';
  elsif v_mean >= 30 then v_tier := 'new';
  elsif v_mean >= 10 then v_tier := 'distrusted';
  else v_tier := 'banned';
  end if;

  new.tier := v_tier;
  new.last_recomputed_at := now();
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger trg_recompute_developer_tier
  before insert or update of activity_reputation, financial_reputation, security_reputation, quality_reputation, community_reputation
  on governance_developer_reputation
  for each row execute function recompute_developer_tier();

comment on table governance_developer_reputation is
  'global_system — per-developer reputation across 5 dimensions (activity, financial, security, quality, community). Tier auto-derived from mean: trusted (>=70), new (30-70), distrusted (10-30), banned (<10).';
