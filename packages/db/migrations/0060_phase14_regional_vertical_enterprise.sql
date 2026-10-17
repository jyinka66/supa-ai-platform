-- ───────────────────────────────────────────────
-- 0060_phase14_regional_vertical_enterprise.sql
-- Phase 14 — Regional Expansion + Vertical Editions + Enterprise Editions.
--
-- Tables:
--   - regional_playbooks: regional activation templates (languages, payments, tax, compliance, infra).
--   - vertical_configs: vertical playbook configurations (prompts, agents, connectors, compliance, pricing).
--   - enterprise_licenses: license keys for self-hosted installs.
--   - enterprise_slas: custom SLA terms per customer.
--   - compliance_evidence: automated SOC2/HIPAA/GDPR evidence collection.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- regional_playbooks — regional activation templates.
-- ───────────────────────────────────────────────

create table regional_playbooks (
  id              uuid primary key default gen_random_uuid(),
  region_code     text not null unique,              -- 'us', 'eu', 'apac', 'af', 'sa', 'me'.
  display_name    text not null,
  -- Template configuration.
  languages       text[] not null default '{}',      -- locales supported in this region.
  currencies      text[] not null default '{}',      -- accepted currencies.
  payment_methods text[] not null default '{}',      -- local payment methods.
  tax_rules      jsonb not null default '{}',       -- { type: 'vat', rate: 0.20, ... }.
  compliance_rules jsonb not null default '{}',      -- { gdpr: true, lgpd: false, ... }.
  infra_config   jsonb not null default '{}',       -- { regions: ['eu-west'], data_residency: 'eu-west' }.
  content_config jsonb not null default '{}',       -- { landing_page: true, pricing_page: true }.
  support_config jsonb not null default '{}',       -- { hours: {...}, languages: [...] }.
  -- Activation status.
  status          text not null default 'template' check (status in ('template','activating','active','deactivating','inactive')),
  activated_at    timestamptz,
  -- Threshold-based activation.
  usage_threshold integer not null default 1000,    -- users from this region → auto-activate.
  current_usage   integer not null default 0,
  threshold_met   boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_regional_playbooks_status on regional_playbooks (status);

comment on table regional_playbooks is
  'global_system — regional playbooks. Every region configured from a template. Self-serve activation when usage crosses threshold.';

-- ───────────────────────────────────────────────
-- vertical_configs — vertical playbook configurations.
-- ───────────────────────────────────────────────

create table vertical_configs (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,               -- 'legal', 'healthcare', etc.
  name            text not null,
  description     text not null,
  -- Playbook components.
  prompt_ids      text[] not null default '{}',       -- domain-specific system prompts.
  agent_templates jsonb not null default '[]',        -- [{ key, name, system_prompt, tools, budget }] 
  connector_keys  text[] not null default '{}',       -- required connectors.
  template_slugs   text[] not null default '{}',      -- marketplace templates for this vertical.
  compliance_rules jsonb not null default '{}',       -- { hipaa: true, gdpr: true, ... }.
  pricing_config  jsonb not null default '{}',        -- { base_price: 99, per_seat: 15, features: [...] }.
  marketing_config jsonb not null default '{}',       -- { landing_page: true, use_cases: [...] }.
  -- QA + launch.
  status          text not null default 'draft' check (status in ('draft','assembling','qa','reviewing','published','deprecated')),
  qa_results      jsonb,                               -- { tests_run, tests_passed, failures: [...] }.
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  published_at    timestamptz,
  -- Analytics (aggregated).
  total_workspaces integer not null default 0,
  total_revenue_usd numeric(12,2) not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_vertical_configs_status on vertical_configs (status);

comment on table vertical_configs is
  'global_system — vertical playbook configurations. Assembled by the platform from a playbook + domain-specific inputs.';

-- ───────────────────────────────────────────────
-- enterprise_licenses — license keys for self-hosted.
-- ───────────────────────────────────────────────

create table enterprise_licenses (
  id              uuid primary key default gen_random_uuid(),
  license_key_hash text not null unique,              -- SHA-256 of the license key (raw key never stored).
  ws_id           uuid not null references workspaces(id) on delete cascade,
  deployment_id   uuid references enterprise_deployments(id) on delete set null,
  -- Entitlements.
  edition         text not null check (edition in ('standard','enterprise','enterprise_plus')),
  max_seats       integer not null default 50,
  max_api_calls_per_day integer not null default 100000,
  features        text[] not null default '{}',        -- enabled feature flags.
  expires_at      timestamptz,                         -- null = perpetual.
  -- Status.
  status          text not null default 'active' check (status in ('active','expired','suspended','revoked')),
  last_verified_at timestamptz,                        -- last entitlement check.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_enterprise_licenses_ws on enterprise_licenses (ws_id, status);

comment on table enterprise_licenses is
  'global_system — enterprise license keys. Entitlement checks for self-hosted installs. SHA-256 hashed.';

-- ───────────────────────────────────────────────
-- enterprise_slas — custom SLA terms per customer.
-- ───────────────────────────────────────────────

create table enterprise_slas (
  id              uuid primary key default gen_random_uuid(),
  ws_id           uuid not null references workspaces(id) on delete cascade,
  -- SLA terms.
  uptime_target   numeric(5,4) not null default 0.9999,  -- 99.99% uptime.
  response_time_p95_ms integer not null default 300,      -- p95 response time.
  support_response_time_hrs integer not null default 1,   -- support response within 1h.
  resolution_time_hrs integer not null default 4,         -- resolution within 4h.
  -- Monitoring.
  current_uptime  numeric(5,4) not null default 1.0,
  current_p95_ms  integer,
  last_incident_at timestamptz,
  -- Credit policy (SLA breach → service credits).
  credit_policy   jsonb not null default '{}',            -- { breach_pct: 10, max_credit_pct: 50 }.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_enterprise_slas_ws on enterprise_slas (ws_id);

comment on table enterprise_slas is
  'global_system — custom SLA terms per customer. Monitored automatically. Breach → service credits.';

-- ───────────────────────────────────────────────
-- compliance_evidence — automated compliance evidence collection.
-- ───────────────────────────────────────────────

create table compliance_evidence (
  id              uuid primary key default gen_random_uuid(),
  ws_id           uuid,                                -- null for platform-level evidence.
  framework       text not null check (framework in ('soc2','hipaa','gdpr','iso27001','pci_dss','fedramp')),
  control_id      text not null,                       -- e.g. 'CC6.1', '164.312(a)(1)'.
  evidence_type   text not null check (evidence_type in ('config','log','screenshot','report','test_result')),
  evidence_data   jsonb not null,                      -- the evidence payload.
  collected_at    timestamptz not null default now(),
  collected_by    text not null default 'system',     -- 'system' (automated) or admin id.
  -- Verification.
  verified        boolean not null default false,
  verified_at     timestamptz,
  expires_at      timestamptz                          -- evidence may need re-collection.
);

create index idx_compliance_evidence_ws on compliance_evidence (ws_id, framework);
create index idx_compliance_evidence_framework on compliance_evidence (framework, control_id);

comment on table compliance_evidence is
  'global_system — automated compliance evidence. SOC2/HIPAA/GDPR/ISO27001/PCI DSS/FedRAMP. Auto-collected, verified, expiring.';

-- ───────────────────────────────────────────────
-- Seed regional playbooks.
-- ───────────────────────────────────────────────

insert into regional_playbooks (region_code, display_name, languages, currencies, payment_methods, tax_rules, compliance_rules, infra_config, content_config, support_config, status, usage_threshold) values
  ('us', 'United States', '{en,es}', '{USD}', '{card,paypal,apple_pay,google_pay}',
    '{"type":"standard","rate":0}', '{"ccpa":true}',
    '{"regions":["us-east"],"data_residency":"us-east"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["en","es"]}',
    'active', 0),
  ('eu', 'European Union', '{en,fr,de,es,it,nl}', '{EUR}', '{card,paypal,sepa,ideal,apple_pay,google_pay}',
    '{"type":"vat","rate":0.20}', '{"gdpr":true}',
    '{"regions":["eu-west"],"data_residency":"eu-west"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["en","fr","de","es"]}',
    'active', 0),
  ('uk', 'United Kingdom', '{en}', '{GBP}', '{card,paypal,apple_pay,google_pay}',
    '{"type":"vat","rate":0.20}', '{"gdpr":true,"uk_dpa":true}',
    '{"regions":["eu-west"],"data_residency":"eu-west"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["en"]}',
    'active', 0),
  ('apac', 'Asia-Pacific', '{en,ja,ko,zh,hi}', '{USD,JPY,KRW,CNY,INR}', '{card,paypal,alipay,wechat_pay,apple_pay}',
    '{"type":"gst","rate":0.08}', '{"pdpa":true}',
    '{"regions":["ap-southeast"],"data_residency":"ap-southeast"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["en","ja","ko","zh"]}',
    'active', 0),
  ('af', 'Africa', '{en,sw,ha,yo,pt}', '{USD,NGN,KES,ZAR}', '{card,mpesa,paystack,flutterwave}',
    '{"type":"vat","rate":0.075}', '{"popia":true,"lgpd":false}',
    '{"regions":["eu-west"],"data_residency":"eu-west"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["en","sw","ha","yo"]}',
    'active', 0),
  ('sa', 'South America', '{es,pt}', '{USD,BRL,ARS,CLP}', '{card,paypal,pix,apple_pay}',
    '{"type":"consumption","rate":0.17}', '{"lgpd":true}',
    '{"regions":["us-east"],"data_residency":"us-east"}',
    '{"landing_page":true,"pricing_page":true}',
    '{"hours":{"mon":"09:00-18:00"},"languages":["es","pt"]}',
    'active', 0)
on conflict (region_code) do nothing;

-- ───────────────────────────────────────────────
-- Seed vertical configs (8 initial verticals).
-- ───────────────────────────────────────────────

insert into vertical_configs (slug, name, description, prompt_ids, agent_templates, connector_keys, template_slugs, compliance_rules, pricing_config, marketing_config, status) values
  ('legal', 'Legal', 'AI-powered legal assistance: contract review, research, citations.',
    '{legal.system,legal.contract_review,legal.citation}',
    '[{"key":"legal.contract_reviewer","name":"Contract Reviewer","tools":["search.web","file.upload","pdf.generate"],"budget":2.0}]',
    '{google_workspace,microsoft_365}', '{legal-contract-template}',
    '{"gdpr":true,"soc2":true,"attorney_client_privilege":true}',
    '{"base_price":199,"per_seat":29,"features":["contract_review","legal_research","citation_check"]}',
    '{"landing_page":true,"use_cases":["contract_review","legal_research"]}',
    'published'),
  ('healthcare', 'Healthcare', 'Clinical assistance, patient education, scheduling.',
    '{healthcare.system,healthcare.clinical_summary}',
    '[{"key":"healthcare.clinical_assistant","name":"Clinical Assistant","tools":["search.web","file.upload"],"budget":1.5}]',
    '{google_workspace,slack}', '{healthcare-intake-form}',
    '{"hipaa":true,"gdpr":true,"phi_protection":true}',
    '{"base_price":299,"per_seat":39,"features":["clinical_summary","patient_education","scheduling"]}',
    '{"landing_page":true,"use_cases":["clinical_assistance","patient_education"]}',
    'published'),
  ('education', 'Education', 'AI tutoring, curriculum design, grading assistance.',
    '{education.system,education.tutor}',
    '[{"key":"education.tutor","name":"AI Tutor","tools":["search.web","file.upload"],"budget":0.5}]',
    '{google_workspace,microsoft_365,discord}', '{education-lesson-plan}',
    '{"ferpa":true,"gdpr":true,"coppa":true}',
    '{"base_price":49,"per_seat":9,"features":["tutoring","curriculum_design","grading"]}',
    '{"landing_page":true,"use_cases":["tutoring","curriculum"]}',
    'published'),
  ('agencies', 'Agencies', 'Client management, project delivery, proposal generation.',
    '{agency.system,agency.proposal}',
    '[{"key":"agency.account_manager","name":"Account Manager","tools":["search.web","file.upload","email.send"],"budget":1.0}]',
    '{slack,google_workspace,asana}', '{agency-proposal-template}',
    '{"gdpr":true,"soc2":true}',
    '{"base_price":149,"per_seat":19,"features":["client_mgmt","proposals","project_delivery"]}',
    '{"landing_page":true,"use_cases":["client_management","proposals"]}',
    'published'),
  ('real_estate', 'Real Estate', 'Property analysis, listing generation, client communication.',
    '{realestate.system,realestate.analysis}',
    '[{"key":"realestate.analyst","name":"Property Analyst","tools":["search.web","file.upload","email.send"],"budget":1.0}]',
    '{google_workspace,slack}', '{realestate-listing-template}',
    '{"gdpr":true,"ccpa":true}',
    '{"base_price":99,"per_seat":15,"features":["property_analysis","listings","client_comm"]}',
    '{"landing_page":true,"use_cases":["property_analysis","listings"]}',
    'published'),
  ('ecommerce', 'E-commerce', 'Product descriptions, customer support, inventory management.',
    '{ecommerce.system,ecommerce.support}',
    '[{"key":"ecommerce.support_agent","name":"Support Agent","tools":["search.web","email.send"],"budget":0.5}]',
    '{stripe,slack,google_workspace}', '{ecommerce-product-desc}',
    '{"pci_dss":true,"gdpr":true}',
    '{"base_price":79,"per_seat":12,"features":["product_descriptions","support","inventory"]}',
    '{"landing_page":true,"use_cases":["product_descriptions","support"]}',
    'published'),
  ('restaurants', 'Restaurants', 'Menu design, reservation management, review responses.',
    '{restaurant.system,restaurant.menu}',
    '[{"key":"restaurant.menu_designer","name":"Menu Designer","tools":["search.web","pdf.generate"],"budget":0.3}]',
    '{google_workspace,slack}', '{restaurant-menu-template}',
    '{"gdpr":true}',
    '{"base_price":59,"per_seat":8,"features":["menu_design","reservations","reviews"]}',
    '{"landing_page":true,"use_cases":["menu_design","reservations"]}',
    'published'),
  ('consultants', 'Consultants', 'Proposal generation, report writing, research automation.',
    '{consulting.system,consulting.proposal}',
    '[{"key":"consulting.researcher","name":"Research Assistant","tools":["search.web","file.upload","pdf.generate"],"budget":1.0}]',
    '{google_workspace,microsoft_365,slack}', '{consulting-proposal-template}',
    '{"gdpr":true,"soc2":true}',
    '{"base_price":129,"per_seat":19,"features":["proposals","reports","research"]}',
    '{"landing_page":true,"use_cases":["proposals","research"]}',
    'published')
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on regional_playbooks to supa_app;
grant select on vertical_configs to supa_app;
grant select on enterprise_licenses to supa_app;
grant select on enterprise_slas to supa_app;
grant select on compliance_evidence to supa_app;

grant select, insert, update, delete on regional_playbooks to supa_system;
grant select, insert, update, delete on vertical_configs to supa_system;
grant select, insert, update, delete on enterprise_licenses to supa_system;
grant select, insert, update, delete on enterprise_slas to supa_system;
grant select, insert, update, delete on compliance_evidence to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0060',
    'admin.phase14.regional_vertical_enterprise.created',
    jsonb_build_object('tables', array['regional_playbooks','vertical_configs','enterprise_licenses','enterprise_slas','compliance_evidence'], 'regions_seeded', 6, 'verticals_seeded', 8),
    'migration 0060 — Phase 14 regional expansion + vertical editions + enterprise editions',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
