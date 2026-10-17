-- ───────────────────────────────────────────────
-- 0052_phase11_i18n.sql
-- Phase 11 — Autonomous Globalization.
--
-- Tables:
--   - locales: the locale registry (code, label, direction, status, reviewer).
--   - translation_memory: reused translations (source → target, fuzzy match).
--   - glossary: brand/legal/technical terms (consistent translation across locales).
--
-- The spec: "Translation memory — repeated strings reused, cost and consistency
-- improved." + "Glossary — brand terms, legal terms, and technical terms translated
-- consistently." + "Content parity monitoring — every locale tracked for
-- completeness, freshness, and quality."
--
-- All three are global_system (not tenant-scoped — i18n is platform-wide).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- locales — the locale registry (source of truth for supported locales).
-- ───────────────────────────────────────────────

create table locales (
  code            text primary key,                      -- 'en', 'ar', 'fr', ...
  label           text not null,                         -- 'English', 'العربية', ...
  english_label   text not null,                         -- 'English', 'Arabic', ...
  direction       text not null check (direction in ('ltr','rtl')),
  status          text not null default 'planned' check (status in ('planned','translating','reviewing','live','deprecated')),
  reviewer_id     uuid,                                  -- the native-speaker reviewer (admin or external).
  completeness_pct numeric(5,2) not null default 0,      -- 0-100 (translated strings / total strings).
  last_updated_at timestamptz,                           -- when translations were last updated.
  created_at      timestamptz not null default now()
);

comment on table locales is
  'global_system — locale registry. Status pipeline: planned → translating → reviewing → live. Completeness tracked for content parity monitoring.';

-- ───────────────────────────────────────────────
-- translation_memory — reused translations (cost + consistency).
-- ───────────────────────────────────────────────

create table translation_memory (
  id              uuid primary key default gen_random_uuid(),
  source_text     text not null,
  source_locale   text not null references locales(code),
  target_text     text not null,
  target_locale   text not null references locales(code),
  match_type      text not null check (match_type in ('exact','fuzzy')),
  source_context  text,                                  -- where the string came from (e.g. 'onboarding.steps.language').
  created_at      timestamptz not null default now(),
  unique (source_text, source_locale, target_locale)
);

create index idx_tm_source on translation_memory (source_locale, source_text);
create index idx_tm_target on translation_memory (target_locale, target_text);

comment on table translation_memory is
  'global_system — translation memory. Reused strings (exact + fuzzy match) for cost + consistency.';

-- ───────────────────────────────────────────────
-- glossary — brand/legal/technical terms (consistent translation).
-- ───────────────────────────────────────────────

create table glossary (
  id              uuid primary key default gen_random_uuid(),
  term            text not null,                        -- the English source term (e.g. 'workspace', 'API key').
  category        text not null check (category in ('brand','legal','technical','product')),
  do_not_translate boolean not null default false,      -- true = keep as-is in all locales (e.g. 'Supa AI').
  created_at      timestamptz not null default now(),
  unique (term)
);

create table glossary_translations (
  glossary_id     uuid not null references glossary(id) on delete cascade,
  locale          text not null references locales(code),
  translation     text not null,                         -- the approved translation for this locale.
  approved_by     uuid,                                  -- the reviewer who approved it.
  approved_at     timestamptz,
  primary key (glossary_id, locale)
);

comment on table glossary is
  'global_system — glossary. Brand/legal/technical terms with consistent translations. do_not_translate = keep as-is.';

-- ───────────────────────────────────────────────
-- Seed the 10 launch locales.
-- ───────────────────────────────────────────────

insert into locales (code, label, english_label, direction, status, completeness_pct) values
  ('en', 'English',    'English',    'ltr', 'live',     100),
  ('ar', 'العربية',    'Arabic',     'rtl', 'live',     95),
  ('fr', 'Français',   'French',     'ltr', 'live',     95),
  ('es', 'Español',    'Spanish',    'ltr', 'live',     95),
  ('hi', 'हिन्दी',     'Hindi',      'ltr', 'live',     90),
  ('pt', 'Português',  'Portuguese', 'ltr', 'live',     95),
  ('zh', '中文',        'Chinese',    'ltr', 'live',     90),
  ('de', 'Deutsch',    'German',     'ltr', 'live',     90),
  ('ja', '日本語',      'Japanese',   'ltr', 'live',     85),
  ('ko', '한국어',     'Korean',     'ltr', 'live',     85)
on conflict (code) do nothing;

-- Seed the planned expansion locales (the spec: "expanding to 30 through the same pipeline").
insert into locales (code, label, english_label, direction, status, completeness_pct) values
  ('sw', 'Kiswahili',  'Swahili',    'ltr', 'planned', 0),
  ('ha', 'Hausa',       'Hausa',      'ltr', 'planned', 0),
  ('yo', 'Yorùbá',     'Yoruba',     'ltr', 'planned', 0),
  ('tr', 'Türkçe',     'Turkish',    'ltr', 'planned', 0),
  ('id', 'Bahasa Indonesia','Indonesian','ltr','planned',0),
  ('vi', 'Tiếng Việt', 'Vietnamese', 'ltr', 'planned', 0),
  ('th', 'ไทย',        'Thai',       'ltr', 'planned', 0),
  ('ru', 'Русский',    'Russian',    'ltr', 'planned', 0),
  ('pl', 'Polski',     'Polish',     'ltr', 'planned', 0),
  ('uk', 'Українська', 'Ukrainian',  'ltr', 'planned', 0),
  ('it', 'Italiano',   'Italian',    'ltr', 'planned', 0),
  ('nl', 'Nederlands', 'Dutch',      'ltr', 'planned', 0),
  ('fa', 'فارسی',      'Persian',    'rtl', 'planned', 0),
  ('he', 'עברית',      'Hebrew',     'rtl', 'planned', 0),
  ('ur', 'اردو',       'Urdu',       'rtl', 'planned', 0),
  ('bn', 'বাংলা',      'Bengali',    'ltr', 'planned', 0),
  ('ta', 'தமிழ்',      'Tamil',      'ltr', 'planned', 0),
  ('te', 'తెలుగు',    'Telugu',     'ltr', 'planned', 0),
  ('mr', 'मराठी',      'Marathi',    'ltr', 'planned', 0),
  ('ms', 'Bahasa Melayu','Malay',    'ltr', 'planned', 0)
on conflict (code) do nothing;

-- Seed the glossary with core brand terms.
insert into glossary (term, category, do_not_translate) values
  ('Supa AI', 'brand', true),
  ('workspace', 'product', false),
  ('API key', 'technical', false),
  ('agent', 'product', false),
  ('webhook', 'technical', false),
  ('SSO', 'technical', false),
  ('MFA', 'technical', false),
  ('GDPR', 'legal', true),
  ('SOC 2', 'legal', true)
on conflict (term) do nothing;

-- ───────────────────────────────────────────────
-- Grants + audit.
-- ───────────────────────────────────────────────

grant select on locales to supa_app;
grant select on translation_memory to supa_app;
grant select on glossary to supa_app;
grant select on glossary_translations to supa_app;

grant select, insert, update, delete on locales to supa_system;
grant select, insert, update, delete on translation_memory to supa_system;
grant select, insert, update, delete on glossary to supa_system;
grant select, insert, update, delete on glossary_translations to supa_system;

do $$
begin
  perform admin_audit_log_append(
    'migration-0052',
    'admin.phase11.created',
    jsonb_build_object('tables', array['locales','translation_memory','glossary','glossary_translations'], 'locale_count', 30),
    'migration 0052 — Phase 11 autonomous globalization infrastructure',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
