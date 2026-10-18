-- ───────────────────────────────────────────────
-- 0035_seat_counting.sql
-- active_seat_count(_ws) — security-definer function that counts active seats.
--
-- Used by the billing gate (checkSeatAvailable) + the invite flow (seat cap
-- enforcement). SECURITY DEFINER so it can read memberships without RLS
-- (the caller might not be a member yet — e.g. during invite acceptance).
--
-- FIX from the pasted spec: the function body was corrupted (no spaces,
-- duplicated fragments, invisible Unicode zero-width chars in `wsi​d`).
-- Replaced with a clean single-statement function.
-- ───────────────────────────────────────────────

create or replace function active_seat_count(_ws uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.memberships
  where ws_id = _ws and status in ('active', 'invited')
$$;

comment on function active_seat_count(uuid) is
  'Security-definer: count active+invited seats for a workspace. Used by the billing gate (seat cap) + invite flow. Counts invited (not just active) so pending invites reserve a seat.';

-- Grant execute to supa_app + supa_system.
grant execute on function active_seat_count(uuid) to supa_app;
grant execute on function active_seat_count(uuid) to supa_system;
