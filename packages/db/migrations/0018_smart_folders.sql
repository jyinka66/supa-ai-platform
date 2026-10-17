-- ============ SMART FOLDERS ============
-- Adds `type` and `smart_params` columns to `work_folders`.
--
-- Smart folders are saved filters rendered as folders — no actual items
-- are stored in them. The `smart_params` JSONB blob contains the full
-- SearchParams that define what the folder "contains".
--
-- Example smart_params:
--   {
--     "query": "",
--     "type": "invoice",
--     "favorite": true,
--     "tags": ["urgent"]
--   }
--
-- Smart folders:
--   - Can't have children (can't be a parent of other folders)
--   - Don't participate in ltree path queries (they're virtual)
--   - Are computed at query time by calling searchWorkItems(smart_params)
--   - Can be nested under manual folders for organization
--
-- Manual folders (default):
--   - Can have children
--   - Use the ltree path for subtree queries
--   - Items reference them via work_items.folder_id

alter table public.work_folders
  add column if not exists type text not null default 'manual'
    check (type in ('manual', 'smart'));

alter table public.work_folders
  add column if not exists smart_params jsonb;

comment on column public.work_folders.type is
  'manual = real folder with items; smart = virtual folder backed by a saved filter';
comment on column public.work_folders.smart_params is
  'SearchParams JSONB — only set when type=smart. Contains query + filters that define the folder contents.';

-- Smart folders can't have children — enforce via trigger.
-- (A trigger is needed because CHECK constraints can't reference other rows.)
create or replace function public.prevent_smart_folder_children()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
declare
  v_parent_type text;
begin
  if new.parent_id is not null then
    select type into v_parent_type from public.work_folders where id = new.parent_id;
    if v_parent_type = 'smart' then
      raise exception 'smart_folder_cannot_have_children' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_prevent_smart_folder_children on public.work_folders;
create trigger trg_prevent_smart_folder_children
before insert or update of parent_id on public.work_folders
for each row execute function public.prevent_smart_folder_children();

-- Index for filtering smart folders.
create index if not exists idx_work_folders_type
  on public.work_folders(workspace_id, type)
  where type = 'smart';
