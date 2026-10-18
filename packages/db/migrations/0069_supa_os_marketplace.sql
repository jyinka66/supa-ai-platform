-- ───────────────────────────────────────────────
-- 0069_supa_os_marketplace.sql
-- Marketplace items — agent skills, API connectors, UI components, templates, themes.
--
-- Referenced by:
--   - lib/supa-os/marketplace.ts (submitForReview, completeReview, discoverItems)
--   - API routes: POST /api/supa-os/marketplace, POST /api/supa-os/marketplace/[itemId]/review
--
-- Note: a 'marketplace_items' table already exists from migration 0057
-- (for the design marketplace — templates, components sold to designers).
-- This migration adds supa_os_marketplace_items — the Supa OS-specific
-- marketplace for agent skills, connectors, etc. — as a separate table
-- to avoid schema conflicts.
-- ───────────────────────────────────────────────

-- Ensure the trusted system role exists before grants and RLS policies.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supa_system') then
    create role supa_system login password null;
  end if;
end
$$;

create table supa_os_marketplace_items (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  type                  text not null check (type in (
                          'agent_skill', 'api_connector', 'ui_component',
                          'template', 'theme'
                        )),
  description           text not null,
  creator_id            text not null,
  creator_name          text not null,
  status                text not null check (status in (
                          'draft', 'submitted', 'in_review', 'approved', 'rejected', 'published', 'deprecated', 'removed', 'yanked'
                        )) default 'draft',
  monetization          text not null check (monetization in (
                          'free', 'one_time', 'subscription', 'revenue_share'
                        )),
  price                 numeric(10,2) not null default 0,
  version              text not null,                       -- semver (1.2.3).
  tags                  text[] not null default '{}',
  manifest             jsonb not null default '{}'::jsonb,

  download_count        int not null default 0 check (download_count >= 0),
  rating                numeric(3,2) not null default 0 check (rating >= 0 and rating <= 5), -- 0-5 average.
  review_count          int not null default 0 check (review_count >= 0),
  featured              boolean not null default false,
  verified              boolean not null default false,

  published_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint supa_os_marketplace_items_price_check check (price >= 0 and (monetization <> 'free' or price = 0))
);

create index idx_supa_marketplace_status on supa_os_marketplace_items (status, created_at desc);
create index idx_supa_marketplace_type on supa_os_marketplace_items (type, status);
create index idx_supa_marketplace_creator on supa_os_marketplace_items (creator_id, created_at desc);
create index idx_supa_marketplace_tags on supa_os_marketplace_items using gin (tags);

comment on table supa_os_marketplace_items is
  'global_system — Supa OS marketplace items (agent skills, API connectors, UI components, templates, themes). 5 types, 5 monetization models, review workflow (draft → in_review → published | rejected).';

-- ───────────────────────────────────────────────
-- supa_os_marketplace_reviews — per-item review checks.
-- ───────────────────────────────────────────────

create table supa_os_marketplace_reviews (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references supa_os_marketplace_items(id) on delete cascade,
  reviewer_id           text,                               -- admin_id (null for automated checks).
  decision              text not null check (decision in ('approve', 'reject')),
  notes                 text not null,
  review_checks         jsonb not null default '[]'::jsonb, -- the 5 automated checks + statuses.
  reviewed_at           timestamptz not null default now()
);

create index idx_supa_marketplace_reviews_item on supa_os_marketplace_reviews (item_id, reviewed_at desc);

comment on table supa_os_marketplace_reviews is
  'global_system — per-item review history. Each submission runs 5 automated checks (schema, security, permissions, budget, plagiarism) + manual review notes.';


-- Marketplace data is public only after publication. Writes are reserved for
-- the trusted system role used by authenticated admin API handlers.
alter table supa_os_marketplace_items enable row level security;
alter table supa_os_marketplace_reviews enable row level security;

create policy supa_marketplace_public_read on supa_os_marketplace_items
  for select to anon, authenticated using (status = 'published');
create policy supa_marketplace_system_select on supa_os_marketplace_items
  for select to supa_system using (true);
create policy supa_marketplace_system_insert on supa_os_marketplace_items
  for insert to supa_system with check (true);
create policy supa_marketplace_system_update on supa_os_marketplace_items
  for update to supa_system using (true) with check (true);
create policy supa_marketplace_system_delete on supa_os_marketplace_items
  for delete to supa_system using (true);

create policy supa_marketplace_reviews_system_select on supa_os_marketplace_reviews
  for select to supa_system using (true);
create policy supa_marketplace_reviews_system_insert on supa_os_marketplace_reviews
  for insert to supa_system with check (true);
create policy supa_marketplace_reviews_system_update on supa_os_marketplace_reviews
  for update to supa_system using (true) with check (true);
create policy supa_marketplace_reviews_system_delete on supa_os_marketplace_reviews
  for delete to supa_system using (true);

grant select on supa_os_marketplace_items to anon, authenticated;
grant select, insert, update, delete on supa_os_marketplace_items to supa_system;
grant select, insert, update, delete on supa_os_marketplace_reviews to supa_system;
