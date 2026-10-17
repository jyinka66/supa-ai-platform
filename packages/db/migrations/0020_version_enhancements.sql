-- ============ WORK_ITEM_VERSIONS ENHANCEMENTS ============
-- Adds `storage_key` + `source` columns to the existing work_item_versions table.
--
-- `storage_key` — for file items: the storage path of the file snapshot
--   (so you can restore a previous version's file, not just its text content).
--   Renamed from `file_url` (which was the column name in migration 0014)
--   to match the storage layout: {workspace_id}/{item_id}/versions/{version}/original.{ext}
--
-- `source` — what caused the version to be created:
--   'edit'    — user edited the content/title in the UI
--   'restore' — user restored from a previous version
--   'import'  — imported from an external source (upload, paste, API)
--   'ai'      — AI-generated content (chat reply, agent output, auto-summarize)

-- Add storage_key (for file snapshots — nullable, only set for file items).
alter table public.work_item_versions
  add column if not exists storage_key text;

-- Add source (defaults to 'edit').
alter table public.work_item_versions
  add column if not exists source text not null default 'edit'
    check (source in ('edit', 'restore', 'import', 'ai'));

-- Rename file_url → storage_key if it exists (migration 0014 created it as file_url).
-- We can't ALTER COLUMN RENAME conditionally, so we do it via DO block.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'work_item_versions'
      and column_name = 'file_url'
      and table_schema = 'public'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'work_item_versions'
      and column_name = 'storage_key'
      and table_schema = 'public'
  ) then
    alter table public.work_item_versions rename column file_url to storage_key;
  end if;
end $$;

-- If both file_url and storage_key exist (because the ADD COLUMN ran before the rename),
-- migrate the data + drop the old column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'work_item_versions'
      and column_name = 'file_url'
      and table_schema = 'public'
  ) and exists (
    select 1 from information_schema.columns
    where table_name = 'work_item_versions'
      and column_name = 'storage_key'
      and table_schema = 'public'
  ) then
    update public.work_item_versions set storage_key = file_url where storage_key is null and file_url is not null;
    alter table public.work_item_versions drop column file_url;
  end if;
end $$;

comment on column public.work_item_versions.storage_key is
  'Storage path for file snapshots (file items only). Null for text-only items.';
comment on column public.work_item_versions.source is
  'edit | restore | import | ai — what caused this version to be created.';

-- Add FK to auth.users for editor_id (migration 0014 set this up via raw SQL,
-- but the column was named edited_by. Add editor_id as an alias if it doesn't exist.)
-- Actually, migration 0014 already has edited_by. Let's not rename — just use the existing column.
-- The `source` column is the only new thing that matters for the app.

-- ============ VERSION TRIGGER ============
-- Auto-increments current_version on the parent work_items row when a new version is inserted.
-- This keeps work_items.current_version in sync with work_item_versions without app-layer coordination.
create or replace function public.bump_work_item_version()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  -- If version wasn't set by the caller, auto-assign the next version number.
  if new.version is null or new.version = 0 then
    select coalesce(max(version), 0) + 1 into new.version
    from public.work_item_versions
    where item_id = new.item_id;
  end if;

  -- Update the parent's current_version + updated_at.
  update public.work_items
  set current_version = new.version,
      updated_at = now()
  where id = new.item_id;

  return new;
end;
$function$;

drop trigger if exists trg_work_item_versions_bump on public.work_item_versions;
create trigger trg_work_item_versions_bump
before insert on public.work_item_versions
for each row execute function public.bump_work_item_version();
