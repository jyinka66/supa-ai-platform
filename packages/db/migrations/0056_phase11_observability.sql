-- ───────────────────────────────────────────────
-- 0056_phase11_observability.sql
-- Phase 11 — Observability, Acceptance Criteria, and Risk Registry.
--
-- Tables:
--   - automated_reports: weekly/monthly/quarterly generated reports.
--   - anomaly_alerts: detected anomalies across all health metrics.
--   - risk_registry: the 11.8 risk catalog with mitigation status.
--
-- All global_system.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- automated_reports — generated + distributed reports.
-- ───────────────────────────────────────────────

create table automated_reports (
  id              uuid primary key default gen_random_uuid(),
  period          text not null check (period in ('weekly','monthly','quarterly')),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  report_data     jsonb not null,            -- the full report (health summary + trends + anomalies).
  generated_at    timestamptz not null default now(),
  distributed     boolean not null default false,
  distributed_at  timestamptz,
  distributed_to  text[],                    -- email addresses or channels.
  unique (period, period_start)
);

create index idx_automated_reports_period on automated_reports (period, period_start desc);

comment on table automated_reports is
  'global_system — weekly/monthly/quarterly generated reports. Auto-distributed.';

-- ───────────────────────────────────────────────
-- anomaly_alerts — detected anomalies across health metrics.
-- ───────────────────────────────────────────────

create table anomaly_alerts (
  id              uuid primary key default gen_random_uuid(),
  category        text not null check (category in ('i18n','accessibility','seo','content','legal','support','regional','performance','security')),
  metric          text not null,               -- the metric that's anomalous (e.g. 'completeness_pct', 'csat_score').
  severity        text not null check (severity in ('info','warning','critical')),
  expected_value  numeric,
  actual_value    numeric,
  deviation_pct   numeric,                      -- how far off from expected (e.g. -20% = 20% below).
  detail          text not null,                -- human-readable description.
  detected_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution      text
);

create index idx_anomaly_alerts_unresolved on anomaly_alerts (severity, detected_at desc) where resolved_at is null;
create index idx_anomaly_alerts_category on anomaly_alerts (category, detected_at desc);

comment on table anomaly_alerts is
  'global_system — anomaly alerts. Auto-detected by the cron. Severity: info/warning/critical.';

-- ───────────────────────────────────────────────
-- risk_registry — the 11.8 risk catalog with mitigation status.
-- ───────────────────────────────────────────────

create table risk_registry (
  id              uuid primary key default gen_random_uuid(),
  risk_id         text not null unique,         -- 'RTL_EDGE_CASES', 'TRANSLATION_QUALITY', etc.
  category        text not null,                 -- 'i18n', 'accessibility', 'seo', 'support', 'legal', 'content', 'regional', 'security'.
  title           text not null,
  description     text not null,
  mitigation      text not null,                 -- what's done to mitigate.
  mitigation_status text not null check (mitigation_status in ('implemented','in_progress','planned','not_started')),
  owner           text not null,                  -- who owns this risk.
  last_reviewed_at timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_risk_registry_category on risk_registry (category);
create index idx_risk_registry_status on risk_registry (mitigation_status);

comment on table risk_registry is
  'global_system — risk registry. 11.8 risks with mitigation status. Reviewed regularly.';

-- ───────────────────────────────────────────────
-- Seed the 14 risks from 11.8.
-- ───────────────────────────────────────────────

insert into risk_registry (risk_id, category, title, description, mitigation, mitigation_status, owner) values
  ('RTL_EDGE_CASES', 'i18n', 'RTL edge cases',
   'Right-to-left layout issues in Arabic and other RTL locales.',
   'RTL-first architecture (logical CSS properties), automated RTL tests (CI checker), native-speaker review, tested screen by screen.',
   'implemented', 'team-frontend'),
  ('TRANSLATION_QUALITY', 'i18n', 'Translation quality',
   'AI-translated content may be inaccurate or unnatural.',
   'AI + native-speaker review + glossary + translation memory + automated QA (placeholder mismatch, length overflow, RTL violations).',
   'implemented', 'team-i18n'),
  ('ACCESSIBILITY_REGRESSIONS', 'accessibility', 'Accessibility regressions',
   'New code may introduce a11y violations (contrast, keyboard, ARIA).',
   'Automated tests in CI (axe-core + static checker), quarterly manual audits, user-reported issues prioritized.',
   'implemented', 'team-frontend'),
  ('SEO_PENALTIES', 'seo', 'SEO penalties',
   'Google may penalize for duplicate content, missing hreflang, or poor quality.',
   'hreflang verified across all locales, canonical URLs on every page, no duplicate content, structured data (JSON-LD), content quality monitoring.',
   'implemented', 'team-seo'),
  ('SUPPORT_OVERWHELM', 'support', 'Support overwhelm',
   'Support volume may exceed capacity.',
   'AI triage, macros, self-service help center, tiered support (SLA per plan), threshold-based scaling (auto-expand support languages).',
   'implemented', 'team-support'),
  ('LEGAL_GAPS', 'legal', 'Legal gaps in new jurisdictions',
   'New jurisdictions may lack localized legal documents.',
   'Legal playbook (expansion pipeline), external counsel where needed, version control (append-only legal_versions), automated propagation across locales.',
   'implemented', 'team-legal'),
  ('CONTENT_STALENESS', 'content', 'Content staleness',
   'Content may become outdated over time.',
   'Automated freshness monitoring (nightly cron flags >365d), flagged for review, remediated by content team.',
   'implemented', 'team-content'),
  ('BROKEN_LINKS', 'content', 'Broken links',
   'Internal or external links may break over time.',
   'Automated detection (nightly cron checks all links), alerted, fixed by content team.',
   'implemented', 'team-content'),
  ('REGIONAL_COMPLIANCE_DRIFT', 'regional', 'Regional compliance drift',
   'Regional compliance may drift from local regulations.',
   'Policy as code (regional_config table), automated evidence collection, regional audits.',
   'implemented', 'team-legal'),
  ('DATA_RESIDENCY_VIOLATIONS', 'security', 'Data residency violations',
   'Workspace data may be stored in the wrong region.',
   'Enforced at infrastructure level (migration 0046: forbid_region_change trigger + RLS), verified by tests.',
   'implemented', 'team-platform'),
  ('LOCALIZATION_DRIFT', 'i18n', 'Localization drift',
   'Translations may drift from English source over time.',
   'Continuous localization pipeline, translation memory, glossary, automated QA (CI checker).',
   'implemented', 'team-i18n'),
  ('REGIONAL_ROLLOUT_FAILURE', 'regional', 'Regional rollout failure',
   'A new region rollout may fail or cause issues.',
   'Staged rollouts (expansion pipeline with verification checklist), automated smoke tests, rollback per region.',
   'implemented', 'team-platform'),
  ('SUPPORT_LANGUAGE_GAPS', 'support', 'Support language coverage gaps',
   'Support may not be available in all user languages.',
   'AI first-response in all languages (auto-answer), human escalation in supported languages, prioritized expansion (threshold-based).',
   'in_progress', 'team-support'),
  ('CROSS_LOCALE_INCONSISTENCY', 'i18n', 'Cross-locale inconsistency',
   'Translations may be inconsistent across locales.',
   'Shared translation memory, glossary (brand/legal/technical terms), style guide, automated consistency checks (CI checker).',
   'implemented', 'team-i18n')
on conflict (risk_id) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on automated_reports to supa_app;
grant select on anomaly_alerts to supa_app;
grant select on risk_registry to supa_app;

grant select, insert, update, delete on automated_reports to supa_system;
grant select, insert, update on anomaly_alerts to supa_system;
grant select, insert, update, delete on risk_registry to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0056',
    'admin.phase11.observability.created',
    jsonb_build_object('tables', array['automated_reports','anomaly_alerts','risk_registry'], 'risks_seeded', 14),
    'migration 0056 — Phase 11 observability + acceptance criteria + risk registry',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
