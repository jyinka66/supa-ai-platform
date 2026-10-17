-- ───────────────────────────────────────────────
-- 0054_phase11_support_regional.sql
-- Phase 11 — Autonomous Support Readiness + Regionalization.
--
-- Tables:
--   - support_tickets: user support tickets with SLA tracking + escalation.
--   - support_macros: localized pre-written responses for common issues.
--   - csat_surveys: customer satisfaction surveys per ticket.
--   - regional_config: per-region configuration (language, currency, tax, legal, payments, support hours).
--   - regional_pricing: purchasing power parity pricing per region.
--
-- All are global_system (support + regional config span the whole platform).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- support_tickets — user support tickets with SLA tracking.
-- ───────────────────────────────────────────────

create table support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ws_id           uuid references workspaces(id) on delete set null,  -- null for non-workspace users.
  user_id         uuid not null,
  user_email      text not null,                         -- for email-based support.
  user_locale     text not null references locales(code), -- the user's language (for localized responses).
  user_plan       text not null default 'free',           -- determines the SLA.
  user_region     text,                                   -- the user's region (for support hours routing).
  subject         text not null,
  body            text not null,
  category        text,                                   -- 'billing', 'technical', 'account', 'feature', 'bug', 'other'.
  severity        text not null default 'normal' check (severity in ('low','normal','high','urgent','critical')),
  status          text not null default 'open' check (status in ('open','pending','resolved','closed','escalated')),
  priority        integer not null default 0,             -- computed from severity + age (for queue ordering).
  assigned_to     uuid,                                   -- the support agent assigned.
  sla_deadline    timestamptz not null,                   -- computed from plan SLA + creation time.
  sla_breached    boolean not null default false,
  first_response_at timestamptz,                          -- when the first reply was sent.
  resolved_at     timestamptz,
  closed_at       timestamptz,
  triage_result   jsonb,                                  -- the AI triage output (category, confidence, suggested_macro, auto_answered).
  csat_score      integer,                                -- 1-5 (null = not yet surveyed).
  csat_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_support_tickets_status_priority on support_tickets (status, priority desc, created_at);
create index idx_support_tickets_sla on support_tickets (sla_deadline) where status in ('open','pending') and sla_breached = false;
create index idx_support_tickets_user on support_tickets (user_id, created_at desc);
create index idx_support_tickets_assigned on support_tickets (assigned_to, status);

comment on table support_tickets is
  'global_system — support tickets with SLA tracking (Free 48h, Pro 24h, Business 8h, Enterprise 1h). AI triage + escalation.';

-- ───────────────────────────────────────────────
-- support_macros — localized pre-written responses.
-- ───────────────────────────────────────────────

create table support_macros (
  id              uuid primary key default gen_random_uuid(),
  key             text not null,                         -- the macro identifier (e.g. 'password_reset', 'billing_refund').
  locale          text not null references locales(code),
  title           text not null,                         -- the macro title (for the agent UI).
  body            text not null,                         -- the response text (with {{placeholders}}).
  category        text not null,                          -- matches ticket categories.
  active          boolean not null default true,
  usage_count     integer not null default 0,             -- how many times used (for ranking).
  helpful_yes     integer not null default 0,
  helpful_no      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (key, locale)
);

create index idx_support_macros_category_locale on support_macros (category, locale, active);

comment on table support_macros is
  'global_system — localized support macros. Human agents use pre-written, localized responses for common issues.';

-- ───────────────────────────────────────────────
-- csat_surveys — customer satisfaction surveys.
-- ───────────────────────────────────────────────

create table csat_surveys (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references support_tickets(id) on delete cascade,
  user_id         uuid not null,
  score           integer not null check (score between 1 and 5),
  comment         text,
  submitted_at    timestamptz not null default now(),
  unique (ticket_id)
);

create index idx_csat_surveys_submitted on csat_surveys (submitted_at desc);

comment on table csat_surveys is
  'global_system — CSAT surveys. Every ticket followed by a satisfaction survey (1-5).';

-- ───────────────────────────────────────────────
-- regional_config — per-region configuration template.
-- ───────────────────────────────────────────────

create table regional_config (
  region_code     text primary key,                       -- 'us', 'eu', 'apac', 'af', 'sa', 'me'.
  display_name    text not null,                           -- 'United States', 'European Union', etc.
  default_locale  text not null references locales(code),
  default_currency text not null,                          -- 'USD', 'EUR', etc.
  default_timezone text not null,                          -- 'America/New_York', 'Europe/Paris', etc.
  tax_rule        text not null default 'standard' check (tax_rule in ('standard','vat','gst','consumption','none')),
  tax_rate        numeric(5,4) not null default 0,          -- default tax rate (0.0000 to 1.0000).
  legal_jurisdiction text not null default 'global',       -- links to legal_documents.jurisdiction.
  support_hours   jsonb not null default '{}',             -- { mon: '09:00-17:00', ... } in the region's timezone.
  support_languages text[] not null default '{}',         -- locales supported for support in this region.
  payment_methods text[] not null default '{}',            -- ['card', 'paypal', 'sepa', 'pix', 'mpesa', ...].
  data_residency  text not null default 'us-east',         -- the region's data residency cluster.
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table regional_config is
  'global_system — regional playbook template. Every region configured from this: language, currency, tax, legal, payments, support hours, data residency.';

-- ───────────────────────────────────────────────
-- regional_pricing — purchasing power parity pricing.
-- ───────────────────────────────────────────────

create table regional_pricing (
  id              uuid primary key default gen_random_uuid(),
  region_code     text not null references regional_config(region_code) on delete cascade,
  plan            text not null check (plan in ('free','pro','business','enterprise')),
  price_usd       numeric(10,2) not null,                  -- the base price in USD.
  local_currency  text not null,                            -- the local currency code.
  local_price     numeric(10,2) not null,                   -- the PPP-adjusted price in local currency.
  ppp_factor      numeric(5,3) not null,                    -- the PPP multiplier (1.000 = parity, <1 = cheaper, >1 = more expensive).
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (region_code, plan)
);

comment on table regional_pricing is
  'global_system — regional pricing with purchasing power parity. Cheaper in lower-income regions.';

-- ───────────────────────────────────────────────
-- Seed the regional configs (6 regions).
-- ───────────────────────────────────────────────

insert into regional_config (region_code, display_name, default_locale, default_currency, default_timezone, tax_rule, tax_rate, legal_jurisdiction, support_hours, support_languages, payment_methods, data_residency) values
  ('us',   'United States',       'en', 'USD', 'America/New_York',    'standard',    0.0000, 'us',   '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                   '{en,es}', '{card,paypal,apple_pay,google_pay}',               'us-east'),
  ('eu',   'European Union',      'en', 'EUR', 'Europe/Paris',         'vat',         0.2000, 'eu',   '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                   '{en,fr,de,es}', '{card,paypal,sepa,ideal,apple_pay,google_pay}',  'eu-west'),
  ('uk',   'United Kingdom',      'en', 'GBP', 'Europe/London',        'vat',         0.2000, 'uk',   '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                   '{en}', '{card,paypal,apple_pay,google_pay}',               'eu-west'),
  ('apac', 'Asia-Pacific',        'en', 'USD', 'Asia/Singapore',        'gst',         0.0800, 'global','{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                  '{en,ja,ko,zh,hi}', '{card,paypal,alipay,wechat_pay,apple_pay}',  'ap-southeast'),
  ('af',   'Africa',              'en', 'USD', 'Africa/Lagos',         'vat',         0.0750, 'global','{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                  '{en,sw,ha,yo}', '{card,mpesa,paystack,flutterwave}',              'eu-west'),
  ('sa',   'South America',       'es', 'USD', 'America/Sao_Paulo',    'consumption', 0.1700, 'global','{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00"}',                  '{es,pt}', '{card,paypal,pix,apple_pay}',                     'us-east')
on conflict (region_code) do nothing;

-- Seed PPP pricing (pro plan example).
insert into regional_pricing (region_code, plan, price_usd, local_currency, local_price, ppp_factor) values
  ('us',   'pro', 20.00, 'USD', 20.00, 1.000),
  ('eu',   'pro', 20.00, 'EUR', 18.00, 0.900),
  ('uk',   'pro', 20.00, 'GBP', 16.00, 0.800),
  ('apac', 'pro', 20.00, 'USD', 15.00, 0.750),
  ('af',   'pro', 20.00, 'USD', 8.00,  0.400),
  ('sa',   'pro', 20.00, 'USD', 10.00, 0.500)
on conflict (region_code, plan) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on support_tickets to supa_app;
grant select on support_macros to supa_app;
grant select on csat_surveys to supa_app;
grant select on regional_config to supa_app;
grant select on regional_pricing to supa_app;

grant select, insert, update, delete on support_tickets to supa_system;
grant select, insert, update, delete on support_macros to supa_system;
grant select, insert, update, delete on csat_surveys to supa_system;
grant select, insert, update, delete on regional_config to supa_system;
grant select, insert, update, delete on regional_pricing to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0054',
    'admin.phase11.support_regional.created',
    jsonb_build_object('tables', array['support_tickets','support_macros','csat_surveys','regional_config','regional_pricing'], 'regions', 6),
    'migration 0054 — Phase 11 autonomous support readiness + regionalization',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
