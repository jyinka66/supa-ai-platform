-- 0076_lock_down_trigger_functions.sql
-- These SECURITY DEFINER functions are execution hooks, not public RPC APIs.
-- Do not expose trigger-only functions through PostgREST.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.guard_last_workspace_owner() from public, anon, authenticated;

-- Workspace helper functions intentionally remain callable by signed-in users
-- because RLS policies and the currentRole() client helper depend on them.
-- Anonymous callers gain nothing from calling them; remove anon access while
-- preserving authenticated access.
revoke execute on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
revoke execute on function public.workspace_role(uuid) from public, anon;
grant execute on function public.workspace_role(uuid) to authenticated, service_role;
