-- ───────────────────────────────────────────────
-- 0055_phase11_expansion_security.sql
-- Phase 11 — Autonomous Globalization Expansion + Security/Privacy.
--
-- Tables:
--   - expansion_tasks: onboarding pipeline tracking (language/region/jurisdiction/support).
--   - pii_redaction_log: every time a support agent accesses user data (logged + justified).
--   - cookie_consent: per-jurisdiction cookie consent records.
--
-- All global_system.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- expansion_tasks — the onboarding pipeline tracker.
-- ───────────────────────────────────────────────

create table expansion_tasks (
  id              uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('language','region','jurisdiction','support_language')),
  target           text not null,                 -- the locale code, region code, or jurisdiction.
  status           text not null default 'prioritized' check (status in (
    'prioritized','extracting','translating','reviewing','qa','publishing','live','abandoned'
  )),
  threshold_met    boolean not null default false, -- true if usage threshold crossed (auto-expansion).
  usage_threshold  numeric(10,2),                  -- the threshold that triggered this (e.g. 1000 users).
  current_usage    numeric(10,2),                  -- the current usage metric.
  assigned_to     uuid,                             -- the owner responsible.
  checklist        jsonb not null default '{}',    -- { extracted: bool, translated: bool, reviewed: bool, qa_passed: bool, published: bool, verified: bool }.
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (kind, target)
);

create index idx_expansion_tasks_status on expansion_tasks (status, kind);
create index idx_expansion_tasks_threshold on expansion_tasks (kind, threshold_met) where status != 'live';

comment on table expansion_tasks is
  'global_system — onboarding pipeline tracker. Status: prioritized → extracting → translating → reviewing → qa → publishing → live. Threshold-based auto-expansion.';

-- ───────────────────────────────────────────────
-- pii_redaction_log — every support access to user data is logged + justified.
-- ───────────────────────────────────────────────

create table pii_redaction_log (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references support_tickets(id) on delete cascade,
  accessed_by     uuid not null,                  -- the support agent's user_id.
  access_type     text not null check (access_type in ('view','export','redact')),
  fields_accessed text[] not null default '{}',   -- which PII fields were accessed (email, body, etc.).
  justification   text not null,                   -- MANDATORY: why the agent accessed this data.
  ip              inet not null,
  user_agent      text,
  created_at      timestamptz not null default now()
);

create index idx_pii_redaction_ticket on pii_redaction_log (ticket_id, created_at desc);
create index idx_pii_redaction_agent on pii_redaction_log (accessed_by, created_at desc);

comment on table pii_redaction_log is
  'global_system — every support access to user PII is logged with mandatory justification. The audit trail for data-access compliance (GDPR Art. 30, LGPD Art. 37).';

-- ───────────────────────────────────────────────
-- cookie_consent — per-jurisdiction consent records.
-- ───────────────────────────────────────────────

create table cookie_consent (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,                           -- null for anonymous (cookie-based).
  session_id      text not null,                   -- the session identifier.
  jurisdiction    text not null,                   -- 'gdpr', 'ccpa', 'lgpd', 'dpdp', 'popia', 'pipl', 'none'.
  consent_given   boolean not null default false,
  consent_categories text[] not null default '{}', -- ['necessary','analytics','marketing'] — which categories consented.
  consent_version text not null,                   -- the cookie policy version the user consented to.
  ip              inet,
  user_agent      text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,                    -- consent expiry (some jurisdictions require re-consent).
  withdrawn_at    timestamptz                     -- if consent was withdrawn.
);

create index idx_cookie_consent_session on cookie_consent (session_id);
create index idx_cookie_consent_user on cookie_consent (user_id) where user_id is not null;

comment on table cookie_consent is
  'global_system — per-jurisdiction cookie consent. GDPR requires opt-in, CCPA requires opt-out, others vary. Consent versioned + withdrawable.';

-- ───────────────────────────────────────────────
-- Seed default expansion checklists.
-- ───────────────────────────────────────────────

-- Language expansion checklist.
insert into expansion_tasks (kind, target, status, checklist) values
  ('language', 'sw', 'prioritized', '{"extracted": false, "translated": false, "reviewed": false, "qa_passed": false, "published": false, "verified": false}'),
  ('language', 'ha', 'prioritized', '{"extracted": false, "translated": false, "reviewed": false, "qa_passed": false, "published": false, "verified": false}'),
  ('language', 'yo', 'prioritized', '{"extracted": false, "translated": false, "reviewed": false, "qa_passed": false, "published": false, "verified": false}')
on conflict (kind, target) do nothing;

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on expansion_tasks to supa_app;
grant select on pii_redaction_log to supa_app;
grant select on cookie_consent to supa_app;

grant select, insert, update, delete on expansion_tasks to supa_system;
grant select, insert on pii_redaction_log to supa_system;
grant select, insert, update on cookie_consent to supa_system;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0055',
    'admin.phase11.expansion_security.created',
    jsonb_build_object('tables', array['expansion_tasks','pii_redaction_log','cookie_consent']),
    'migration 0055 — Phase 11 autonomous expansion + security/privacy',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
