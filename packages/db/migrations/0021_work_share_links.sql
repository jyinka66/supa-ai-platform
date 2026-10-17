-- ============ WORK ITEM SHARE LINKS + VIEWS ============
-- Shares for work items (separate from conversation share_links which
-- are scoped to conversations only).
--
-- This table supports sharing:
--   - Individual work items (item_id)
--   - Entire folders (folder_id)
--   - With optional password protection + expiry + view limits
--
-- The check constraint ensures at least one of item_id/folder_id is set.

-- ============ WORK_SHARE_LINKS ============
create table if not exists public.work_share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  item_id uuid references public.work_items(id) on delete cascade,
  folder_id uuid references public.work_folders(id) on delete cascade,
  token text not null unique,              -- 22-char url-safe random (128-bit)
  created_by uuid not null,  -- FK to auth.users via raw SQL
  role text not null default 'view'
    check (role in ('view', 'comment', 'edit')),
  password_hash text,                      -- null = no password
  expires_at timestamptz,                  -- null = never
  max_views int check (max_views is null or max_views > 0),  -- null = unlimited
  view_count int not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (item_id is not null or folder_id is not null)
);

create index if not exists idx_work_share_links_ws
  on public.work_share_links(workspace_id);
create index if not exists idx_work_share_links_token
  on public.work_share_links(token)
  where revoked_at is null;
create index if not exists idx_work_share_links_item
  on public.work_share_links(item_id)
  where item_id is not null;
create index if not exists idx_work_share_links_folder
  on public.work_share_links(folder_id)
  where folder_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_share_links_created_by_fkey'
      and table_name = 'work_share_links'
  ) then
    alter table public.work_share_links
      add constraint work_share_links_created_by_fkey
      foreign key (created_by) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ WORK_SHARE_VIEWS ============
-- Analytics for share link views (IP, country, user agent, referrer, dwell time).
create table if not exists public.work_share_views (
  id uuid primary key default gen_random_uuid(),
  share_link_id uuid not null references public.work_share_links(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  ip_hash text,       -- SHA-256 of IP (never raw IP)
  country text,       -- derived from IP via GeoIP (nullable)
  user_agent text,    -- truncated to 500 chars
  referrer text,      -- truncated to 500 chars
  duration_ms int     -- set on dwell ping (how long the viewer stayed)
);

create index if not exists idx_work_share_views_link
  on public.work_share_views(share_link_id, viewed_at desc);

-- ============ RLS ============
alter table public.work_share_links enable row level security;
alter table public.work_share_views enable row level security;

-- WORK_SHARE_LINKS: owner of the shared item/folder can manage; others can't see.
drop policy if exists work_share_links_select on public.work_share_links;
drop policy if exists work_share_links_insert on public.work_share_links;
drop policy if exists work_share_links_update on public.work_share_links;
drop policy if exists work_share_links_delete on public.work_share_links;

create policy work_share_links_select on public.work_share_links
  for select using (
    created_by = auth.uid()
    or exists (
      select 1 from public.work_items wi
      where wi.id = work_share_links.item_id and wi.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.work_folders wf
      where wf.id = work_share_links.folder_id and wf.created_by = auth.uid()
    )
  );

create policy work_share_links_insert on public.work_share_links
  for insert with check (
    created_by = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy work_share_links_update on public.work_share_links
  for update using (created_by = auth.uid())
  with check (created_by = auth.uid());

create policy work_share_links_delete on public.work_share_links
  for delete using (created_by = auth.uid());

-- WORK_SHARE_VIEWS: only the share link creator can read analytics.
-- INSERT is via SECURITY DEFINER function (public route, no auth).
drop policy if exists work_share_views_select on public.work_share_views;
drop policy if exists work_share_views_insert on public.work_share_views;

create policy work_share_views_select on public.work_share_views
  for select using (
    exists (
      select 1 from public.work_share_links sl
      where sl.id = work_share_views.share_link_id
        and sl.created_by = auth.uid()
    )
  );

-- INSERT via SECURITY DEFINER function (see below) — no direct INSERT policy.
-- The public share route calls the function, not a direct INSERT.

-- ============ INCREMENT VIEW COUNT + LOG VIEW ============
-- SECURITY DEFINER function called by the public share route.
-- Atomically increments view_count + inserts a share_views row.
-- This bypasses RLS so anonymous viewers (no auth.uid()) can trigger it.
create or replace function public.record_work_share_view(
  p_token text,
  p_ip_hash text default null,
  p_country text default null,
  p_user_agent text default null,
  p_referrer text default null
)
returns uuid  -- returns the share_link_id (null if token not found/revoked/expired)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_link record;
  v_link_id uuid;
begin
  -- Find the share link by token (must be active, not revoked, not expired, not exhausted).
  select * into v_link
  from public.work_share_links
  where token = p_token
    and revoked_at is null
    and (expires_at is null or expires_at > now())
    and (max_views is null or view_count < max_views);

  if not found then
    return null;
  end if;

  v_link_id := v_link.id;

  -- Atomically increment view_count (conditional — prevents over-counting).
  update public.work_share_links
  set view_count = view_count + 1
  where id = v_link_id
    and (max_views is null or view_count < max_views);

  -- Log the view.
  insert into public.work_share_views (
    share_link_id, ip_hash, country, user_agent, referrer
  ) values (
    v_link_id,
    p_ip_hash,
    p_country,
    left(p_user_agent, 500),
    left(p_referrer, 500)
  );

  return v_link_id;
end;
$function$;

comment on function public.record_work_share_view(text, text, text, text, text) is
  'Atomically increments view_count + logs a share view. SECURITY DEFINER. Returns the share_link_id (null if invalid/revoked/expired/exhausted).';

-- ============ UPDATE DWELL TIME ============
-- Called when the viewer navigates away (beacon API) to record how long they stayed.
create or replace function public.update_work_share_dwell(
  p_share_link_id uuid,
  p_duration_ms int
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.work_share_views
  set duration_ms = p_duration_ms
  where id = (
    select id from public.work_share_views
    where share_link_id = p_share_link_id
    order by viewed_at desc
    limit 1
  );
$$;

comment on function public.update_work_share_dwell(uuid, int) is
  'Updates the most recent share_view with dwell time. Called via beacon API on viewer exit.';

-- ============ GRANT EXECUTE ============
revoke execute on function public.record_work_share_view(text, text, text, text, text) from public;
revoke execute on function public.update_work_share_dwell(uuid, int) from public;
grant execute on function public.record_work_share_view(text, text, text, text, text) to anon, authenticated;
grant execute on function public.update_work_share_dwell(uuid, int) to anon, authenticated;
