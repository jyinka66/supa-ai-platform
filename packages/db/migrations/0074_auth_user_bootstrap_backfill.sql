-- 0074_auth_user_bootstrap_backfill.sql
-- Repair accounts created before the missing identity bootstrap migration was
-- applied, and make future signup provisioning create a consistent personal
-- workspace. Idempotent: safe to rerun without duplicating users/workspaces.

create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
declare
  v_ws_id uuid;
  v_name text;
begin
  v_name := nullif(trim(new.raw_user_meta_data->>'full_name'), '');

  insert into public.profiles (id, full_name, language, email_verified_at)
  values (
    new.id,
    v_name,
    coalesce(nullif(new.raw_user_meta_data->>'language', ''), 'en'),
    new.email_confirmed_at
  )
  on conflict (id) do nothing;

  insert into public.workspaces (
    slug, name, is_personal, billing_owner_id, kind
  )
  values (
    'u-' || new.id::text,
    coalesce(v_name, 'Personal'),
    true,
    new.id,
    'personal'
  )
  on conflict (slug) do nothing
  returning id into v_ws_id;

  if v_ws_id is null then
    select id into v_ws_id
    from public.workspaces
    where slug = 'u-' || new.id::text;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws_id, new.id, 'owner')
  on conflict do nothing;

  perform pg_notify('signup_audit', json_build_object(
    'user_id', new.id, 'at', now(), 'ok', true
  )::text);
  return new;
exception when others then
  -- Do not make authentication unavailable because workspace provisioning
  -- failed; the failure remains observable to the signup_audit listener.
  perform pg_notify('signup_audit', json_build_object(
    'user_id', new.id, 'at', now(), 'ok', false, 'error', SQLERRM
  )::text);
  return new;
end;
$function$;

-- Existing auth users do not fire an AFTER INSERT trigger retroactively.
insert into public.profiles (id, full_name, language, email_verified_at)
select
  u.id,
  nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
  coalesce(nullif(u.raw_user_meta_data->>'language', ''), 'en'),
  u.email_confirmed_at
from auth.users u
on conflict (id) do nothing;

insert into public.workspaces (
  slug, name, is_personal, billing_owner_id, kind
)
select
  'u-' || u.id::text,
  coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), 'Personal'),
  true,
  u.id,
  'personal'
from auth.users u
on conflict (slug) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
select w.id, u.id, 'owner'::public.workspace_role
from auth.users u
join public.workspaces w on w.slug = 'u-' || u.id::text
on conflict do nothing;
