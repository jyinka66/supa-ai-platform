-- ───────────────────────────────────────────────
-- 0053_phase11_content_legal.sql
-- Phase 11 — Autonomous Content + Legal.
--
-- Tables:
--   - blog_posts: blog articles (localized, SEO-optimized, structured data).
--   - help_articles: help center articles (searchable, versioned).
--   - changelog_entries: public changelog (RSS, localized).
--   - legal_documents: legal docs (privacy, terms, DPA, etc.) with versioning.
--   - legal_versions: version history (published + archived).
--   - legal_review: review workflow for new jurisdictions.
--   - backlinks: tracked backlinks (quality monitoring).
--   - rank_tracking: keyword rank positions per locale.
--
-- All are global_system (content spans the whole platform, not tenant-scoped).
-- Content tables are locale-specific (one row per locale per source document).
-- Legal tables are versioned (each version is a row; the latest published is current).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- blog_posts — localized blog articles.
-- ───────────────────────────────────────────────

create table blog_posts (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null,                         -- the URL slug (shared across locales).
  locale          text not null references locales(code),
  title           text not null,
  description     text not null,
  body            text not null,                         -- markdown or HTML.
  author          text,                                  -- the author name.
  published_at    timestamptz,
  updated_at      timestamptz not null default now(),
  status          text not null default 'draft' check (status in ('draft','published','archived')),
  tags            text[] not null default '{}',
  cover_image     text,
  canonical_url   text,                                  -- for cross-posted content.
  noindex         boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (slug, locale)
);

create index idx_blog_posts_locale_status on blog_posts (locale, status, published_at desc);
create index idx_blog_posts_tags on blog_posts using gin (tags);

comment on table blog_posts is
  'global_system — localized blog articles. One row per (slug, locale). Status: draft → published → archived.';

-- ───────────────────────────────────────────────
-- help_articles — help center articles.
-- ───────────────────────────────────────────────

create table help_articles (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null,
  locale          text not null references locales(code),
  title           text not null,
  body            text not null,
  category        text not null,                          -- 'getting-started', 'billing', 'api', etc.
  sort_order      integer not null default 0,
  published_at    timestamptz,
  updated_at      timestamptz not null default now(),
  status          text not null default 'draft' check (status in ('draft','published','archived')),
  views           integer not null default 0,
  helpful_yes     integer not null default 0,
  helpful_no      integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (slug, locale)
);

create index idx_help_articles_category_locale on help_articles (category, locale, status, sort_order);
create index idx_help_articles_search on help_articles using gin (to_tsvector('english', title || ' ' || body));

comment on table help_articles is
  'global_system — help center articles. Searchable (FTS), versioned, localized. Thumbs up/down tracking.';

-- ───────────────────────────────────────────────
-- changelog_entries — public changelog (RSS).
-- ───────────────────────────────────────────────

create table changelog_entries (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  locale          text not null references locales(code),
  title           text not null,
  body            text not null,
  version         text,                                  -- e.g. 'v2.1.0'.
  published_at    timestamptz not null default now(),
  tags            text[] not null default '{}',
  status          text not null default 'published' check (status in ('draft','published','archived')),
  created_at      timestamptz not null default now()
);

create index idx_changelog_locale_published on changelog_entries (locale, status, published_at desc);

comment on table changelog_entries is
  'global_system — public changelog. RSS-enabled, localized.';

-- ───────────────────────────────────────────────
-- legal_documents — legal docs (privacy, terms, DPA, etc.).
-- One row per (doc_type, jurisdiction). Each has version history.
-- ───────────────────────────────────────────────

create table legal_documents (
  id              uuid primary key default gen_random_uuid(),
  doc_type        text not null check (doc_type in (
    'privacy', 'terms', 'cookies', 'dpa', 'refund', 'security', 'subprocessors', 'aup'
  )),
  jurisdiction    text not null default 'global',         -- 'global', 'eu', 'us', 'uk', 'br', 'in', etc.
  title           text not null,
  description     text,
  current_version_id uuid,                                -- FK to legal_versions (set on publish).
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (doc_type, jurisdiction)
);

comment on table legal_documents is
  'global_system — legal documents. One per (doc_type, jurisdiction). Versioned via legal_versions.';

-- ───────────────────────────────────────────────
-- legal_versions — version history (published + archived).
-- Append-only (REVOKE UPDATE/DELETE — legal audit trail).
-- ───────────────────────────────────────────────

create table legal_versions (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references legal_documents(id) on delete cascade,
  version         text not null,                          -- semver-style: '1.0.0', '1.1.0'.
  locale          text not null references locales(code),
  body            text not null,                           -- the full legal text (markdown/HTML).
  changelog       text,                                    -- what changed from the previous version.
  status          text not null check (status in ('draft','in_review','published','archived')),
  effective_date  timestamptz,                             -- when this version takes effect.
  published_at    timestamptz,
  archived_at     timestamptz,
  reviewed_by     uuid,                                    -- the legal reviewer.
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (document_id, version, locale)
);

create index idx_legal_versions_doc on legal_versions (document_id, locale, status);

-- Legal versions are append-only (legal audit trail — never modified after publication).
revoke update, delete on legal_versions from public, authenticated, anon, supa_app, supa_system;

comment on table legal_versions is
  'global_system — legal document versions. Append-only (REVOKE UPDATE/DELETE). Status: draft → in_review → published → archived.';

-- ───────────────────────────────────────────────
-- legal_review — review workflow for new jurisdictions.
-- ───────────────────────────────────────────────

create table legal_review (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references legal_documents(id) on delete cascade,
  jurisdiction    text not null,                          -- the new jurisdiction being reviewed.
  requested_by    uuid not null,
  reviewer_id     uuid,                                   -- the legal reviewer (assigned).
  status          text not null default 'pending' check (status in ('pending','assigned','approved','rejected')),
  notes           text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

comment on table legal_review is
  'global_system — legal review workflow. New jurisdictions reviewed by legal before launch.';

-- ───────────────────────────────────────────────
-- backlinks — tracked backlinks (quality monitoring).
-- ───────────────────────────────────────────────

create table backlinks (
  id              uuid primary key default gen_random_uuid(),
  source_url      text not null,                          -- the page linking to us.
  target_url      text not null,                          -- our page being linked to.
  anchor_text     text,
  domain_authority numeric(5,2),                           -- the linking domain's authority (0-100).
  follow          boolean not null default true,           -- dofollow vs nofollow.
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  status          text not null default 'active' check (status in ('active','lost','broken')),
  created_at      timestamptz not null default now(),
  unique (source_url, target_url)
);

create index idx_backlinks_target on backlinks (target_url);
create index idx_backlinks_status on backlinks (status, last_seen desc);

comment on table backlinks is
  'global_system — tracked backlinks. Quality monitoring (domain authority, lost/broken).';

-- ───────────────────────────────────────────────
-- rank_tracking — keyword rank positions per locale.
-- ───────────────────────────────────────────────

create table rank_tracking (
  id              uuid primary key default gen_random_uuid(),
  keyword         text not null,                          -- the target keyword.
  locale          text not null references locales(code),
  url             text not null,                          -- the page ranking for this keyword.
  position        integer not null,                        -- the SERP position (1 = first result).
  previous_position integer,                              -- for change tracking.
  search_volume   integer,                                 -- estimated monthly searches.
  tracked_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (keyword, locale, url, tracked_at)
);

create index idx_rank_tracking_keyword on rank_tracking (keyword, locale, tracked_at desc);

comment on table rank_tracking is
  'global_system — keyword rank tracking per locale. Position + search volume.';

-- ───────────────────────────────────────────────
-- Grants.
-- ───────────────────────────────────────────────

grant select on blog_posts to supa_app;
grant select on help_articles to supa_app;
grant select on changelog_entries to supa_app;
grant select on legal_documents to supa_app;
grant select on legal_versions to supa_app;
grant select on backlinks to supa_app;
grant select on rank_tracking to supa_app;

grant select, insert, update, delete on blog_posts to supa_system;
grant select, insert, update, delete on help_articles to supa_system;
grant select, insert, update, delete on changelog_entries to supa_system;
grant select, insert, update on legal_documents to supa_system;
grant select, insert on legal_versions to supa_system;  -- insert-only (REVOKE above).
grant select, insert, update, delete on legal_review to supa_system;
grant select, insert, update, delete on backlinks to supa_system;
grant select, insert, update, delete on rank_tracking to supa_system;

-- ───────────────────────────────────────────────
-- Seed the legal document types.
-- ───────────────────────────────────────────────

insert into legal_documents (doc_type, jurisdiction, title, description) values
  ('privacy',      'global', 'Privacy Policy',           'How we collect, use, and protect your data. GDPR, CCPA, LGPD, DPDP, POPIA, PIPL compliant.'),
  ('terms',        'global', 'Terms of Service',         'The terms governing your use of Supa AI.'),
  ('cookies',      'global', 'Cookie Policy',            'What cookies we use, why, and how to control them.'),
  ('dpa',          'global', 'Data Processing Agreement','For enterprise customers requiring a DPA.'),
  ('refund',       'global', 'Refund Policy',            'Our refund and cancellation policy.'),
  ('security',     'global', 'Security',                  'Encryption, backups, compliance, and sub-processors.'),
  ('subprocessors','global', 'Sub-processor List',       'All third parties that process data.'),
  ('aup',          'global', 'Acceptable Use Policy',    'What users can and cannot do on Supa AI.')
on conflict (doc_type, jurisdiction) do nothing;

-- ───────────────────────────────────────────────
-- Audit.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0053',
    'admin.phase11.content_legal.created',
    jsonb_build_object('tables', array['blog_posts','help_articles','changelog_entries','legal_documents','legal_versions','legal_review','backlinks','rank_tracking']),
    'migration 0053 — Phase 11 autonomous content + legal infrastructure',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
