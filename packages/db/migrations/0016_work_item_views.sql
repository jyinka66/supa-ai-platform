-- ============ WORK_ITEM_VIEWS ============
-- Lightweight "recently viewed" tracking.
--
-- One row per (user_id, item_id) — upserted on every view.
-- The `viewed_at` column is the last-view timestamp.
-- Used by the "Recently Viewed" section in the sidebar + the
-- `sort=recently_viewed` filter on /api/work/items.

create table if not exists public.work_item_views (
  user_id uuid not null,  -- FK to auth.users via raw SQL
  item_id uuid not null references public.work_items(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists idx_work_item_views_user
  on public.work_item_views(user_id, viewed_at desc);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_item_views_user_id_fkey'
      and table_name = 'work_item_views'
  ) then
    alter table public.work_item_views
      add constraint work_item_views_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ RLS ============
alter table public.work_item_views enable row level security;

drop policy if exists work_item_views_select on public.work_item_views;
drop policy if exists work_item_views_insert on public.work_item_views;
drop policy if exists work_item_views_delete on public.work_item_views;

-- User sees only their own view history.
create policy work_item_views_select on public.work_item_views
  for select using (user_id = auth.uid());

-- User can insert/upsert only their own views.
create policy work_item_views_insert on public.work_item_views
  for insert with check (user_id = auth.uid());

-- User can delete (clear) only their own views.
create policy work_item_views_delete on public.work_item_views
  for delete using (user_id = auth.uid());

-- ============ UPSERT TRIGGER ============
-- Instead of INSERT ... ON CONFLICT DO UPDATE (which RLS blocks on UPDATE
-- for non-owners), we use a SECURITY DEFINER function that does the upsert
-- as the owner. This lets the app call SELECT upsert_work_item_view(uid, iid)
-- instead of raw INSERT.
create or replace function public.upsert_work_item_view(
  p_user_id uuid,
  p_item_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.work_item_views (user_id, item_id, viewed_at)
  values (p_user_id, p_item_id, now())
  on conflict (user_id, item_id)
  do update set viewed_at = now();
$$;

comment on function public.upsert_work_item_view(uuid, uuid) is
  'Upserts a view record. SECURITY DEFINER so RLS UPDATE permission is bypassed.';
