-- 0075_lock_down_rls_auto_enable_rpc.sql
-- This function is intended to execute only as a PostgreSQL DDL event trigger,
-- not as a user-callable PostgREST RPC. Keep the existing event trigger while
-- removing direct execution grants from browser/API roles.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
