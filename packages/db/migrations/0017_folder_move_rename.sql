-- ============ FOLDER MOVE / RENAME HELPERS ============
-- SQL functions for moving/renaming folders with ltree subtree updates.
--
-- Moving a folder requires rewriting the `path` of the folder AND all its
-- descendants. Using ltree's `<@` (ancestor) operator, this is a single
-- UPDATE statement.
--
-- The functions are SECURITY DEFINER so callers with INSERT permission
-- on work_folders can move folders they own, even though RLS UPDATE
-- only allows the creator to modify.

-- ============ MOVE FOLDER ============
-- Moves a folder (and its entire subtree) under a new parent.
--
-- @param p_folder_id    The folder to move.
-- @param p_new_parent_id The new parent folder ID (null = root).
-- @param p_user_id      The caller (for ownership verification).
--
-- Returns: void
-- Throws: 'not_found' if folder doesn't exist
--         'forbidden' if caller isn't the creator
--         'cycle' if the move would create a cycle (folder moved under itself)
create or replace function public.move_work_folder(
  p_folder_id uuid,
  p_new_parent_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_folder     record;
  v_new_parent record;
  v_old_path   ltree;
  v_new_path   ltree;
  v_old_depth  integer;
begin
  -- Load the folder being moved.
  select id, path, parent_id, created_by, workspace_id
    into v_folder
  from public.work_folders
  where id = p_folder_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Verify ownership.
  if v_folder.created_by <> p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Handle new parent.
  if p_new_parent_id is null then
    -- Moving to root.
    v_new_path := regexp_replace(v_folder.id::text, '[^a-zA-Z0-9_]', '_', 'g')::ltree;
  else
    -- Load the new parent.
    select id, path, workspace_id
      into v_new_parent
    from public.work_folders
    where id = p_new_parent_id;

    if not found then
      raise exception 'parent_not_found' using errcode = 'P0002';
    end if;

    -- Verify same workspace.
    if v_new_parent.workspace_id <> v_folder.workspace_id then
      raise exception 'cross_workspace' using errcode = '42501';
    end if;

    -- Detect cycle: new parent must not be a descendant of the folder being moved.
    if v_new_parent.path <@ v_folder.path or v_new_parent.path = v_folder.path then
      raise exception 'cycle_detected' using errcode = '42501';
    end if;

    -- Build the new path.
    v_new_path := v_new_parent.path || regexp_replace(v_folder.id::text, '[^a-zA-Z0-9_]', '_', 'g')::ltree;
  end if;

  v_old_path := v_folder.path;
  v_old_depth := nlevel(v_old_path);

  -- Rewrite the folder + all descendants in a single UPDATE.
  -- For each descendant: new_path = new_parent_path || subpath(old_path, old_depth)
  --   - The folder itself: subpath = '' → new_path = new_parent_path
  --   - A child: old_path = X/Y/child → subpath(old, depth_of_X) = Y/child
  --     → new_path = new_parent_path || Y/child
  update public.work_folders
  set path = v_new_path || subpath(path, v_old_depth)
  where path <@ v_old_path;

  -- Update the parent_id on the moved folder.
  update public.work_folders
  set parent_id = p_new_parent_id
  where id = p_folder_id;
end;
$function$;

comment on function public.move_work_folder(uuid, uuid, uuid) is
  'Moves a folder (and its subtree) under a new parent. SECURITY DEFINER. Verifies ownership + prevents cycles.';

-- ============ RENAME FOLDER ============
-- Renames a folder. The `path` ltree column is NOT affected (it's based on
-- the folder's UUID, not its name). Only the `name` column changes.
--
-- @param p_folder_id  The folder to rename.
-- @param p_new_name    The new name.
-- @param p_user_id     The caller (for ownership verification).
create or replace function public.rename_work_folder(
  p_folder_id uuid,
  p_new_name text,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_created_by uuid;
  v_workspace_id uuid;
  v_parent_id uuid;
begin
  -- Load the folder.
  select created_by, workspace_id, parent_id
    into v_created_by, v_workspace_id, v_parent_id
  from public.work_folders
  where id = p_folder_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Verify ownership.
  if v_created_by <> p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Check for name conflict at the same level.
  if exists (
    select 1 from public.work_folders
    where workspace_id = v_workspace_id
      and parent_id is not distinct from v_parent_id
      and name = p_new_name
      and id <> p_folder_id
  ) then
    raise exception 'name_conflict' using errcode = '23505';
  end if;

  -- Rename.
  update public.work_folders
  set name = p_new_name
  where id = p_folder_id;
end;
$function$;

comment on function public.rename_work_folder(uuid, text, uuid) is
  'Renames a folder. SECURITY DEFINER. Verifies ownership + checks for name conflicts.';

-- ============ GRANT EXECUTE ============
revoke execute on function public.move_work_folder(uuid, uuid, uuid) from public;
revoke execute on function public.rename_work_folder(uuid, text, uuid) from public;
grant execute on function public.move_work_folder(uuid, uuid, uuid) to authenticated;
grant execute on function public.rename_work_folder(uuid, text, uuid) to authenticated;
