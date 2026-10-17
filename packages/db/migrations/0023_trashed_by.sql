-- ============ WORK_ITEMS: trashed_by column ============
-- Tracks WHO trashed an item (for audit + restore permissions).
-- RLS already restricts trash visibility to the owner, but trashed_by
-- lets workspace admins see "who deleted this" in the admin panel.

alter table public.work_items
  add column if not exists trashed_by uuid;

comment on column public.work_items.trashed_by is
  'User ID who trashed this item. Cleared on restore. FK to auth.users.';

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'work_items_trashed_by_fkey'
      and table_name = 'work_items'
  ) then
    alter table public.work_items
      add constraint work_items_trashed_by_fkey
      foreign key (trashed_by) references auth.users(id) on delete set null;
  end if;
end $$;

-- ============ AUTO-CLEAR TRASHED_BY ON RESTORE ============
-- When status transitions back to 'active', clear trashed_by + trashed_at.
create or replace function public.clear_trash_fields_on_restore()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  if new.status = 'active' and old.status = 'trash' then
    new.trashed_at := null;
    new.trashed_by := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_work_items_clear_trash on public.work_items;
create trigger trg_work_items_clear_trash
before update of status on public.work_items
for each row execute function public.clear_trash_fields_on_restore();

-- ============ AUTO-SET TRASHED_BY ON TRASH ============
-- When status transitions to 'trash', set trashed_by if not already set.
-- This trigger runs AFTER the clear_trash trigger (alphabetical order:
-- clear_trash_fields_on_restore < set_trash_fields_on_trash), so
-- restoring then re-trashing works correctly.
create or replace function public.set_trash_fields_on_trash()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  if new.status = 'trash' and (old.status is null or old.status <> 'trash') then
    if new.trashed_at is null then
      new.trashed_at := now();
    end if;
    -- trashed_by is set by the app (we know the user ID there).
    -- If the app didn't set it, leave it null (the trigger can't know auth.uid()
    -- without a SECURITY DEFINER function call, which would be slow per-row).
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_work_items_set_trash on public.work_items;
create trigger trg_work_items_set_trash
before update of status on public.work_items
for each row execute function public.set_trash_fields_on_trash();

-- ============ AUTO-PURGE TRASH AFTER 30 DAYS ============
-- Scheduled via cron — marks trashed items as permanently deleted after 30 days.
-- The actual hard-delete is done by the purge-deletions cron (already built).
-- This function just finds expired trash items and calls the cleanup.

create or replace function public.purge_expired_trash(p_retention_days int default 30)
returns table(item_id uuid, workspace_id uuid)
language plpgsql
security definer
set search_path = public
as $function$
begin
  -- Return items that have been in trash for longer than the retention period.
  -- The caller (cron) handles the actual deletion + file cleanup.
  return query
  select id, workspace_id
  from public.work_items
  where status = 'trash'
    and trashed_at is not null
    and trashed_at < now() - (p_retention_days || ' days')::interval;
end;
$function$;

comment on function public.purge_expired_trash(int) is
  'Returns IDs of items that have been in trash longer than the retention period. Called by the daily purge cron.';
