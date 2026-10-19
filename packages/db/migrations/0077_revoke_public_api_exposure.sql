-- 0077_revoke_public_api_exposure.sql
-- Closes API exposure reported by the Supabase security advisor.
--
-- anon and authenticated are the roles PostgREST uses for browser requests, and
-- the anon key is public by design. Anything granted to them is reachable by
-- anyone holding that key. These objects are server-side only, so they are
-- removed from the API roles. service_role, postgres, supa_app and supa_system
-- keep whatever access they effectively have today.

-- 1. Analytics views. They run with the owner's rights and bypass RLS, and the
--    API roles held full read and write grants on them. Only the server reads
--    them (admin metrics route), so no API role needs access.
revoke all on table
  public.failure_forensics,
  public.conversation_activity_hourly,
  public.workspace_budget_burn,
  public.share_link_usage,
  public.request_trace,
  public.provider_stats_daily
from public, anon, authenticated;

-- 2. Server-only SECURITY DEFINER functions and trigger functions.
--    Several of these are also open through PUBLIC, so PUBLIC is revoked too.
--    supa_app and supa_system are re-granted only where they can execute the
--    function today, so their access is preserved and never widened.
do $$
declare
  fn regprocedure;
  keep_app boolean;
  keep_system boolean;
  signatures text[] := array[
    -- callable only from the server
    'public.active_seat_count(uuid)',
    'public.admin_audit_log_append(text,text,jsonb,text,jsonb,inet,text)',
    'public.admin_audit_log_verify_chain()',
    'public.count_failed_views(uuid,integer)',
    'public.create_workspace(text,text,text,uuid)',
    'public.enterprise_audit_log_append(uuid,text,text,text,jsonb,inet,text)',
    'public.governance_decision_log_append(text,text,jsonb,jsonb,text,jsonb)',
    'public.governance_decision_log_verify_chain()',
    'public.move_work_folder(uuid,uuid,uuid)',
    'public.purge_expired_trash(integer)',
    'public.record_share_view(uuid,text,boolean)',
    'public.record_work_share_view(text,text,text,text,text)',
    'public.rename_work_folder(uuid,text,uuid)',
    'public.revoke_expired_shares()',
    'public.update_work_share_dwell(uuid,integer)',
    'public.upsert_work_item_view(uuid,uuid)',
    -- trigger functions (no EXECUTE needed by the role that fires the trigger)
    'public.bump_work_item_version()',
    'public.clear_trash_fields_on_restore()',
    'public.prevent_smart_folder_children()',
    'public.set_export_job_expiry()',
    'public.set_trash_fields_on_trash()',
    'public.touch_conversation_updated_at()',
    'public.touch_export_jobs_updated_at()',
    'public.touch_saved_searches_updated_at()',
    'public.touch_work_items_updated_at()',
    'public.work_folders_set_path()',
    'public.work_items_search_vector()'
  ];
  sig text;
begin
  foreach sig in array signatures loop
    fn := sig::regprocedure;
    keep_app := has_function_privilege('supa_app', fn, 'EXECUTE');
    keep_system := has_function_privilege('supa_system', fn, 'EXECUTE');

    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
    if keep_app then
      execute format('grant execute on function %s to supa_app', fn);
    end if;
    if keep_system then
      execute format('grant execute on function %s to supa_system', fn);
    end if;
  end loop;
end
$$;

-- 3. create_workspace(text, text, uuid) is called from the signed-in app route
--    through the user's own session, so authenticated keeps EXECUTE. The
--    function trusted p_owner_id from the caller, which let any caller create a
--    workspace owned by someone else. A signed-in caller may now only create a
--    workspace they own. Trusted server roles have no JWT and are unaffected.
create or replace function public.create_workspace(p_name text, p_slug text, p_owner_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ws_id uuid;
  v_existing_slug text;
begin
  if auth.uid() is not null and p_owner_id is distinct from auth.uid() then
    raise exception 'owner_mismatch' using errcode = '42501';
  end if;

  -- Reject if slug already taken.
  select slug into v_existing_slug from public.workspaces where slug = p_slug for update;
  if v_existing_slug is not null then
    raise exception 'Slug % already in use', p_slug
      using errcode = 'unique_violation';
  end if;

  insert into public.workspaces (slug, name, is_personal, billing_owner_id)
  values (p_slug, p_name, false, p_owner_id)
  returning id into v_ws_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws_id, p_owner_id, 'owner')
  on conflict do nothing;

  return v_ws_id;
end;
$function$;

-- Anonymous callers have no business creating workspaces.
revoke execute on function public.create_workspace(text, text, uuid) from public, anon;
grant execute on function public.create_workspace(text, text, uuid) to authenticated, service_role;
