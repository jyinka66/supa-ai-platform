-- ============ SHARE LINK ENHANCEMENTS ============
-- Adds view-limiting + view-counting columns to share_links.
-- These are optional: a NULL max_views means unlimited views.

alter table public.share_links
  add column if not exists max_views integer check (max_views is null or max_views > 0),
  add column if not exists view_count integer not null default 0;

comment on column public.share_links.max_views is
  'Optional view limit. NULL = unlimited. When view_count >= max_views, the link is exhausted.';
comment on column public.share_links.view_count is
  'Number of times this share link has been accessed via the public GET route.';

-- Index for the public lookup path (token_hash is already unique-indexed,
-- but we add a partial index on non-revoked, non-expired links for the
-- "active shares" dashboard query).
create index if not exists idx_share_active
  on public.share_links(expires_at)
  where revoked_at is null;
