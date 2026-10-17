-- ───────────────────────────────────────────────
-- 0046_residency.sql
-- Data residency — the spec's canonical design (migration 0010).
--
-- Creates the `regions` table (code PK + pg_dsn + s3_bucket), adds a FK
-- from workspaces.region → regions(code), and makes region IMMUTABLE after
-- workspace creation via a BEFORE UPDATE trigger.
--
-- DIVERGENCE from migration 0029 (which added workspaces.region):
--   - 0029 used short codes ('eu','us','apac') + a CHECK constraint.
--   - 0046 uses the spec's longer codes ('us-east','eu-west','ap-southeast').
--   - Existing rows are migrated: 'us'→'us-east', 'eu'→'eu-west', 'apac'→'ap-southeast'.
--   - The CHECK is dropped (the FK supersedes it — stricter + self-documenting).
--   - The column DEFAULT changes from 'us' to 'us-east'.
--   - The create_workspace() function default changes from 'eu' to 'us-east'.
--
-- IMMUTABILITY:
--   - No UPDATE policy grants on workspaces.region (RLS already blocks it).
--   - Defense-in-depth: a BEFORE UPDATE trigger RAISEs if NEW.region IS
--     DISTINCT FROM OLD.region. This catches direct DB edits (superuser,
--     migration drift) that bypass RLS.
--   - Grandfathered: existing ws keep their (migrated) region — that IS their
--     residency. No bulk re-pin.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- regions table — the region catalog (code PK + cluster routing config)
-- ───────────────────────────────────────────────

create table regions (
  code        text primary key,          -- 'us-east', 'eu-west', 'ap-southeast', ...
  pg_dsn      text not null,             -- this region's Supabase project DSN
  s3_bucket   text not null,             -- this region's object storage bucket
  created_at  timestamptz not null default now()
);

comment on table regions is
  'Region catalog — code PK, pg_dsn (per-region Supabase project), s3_bucket (per-region object storage). Seeded at deploy time; new regions require a migration.';

-- ───────────────────────────────────────────────
-- Seed the known regions. The pg_dsn + s3_bucket are placeholder values —
-- a deployment overrides these via a follow-up data migration or a seed
-- script. The codes are the canonical region identifiers used throughout
-- the app (workspaces.region, audit log, residency routing).
-- ───────────────────────────────────────────────

insert into regions (code, pg_dsn, s3_bucket) values
  ('us-east',     'postgresql://supa-us-east@db-us-east.supa.internal:5432/postgres', 'supa-us-east'),
  ('eu-west',     'postgresql://supa-eu-west@db-eu-west.supa.internal:5432/postgres', 'supa-eu-west'),
  ('ap-southeast','postgresql://supa-apac@db-ap-southeast.supa.internal:5432/postgres', 'supa-ap-southeast')
on conflict (code) do nothing;

-- ───────────────────────────────────────────────
-- Migrate existing workspaces.region values: short codes → spec codes.
-- This is the "grandfathering" — existing ws keep their residency, just
-- relabeled to the canonical code. Idempotent (WHERE region IN (short codes)).
-- ───────────────────────────────────────────────

update workspaces set region = 'us-east'      where region = 'us';
update workspaces set region = 'eu-west'      where region = 'eu';
update workspaces set region = 'ap-southeast' where region = 'apac';

-- ───────────────────────────────────────────────
-- Drop the old CHECK constraint (migration 0029) — the FK below is stricter
-- (region must reference an actual regions row, not just match a regex).
-- ───────────────────────────────────────────────

alter table workspaces drop constraint if exists workspaces_region_check;

-- ───────────────────────────────────────────────
-- Change the column DEFAULT to the spec's primary region.
-- New workspaces default to 'us-east' unless the caller specifies otherwise
-- (create_workspace() accepts a region param).
-- ───────────────────────────────────────────────

alter table workspaces alter column region set default 'us-east';

-- ───────────────────────────────────────────────
-- Add the FK: workspaces.region → regions(code).
-- ON DELETE RESTRICT — a region can't be deleted while any workspace
-- references it (regions are deleted only via migration, after all ws are
-- migrated away). ON UPDATE CASCADE — if a region code is ever renamed
-- (rare; requires a migration), the FKs follow.
-- ───────────────────────────────────────────────

alter table workspaces
  add constraint workspaces_region_fk
  foreign key (region) references regions(code)
  on delete restrict on update cascade;

-- ───────────────────────────────────────────────
-- forbid_region_change() — immutability trigger.
--
-- Raises if NEW.region differs from OLD.region. This is defense-in-depth:
--   - RLS already blocks UPDATEs to workspaces.region (no policy grants it).
--   - This trigger catches direct DB edits (superuser, migration drift, a
--     future migration that forgets to drop the trigger).
--
-- The trigger fires BEFORE UPDATE, for each row. It allows the UPDATE to
-- proceed only if region is unchanged (the common case — other columns are
-- being updated). If region changed, it RAISEs with a clear message.
--
-- Note: the `is distinct from` operator handles NULLs correctly (NULL is
-- distinct from NULL → false → no raise). But workspaces.region is NOT NULL,
-- so this is belt-and-suspenders.
-- ───────────────────────────────────────────────

create or replace function forbid_region_change()
returns trigger
language plpgsql
as $$
begin
  if new.region is distinct from old.region then
    raise exception 'workspaces.region is immutable (ws=%, old=%, new=%)',
      old.id, old.region, new.region
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function forbid_region_change() is
  'Immutability trigger — workspaces.region cannot change after creation. Defense-in-depth (RLS already blocks it).';

drop trigger if exists trg_forbid_region_change on workspaces;
create trigger trg_forbid_region_change
  before update on workspaces
  for each row
  execute function forbid_region_change();

-- ───────────────────────────────────────────────
-- Update create_workspace() default — 'eu' → 'us-east'.
-- The spec's primary region is 'us-east'. Callers can still pass a different
-- region explicitly (e.g., an EU customer creating a workspace in 'eu-west').
-- ───────────────────────────────────────────────

create or replace function create_workspace(
  p_name text,
  p_slug text,
  p_region text default 'us-east',
  p_created_by uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws_id uuid;
begin
  -- Insert the workspace (bypasses RLS via SECURITY DEFINER).
  insert into workspaces (name, slug, region, plan, kind, billing_owner_id)
  values (p_name, p_slug, p_region, 'free', 'team', p_created_by)
  returning id into v_ws_id;

  -- Insert the owner membership (the creator is the owner).
  insert into memberships (ws_id, user_id, role, status, joined_at)
  values (v_ws_id, p_created_by, 'owner', 'active', now());

  -- Insert the builtin 'approver' custom role.
  insert into custom_roles (ws_id, name, perms, builtin, created_by)
  values (v_ws_id, 'approver',
          '["chat.read","work.read","approvals.decide"]'::jsonb,
          true, p_created_by);

  -- Insert a default retention policy.
  insert into retention_policies (ws_id, chat_days, work_days, audit_days, legal_hold)
  values (v_ws_id, 365, 3650, 3650, false);

  -- Audit the creation (via the security-definer append function).
  perform enterprise_audit_log_append(
    v_ws_id, 'user', p_created_by::text, 'ws.created',
    jsonb_build_object('name', p_name, 'slug', p_slug, 'region', p_region),
    null::inet, null::text
  );

  return v_ws_id;
end;
$$;

-- Re-grant (CREATE OR REPLACE preserves grants, but be explicit).
grant execute on function create_workspace(text, text, text, uuid) to supa_app;
grant execute on function create_workspace(text, text, text, uuid) to supa_system;

-- ───────────────────────────────────────────────
-- Audit the migration itself (system actor, ws_id null — global event).
-- ───────────────────────────────────────────────

do $$
begin
  perform enterprise_audit_log_append(
    null::uuid, 'system', 'migration-0046', 'residency.regions_seeded',
    jsonb_build_object('regions', array['us-east','eu-west','ap-southeast']),
    null::inet, null::text
  );
end;
$$;
