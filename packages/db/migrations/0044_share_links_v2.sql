-- ───────────────────────────────────────────────
-- 0044_share_links_v2_v2.sql
-- Share links v2 — the spec's canonical design.
--
-- DIVERGENCE from migration 0021 (existing work_share_links_v2):
--   - 0044 uses `files` table (migration 0039) — 0021 used `work_items`.
--   - 0044 uses `has_permission(ws_id, 'file:share')` — 0021 used `is_ws_member`.
--   - 0044 has `allowed_email` (optional email-gated sharing) — 0021 didn't.
--   - 0044 has `max_views` + `view_count` (view exhaustion) — 0021 had `view_limit`.
--   - Both coexist; a future migration would migrate data + drop 0021.
--
-- FIX from the pasted spec:
--   `has_role(ws_id, 'admin')` → `has_permission(ws_id, 'file:share')` — the
--   canonical permission check from migration 0043 (not the non-existent has_role).
-- ───────────────────────────────────────────────

create table share_links_v2 (
  id            uuid primary key default gen_random_uuid(),
  ws_id         uuid not null references workspaces(id) on delete cascade,
  file_id       uuid not null references files(id) on delete cascade,
  token_hash    text unique not null,          -- SHA-256 of the URL secret; token itself never stored.
  password_hash text,                          -- null = no password (allowed only for internal tier+).
  perm          text not null check (perm in ('view','download','edit')),
  expires_at    timestamptz,
  max_views     integer check (max_views > 0),
  view_count    integer not null default 0,
  allowed_email text,                          -- optional: viewer must verify ownership of this email.
  created_by    uuid not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  check (expires_at is null or expires_at > created_at)
);

create index on share_links_v2 (ws_id, file_id) where revoked_at is null;

alter table share_links_v2 enable row level security;
-- file:share permission required (not just any member — sharing is a
-- deliberate action that grants external access).
create policy share_owner on share_links_v2 for all to supa_app
  using (has_permission(ws_id, 'file:share'))
  with check (has_permission(ws_id, 'file:share'));

comment on table share_links_v2 is
  '@tenant_table — share links (token hashed, password argon2id, perm-scoped, has_permission RLS)';

-- Force RLS.
alter table share_links_v2 force row level security;

-- ───────────────────────────────────────────────
-- share_views — view log (for analytics + exhaustion tracking)
-- ───────────────────────────────────────────────

create table share_views (
  share_id  uuid not null references share_links_v2(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  ip_hash   text not null,                     -- truncated hash (16 chars), retention 90d.
  ok        boolean not null                   -- true = access granted, false = denied (password/expiry/views).
);

create index on share_views (share_id, viewed_at desc);

alter table share_views enable row level security;
-- share_views are readable by anyone with file:share permission (the link owner).
create policy share_views_read on share_views for select to supa_app
  using (
    exists (
      select 1 from share_links_v2 sl
      where sl.id = share_views.share_id
        and has_permission(sl.ws_id, 'file:share')
    )
  );
-- INSERT is via security-definer function (the public share route doesn't
-- have a user context — it inserts view records for anonymous viewers).

comment on table share_views is
  '@tenant_table — share view log (ip_hash truncated, 90d retention, analytics + exhaustion)';

-- Force RLS.
alter table share_views force row level security;
