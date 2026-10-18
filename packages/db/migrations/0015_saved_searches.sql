-- ============ SAVED SEARCHES & SEARCH HISTORY ============
-- Persists user searches so they can be re-run, pinned to the sidebar,
-- and used for analytics ("most searched terms in this workspace").

-- ============ SAVED_SEARCHES ============
-- User-saved search queries (named, re-runnable).
create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null,  -- FK to auth.users via raw SQL
  name text not null check (char_length(name) between 1 and 100),
  params jsonb not null,   -- the full SearchParams object, serialized
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_saved_searches_workspace
  on public.saved_searches(workspace_id, pinned desc, updated_at desc);
create index if not exists idx_saved_searches_owner
  on public.saved_searches(owner_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'saved_searches_owner_id_fkey'
      and table_name = 'saved_searches'
  ) then
    alter table public.saved_searches
      add constraint saved_searches_owner_id_fkey
      foreign key (owner_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ SEARCH_HISTORY ============
-- Every search query (for autocomplete + analytics).
-- Rows are auto-trimmed after 90 days via a cron (future).
create table if not exists public.search_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,  -- FK to auth.users via raw SQL
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  query text not null check (char_length(query) <= 500),
  filters jsonb,          -- { type, folderId, tagIds, favorite, ownerId } if present
  result_count int check (result_count is null or result_count >= 0),
  tier text,              -- 'fts' | 'trigram' | 'filter' | 'fallback' (which tier was used)
  created_at timestamptz not null default now()
);

create index if not exists idx_search_history_user
  on public.search_history(user_id, created_at desc);
-- Avoid a time-based partial predicate: now() is not IMMUTABLE in PostgreSQL.
create index if not exists idx_search_history_workspace
  on public.search_history(workspace_id, created_at desc);
create index if not exists idx_search_history_query
  on public.search_history(workspace_id, query, created_at desc);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'search_history_user_id_fkey'
      and table_name = 'search_history'
  ) then
    alter table public.search_history
      add constraint search_history_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ RLS ============
alter table public.saved_searches enable row level security;
alter table public.search_history enable row level security;

-- SAVED_SEARCHES: owner can CRUD; workspace members can read (for shared searches).
drop policy if exists saved_searches_select on public.saved_searches;
drop policy if exists saved_searches_insert on public.saved_searches;
drop policy if exists saved_searches_update on public.saved_searches;
drop policy if exists saved_searches_delete on public.saved_searches;

create policy saved_searches_select on public.saved_searches
  for select using (
    owner_id = auth.uid()
    or public.is_workspace_member(workspace_id)
  );

create policy saved_searches_insert on public.saved_searches
  for insert with check (
    owner_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy saved_searches_update on public.saved_searches
  for update using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy saved_searches_delete on public.saved_searches
  for delete using (owner_id = auth.uid());

-- SEARCH_HISTORY: user sees only their own history.
drop policy if exists search_history_select on public.search_history;
drop policy if exists search_history_insert on public.search_history;
drop policy if exists search_history_delete on public.search_history;

create policy search_history_select on public.search_history
  for select using (user_id = auth.uid());

create policy search_history_insert on public.search_history
  for insert with check (user_id = auth.uid());

create policy search_history_delete on public.search_history
  for delete using (user_id = auth.uid());

-- ============ UPDATED_AT TRIGGER (saved_searches) ============
create or replace function public.touch_saved_searches_updated_at()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_saved_searches_touch on public.saved_searches;
create trigger trg_saved_searches_touch
before update on public.saved_searches
for each row execute function public.touch_saved_searches_updated_at();
