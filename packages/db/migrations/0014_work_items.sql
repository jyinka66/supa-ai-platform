-- ============ WORK ITEMS ============
-- Unified content storage table.
--
-- Design principle: content and file are SEPARATE columns on the same row.
-- Some items are text-native (proposals, code), some are binary (images, PDFs),
-- most are both (an invoice has rendered HTML AND a PDF).
--
-- This table consolidates what would otherwise be 8+ separate tables
-- (documents, designs, invoices, plans, translations, code snippets,
-- images, agent outputs) into one with a discriminating `type` column.
--
-- NOTE: references to `auth.users(id)` are set via raw SQL below (Drizzle
-- can't reference the auth schema). The `folders` table from migration 0003
-- is `conversation_folders` — this migration creates a NEW `folders` table
-- for work items (different domain: conversations vs. work items).
-- If you want to unify them, rename `conversation_folders` → `folders` and
-- add a `type` column ('conversation' | 'work_item'). For now, they're
-- separate to avoid coupling.

-- ============ EXTENSIONS ============
create extension if not exists ltree;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ============ FOLDERS (work-item folders, separate from conversation_folders) ============
-- Renamed to `work_folders` to avoid collision with `conversation_folders`.
create table if not exists public.work_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_id uuid references public.work_folders(id) on delete cascade,  -- null = root
  name text not null check (char_length(name) between 1 and 100),
  color text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  path ltree not null,                        -- materialized path for subtree queries
  created_by uuid not null,  -- FK to auth.users via raw SQL
  created_at timestamptz not null default now(),
  unique (workspace_id, parent_id, name)
);

create index if not exists idx_work_folders_workspace
  on public.work_folders(workspace_id, parent_id);
create index if not exists idx_work_folders_path
  on public.work_folders using gist(path);

-- FK to auth.users.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_folders_created_by_fkey'
      and table_name = 'work_folders'
  ) then
    alter table public.work_folders
      add constraint work_folders_created_by_fkey
      foreign key (created_by) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ WORK_ITEMS ============
create table if not exists public.work_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null,  -- FK to auth.users via raw SQL

  -- Identity
  title text not null default 'Untitled' check (char_length(title) <= 200),
  type text not null check (type in (
    'chat_reply', 'tool_output', 'design', 'invoice',
    'proposal', 'plan', 'translation', 'code',
    'image', 'document', 'agent_output', 'upload'
  )),
  status text not null default 'active' check (status in ('active', 'trash')),
  trashed_at timestamptz,

  -- Content (text-native items)
  content text,                -- markdown/HTML/JSON depending on type
  content_format text default 'markdown' check (content_format in ('markdown', 'html', 'json', 'code', 'none')),

  -- File (binary items)
  file_url text,               -- storage path, not public URL
  file_size bigint check (file_size is null or file_size >= 0),
  file_mime text,
  thumbnail_url text,

  -- Metadata (JSONB, type-specific: invoice total, design canvas size, model used...)
  metadata jsonb not null default '{}'::jsonb,

  -- Organization
  folder_id uuid references public.work_folders(id) on delete set null,
  favorite boolean not null default false,

  -- Sharing
  visibility text not null default 'private' check (visibility in ('private', 'workspace', 'link')),
  link_token text unique,                      -- set when visibility = 'link'
  link_expires_at timestamptz,
  link_password_hash text,

  -- Cross-module source
  source_type text,            -- 'conversation' | 'agent_run' | 'invoice_run' | ...
  source_id uuid,              -- points into the source module's table

  -- Versioning
  current_version int not null default 1 check (current_version >= 1),

  -- Search (populated by trigger, below)
  search_vector tsvector,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- FK to auth.users for owner_id.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_items_owner_id_fkey'
      and table_name = 'work_items'
  ) then
    alter table public.work_items
      add constraint work_items_owner_id_fkey
      foreign key (owner_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ INDEXES ============
create index if not exists work_items_search_idx
  on public.work_items using gin(search_vector);
create index if not exists work_items_ws_folder_idx
  on public.work_items(workspace_id, folder_id, updated_at desc);
create index if not exists work_items_ws_type_idx
  on public.work_items(workspace_id, type, updated_at desc);
create index if not exists work_items_ws_status_idx
  on public.work_items(workspace_id, status) where status = 'active';
create index if not exists work_items_trash_idx
  on public.work_items(workspace_id, trashed_at) where status = 'trash';
create index if not exists work_items_title_trgm_idx
  on public.work_items using gin(title gin_trgm_ops);
create index if not exists work_items_owner_fav_idx
  on public.work_items(owner_id) where favorite = true;
create index if not exists work_items_visibility_idx
  on public.work_items(visibility) where visibility != 'private';
create index if not exists work_items_source_idx
  on public.work_items(source_type, source_id) where source_type is not null;

-- ============ TAGS (flat, workspace-scoped) ============
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  unique (workspace_id, name)
);

create table if not exists public.work_item_tags (
  item_id uuid not null references public.work_items(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (item_id, tag_id)
);

create index if not exists idx_work_item_tags_tag
  on public.work_item_tags(tag_id);

-- ============ VERSIONS ============
create table if not exists public.work_item_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.work_items(id) on delete cascade,
  version int not null check (version >= 1),
  title text,
  content text,
  content_format text,
  metadata jsonb,
  file_url text,
  edited_by uuid,  -- FK to auth.users via raw SQL
  created_at timestamptz not null default now(),
  unique (item_id, version)
);

create index if not exists idx_work_item_versions_item
  on public.work_item_versions(item_id, version desc);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_item_versions_edited_by_fkey'
      and table_name = 'work_item_versions'
  ) then
    alter table public.work_item_versions
      add constraint work_item_versions_edited_by_fkey
      foreign key (edited_by) references auth.users(id) on delete set null;
  end if;
end $$;

-- ============ CROSS-MODULE LINKS ============
create table if not exists public.work_item_links (
  from_item_id uuid not null references public.work_items(id) on delete cascade,
  to_item_id uuid not null references public.work_items(id) on delete cascade,
  kind text not null default 'related' check (kind in ('source', 'related', 'derived')),
  created_by uuid,  -- FK to auth.users via raw SQL
  created_at timestamptz not null default now(),
  primary key (from_item_id, to_item_id, kind),
  check (from_item_id <> to_item_id)  -- no self-links
);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_item_links_created_by_fkey'
      and table_name = 'work_item_links'
  ) then
    alter table public.work_item_links
      add constraint work_item_links_created_by_fkey
      foreign key (created_by) references auth.users(id) on delete set null;
  end if;
end $$;

-- ============ SHARES (with specific users — Business/Enterprise) ============
create table if not exists public.work_item_shares (
  item_id uuid not null references public.work_items(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users via raw SQL
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  shared_by uuid not null,  -- FK to auth.users via raw SQL
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_item_shares_user_id_fkey'
      and table_name = 'work_item_shares'
  ) then
    alter table public.work_item_shares
      add constraint work_item_shares_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_item_shares_shared_by_fkey'
      and table_name = 'work_item_shares'
  ) then
    alter table public.work_item_shares
      add constraint work_item_shares_shared_by_fkey
      foreign key (shared_by) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ SEARCH VECTOR TRIGGER ============
-- Populates search_vector from title + content on INSERT/UPDATE.
--
-- Uses the 'simple' dictionary (NOT 'english') because:
--   - The platform runs in 10 languages; 'english' stemming would mangle
--     non-English words (e.g. Spanish "información" → "información" in
--     'simple' but "informac" in 'english').
--   - 'simple' does tokenization without stemming, so all languages are
--     indexed as-is. Combined with the trigram index (gin_trgm_ops), this
--     gives good multilingual search without per-row language configs.
--   - Per-language configs (with a `language` column + per-row `to_tsvector`)
--     will come in Part 2 — the simple approach handles 90% of queries now.
--
-- Weights: title gets weight 'A' (highest), content gets 'B'.
create or replace function public.work_items_search_vector()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  new.search_vector :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.content, '')), 'B');
  return new;
end;
$function$;

drop trigger if exists trg_work_items_search on public.work_items;
create trigger trg_work_items_search
before insert or update of title, content on public.work_items
for each row execute function public.work_items_search_vector();

-- ============ UPDATED_AT TRIGGER ============
create or replace function public.touch_work_items_updated_at()
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

drop trigger if exists trg_work_items_touch on public.work_items;
create trigger trg_work_items_touch
before update on public.work_items
for each row execute function public.touch_work_items_updated_at();

-- ============ FOLDER PATH TRIGGER ============
-- Auto-populates the `path` ltree column from the folder hierarchy.
-- Root folders get path = their own id (as a label).
-- Child folders get path = parent.path || their own id.
create or replace function public.work_folders_set_path()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
declare
  v_parent_path ltree;
  v_label text;
begin
  -- Sanitize the folder id into a valid ltree label (only alphanumeric + underscore).
  v_label := regexp_replace(new.id::text, '[^a-zA-Z0-9_]', '_', 'g');

  if new.parent_id is null then
    new.path := v_label::ltree;
  else
    select path into v_parent_path from public.work_folders where id = new.parent_id;
    if v_parent_path is null then
      new.path := v_label::ltree;
    else
      new.path := v_parent_path || v_label::ltree;
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_work_folders_path on public.work_folders;
create trigger trg_work_folders_path
before insert or update of parent_id on public.work_folders
for each row execute function public.work_folders_set_path();

-- ============ RLS ============
alter table public.work_items enable row level security;
alter table public.work_folders enable row level security;
alter table public.tags enable row level security;
alter table public.work_item_tags enable row level security;
alter table public.work_item_versions enable row level security;
alter table public.work_item_links enable row level security;
alter table public.work_item_shares enable row level security;

-- WORK_ITEMS: owner can do everything; workspace members can read workspace-visible items.
-- Trash is visible to the owner ONLY — other workspace members don't see
-- trashed items (prevents accidental restoration of deleted content).
drop policy if exists work_items_select on public.work_items;
drop policy if exists work_items_insert on public.work_items;
drop policy if exists work_items_update on public.work_items;
drop policy if exists work_items_delete on public.work_items;

-- SELECT: owner sees everything (including trash);
-- workspace members see active items with visibility='workspace';
-- shared users see items shared with them.
create policy work_items_select on public.work_items
  for select using (
    -- Owner sees all their items, including trash.
    owner_id = auth.uid()
    -- Workspace members see active items with workspace visibility.
    or (
      status = 'active'
      and visibility = 'workspace'
      and public.is_workspace_member(workspace_id)
    )
    -- Shared users see active items shared with them.
    or (
      status = 'active'
      and exists (
        select 1 from public.work_item_shares wis
        where wis.item_id = work_items.id
          and wis.user_id = auth.uid()
      )
    )
    -- Link-shared items (visibility='link') are readable via the public
    -- share route (which checks the token separately). RLS allows SELECT
    -- here so the route can read the row, but the route also checks the
    -- link_token + expiry + password before returning the content.
    or (
      status = 'active'
      and visibility = 'link'
      and link_token is not null
      and (link_expires_at is null or link_expires_at > now())
    )
  );

-- INSERT: any workspace member can create items (owned by themselves).
create policy work_items_insert on public.work_items
  for insert with check (
    owner_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    -- New items must start as 'active' (no inserting directly to trash).
    and status = 'active'
  );

-- UPDATE: owner can update; shared editors can update content/metadata only.
create policy work_items_update on public.work_items
  for update using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.work_item_shares wis
      where wis.item_id = work_items.id
        and wis.user_id = auth.uid()
        and wis.role = 'editor'
    )
  )
  -- WITH CHECK: shared editors can only change content/metadata, not owner/visibility.
  with check (
    owner_id = auth.uid()
    or (
      -- Shared editor: must still be shared with them.
      exists (
        select 1 from public.work_item_shares wis
        where wis.item_id = work_items.id
          and wis.user_id = auth.uid()
          and wis.role = 'editor'
      )
      -- Can't change ownership or workspace.
      and owner_id = work_items.owner_id
      and workspace_id = work_items.workspace_id
    )
  );

-- DELETE: owner only (hard delete). Soft-delete (status='trash') is an UPDATE.
create policy work_items_delete on public.work_items
  for delete using (owner_id = auth.uid());

-- WORK_FOLDERS: workspace members can read; creators can write.
drop policy if exists work_folders_select on public.work_folders;
drop policy if exists work_folders_insert on public.work_folders;
drop policy if exists work_folders_update on public.work_folders;
drop policy if exists work_folders_delete on public.work_folders;

create policy work_folders_select on public.work_folders
  for select using (public.is_workspace_member(workspace_id));

create policy work_folders_insert on public.work_folders
  for insert with check (
    created_by = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy work_folders_update on public.work_folders
  for update using (created_by = auth.uid());

create policy work_folders_delete on public.work_folders
  for delete using (created_by = auth.uid());

-- TAGS: workspace members can read; workspace admins/owners can create.
drop policy if exists tags_select on public.tags;
drop policy if exists tags_insert on public.tags;
drop policy if exists tags_update on public.tags;
drop policy if exists tags_delete on public.tags;

create policy tags_select on public.tags
  for select using (public.is_workspace_member(workspace_id));

create policy tags_insert on public.tags
  for insert with check (
    public.workspace_role(workspace_id) in ('owner', 'admin')
  );

create policy tags_update on public.tags
  for update using (public.workspace_role(workspace_id) in ('owner', 'admin'));

create policy tags_delete on public.tags
  for delete using (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- WORK_ITEM_TAGS: item owner + workspace admins can manage tags.
drop policy if exists work_item_tags_select on public.work_item_tags;
drop policy if exists work_item_tags_insert on public.work_item_tags;
drop policy if exists work_item_tags_delete on public.work_item_tags;

create policy work_item_tags_select on public.work_item_tags
  for select using (
    exists (select 1 from public.work_items where id = work_item_tags.item_id)
  );

create policy work_item_tags_insert on public.work_item_tags
  for insert with check (
    exists (
      select 1 from public.work_items
      where id = work_item_tags.item_id and owner_id = auth.uid()
    )
  );

create policy work_item_tags_delete on public.work_item_tags
  for delete using (
    exists (
      select 1 from public.work_items
      where id = work_item_tags.item_id and owner_id = auth.uid()
    )
  );

-- WORK_ITEM_VERSIONS: readable by anyone who can read the item; writable by owner.
drop policy if exists work_item_versions_select on public.work_item_versions;
drop policy if exists work_item_versions_insert on public.work_item_versions;

create policy work_item_versions_select on public.work_item_versions
  for select using (
    exists (select 1 from public.work_items where id = work_item_versions.item_id)
  );

create policy work_item_versions_insert on public.work_item_versions
  for insert with check (
    exists (
      select 1 from public.work_items
      where id = work_item_versions.item_id and owner_id = auth.uid()
    )
  );

-- WORK_ITEM_LINKS: item owner can create links.
drop policy if exists work_item_links_select on public.work_item_links;
drop policy if exists work_item_links_insert on public.work_item_links;
drop policy if exists work_item_links_delete on public.work_item_links;

create policy work_item_links_select on public.work_item_links
  for select using (
    exists (select 1 from public.work_items where id = work_item_links.from_item_id)
  );

create policy work_item_links_insert on public.work_item_links
  for insert with check (
    exists (
      select 1 from public.work_items
      where id = work_item_links.from_item_id and owner_id = auth.uid()
    )
  );

create policy work_item_links_delete on public.work_item_links
  for delete using (
    exists (
      select 1 from public.work_items
      where id = work_item_links.from_item_id and owner_id = auth.uid()
    )
  );

-- WORK_ITEM_SHARES: item owner can share; shared users can read.
drop policy if exists work_item_shares_select on public.work_item_shares;
drop policy if exists work_item_shares_insert on public.work_item_shares;
drop policy if exists work_item_shares_delete on public.work_item_shares;

create policy work_item_shares_select on public.work_item_shares
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.work_items
      where id = work_item_shares.item_id and owner_id = auth.uid()
    )
  );

create policy work_item_shares_insert on public.work_item_shares
  for insert with check (
    shared_by = auth.uid()
    and exists (
      select 1 from public.work_items
      where id = work_item_shares.item_id and owner_id = auth.uid()
    )
  );

create policy work_item_shares_delete on public.work_item_shares
  for delete using (
    exists (
      select 1 from public.work_items
      where id = work_item_shares.item_id and owner_id = auth.uid()
    )
  );
