-- ───────────────────────────────────────────────
-- 0045_share_views_fn.sql
-- Security-definer functions for the public share resolution route.
--
-- WHY: the public share route (GET /api/shares/[token]) has NO user context.
-- RLS on share_links/share_views denies all writes + most reads for anon.
-- But the route must:
--   1. INSERT share_views rows (success + failed-password attempts).
--   2. Atomically increment share_links.view_count (race-safe under concurrency).
--   3. Count recent failed views (for the password rate-limit).
--
-- These are the ONLY paths that write share_views or increment view_count.
-- The functions are SECURITY DEFINER (owned by postgres, bypass RLS) with
-- `set search_path = public` (injection defense).
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- record_share_view(p_share_id, p_ip_hash, p_ok)
--
-- Records a view attempt. When p_ok = true:
--   1. Atomically increments view_count IF the link is still valid
--      (not revoked, not expired, view_count < max_views).
--   2. Inserts the share_views row.
--   3. Returns true (admitted) or false (link became invalid concurrently —
--      the caller must deny).
--
-- When p_ok = false (failed password):
--   1. Inserts the share_views row only (no increment).
--   2. Returns true (always — failed views are always recorded).
--
-- The atomic conditional UPDATE prevents the race where two concurrent
-- requests both read view_count=N and both write N+1. The WHERE clause
-- is re-evaluated at UPDATE time, so if max_views is reached between the
-- read and the write, the UPDATE matches 0 rows → admitted=false.
-- ───────────────────────────────────────────────

create or replace function record_share_view(
  p_share_id uuid,
  p_ip_hash text,
  p_ok boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  admitted boolean := false;
begin
  if p_ok then
    -- Atomic conditional increment — the WHERE clause is the quota gate.
    -- RETURNING true → admitted; no row → link became invalid concurrently.
    update share_links
       set view_count = view_count + 1
     where id = p_share_id
       and revoked_at is null
       and (expires_at is null or expires_at > now())
       and (max_views is null or view_count < max_views)
    returning true into admitted;

    if admitted then
      insert into share_views (share_id, viewed_at, ip_hash, ok)
      values (p_share_id, now(), p_ip_hash, true);
      return true;
    else
      -- Link became invalid between the caller's read and this write.
      -- Do NOT insert a view row — the caller will deny "not_found".
      return false;
    end if;
  else
    -- Failed password attempt — log only, no increment.
    insert into share_views (share_id, viewed_at, ip_hash, ok)
    values (p_share_id, now(), p_ip_hash, false);
    return true;
  end if;
end;
$$;

-- ───────────────────────────────────────────────
-- count_failed_views(p_share_id, p_minutes)
--
-- Counts failed (ok = false) views in the last N minutes.
-- Used by the password rate-limit (> 10 failures / 15 min → rate_limited).
-- ───────────────────────────────────────────────

create or replace function count_failed_views(
  p_share_id uuid,
  p_minutes integer
)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from share_views
   where share_id = p_share_id
     and ok = false
     and viewed_at > now() - (p_minutes || ' minutes')::interval;
$$;

-- ───────────────────────────────────────────────
-- revoke_expired_shares()
--
-- Hard-revokes expired links (nightly sweeper). Idempotent: only updates
-- rows where revoked_at IS NULL. The lazy expiry check in resolve() already
-- denies expired links; this just cleans up the DB so the index
-- `where revoked_at is null` stays small.
-- ───────────────────────────────────────────────

create or replace function revoke_expired_shares()
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update share_links
       set revoked_at = now()
     where expires_at is not null
       and expires_at < now()
       and revoked_at is null
    returning 1
  )
  select count(*)::integer from updated;
$$;

-- ───────────────────────────────────────────────
-- Permissions: only supa_app (the app role) can call these.
-- ───────────────────────────────────────────────

revoke execute on record_share_view from public;
revoke execute on count_failed_views from public;
revoke execute on revoke_expired_shares from public;

grant execute on record_share_view to supa_app;
grant execute on count_failed_views to supa_app;
grant execute on revoke_expired_shares to supa_app;

comment on function record_share_view(uuid, text, boolean) is
  'Security-definer: atomic view admission + share_views insert. Public route only.';
comment on function count_failed_views(uuid, integer) is
  'Security-definer: failed-view count for password rate-limit. Public route only.';
comment on function revoke_expired_shares() is
  'Security-definer: hard-revoke expired links (nightly sweeper). Idempotent.';
