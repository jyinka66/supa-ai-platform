-- Bootstrap the identity/workspace tables used by the existing ordered migrations.
-- This must run before 0001_identity_workspaces.sql: that migration installs
-- policies and the auth.users trigger, but assumes these tables already exist.
-- All statements are additive/idempotent so a partially configured project can
-- be repaired without replacing Supabase Auth users or application data.

create extension if not exists pgcrypto;

do $$
begin
  create type public.workspace_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.user_role_type as enum ('individual', 'business', 'enterprise');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.invite_status as enum ('pending', 'accepted', 'revoked');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_path text,
  country text,
  timezone text not null default 'UTC',
  language text not null default 'en',
  role_type public.user_role_type not null default 'individual',
  bio text,
  company text,
  is_verified boolean not null default false,
  onboarding_step integer not null default 0,
  onboarding_complete boolean not null default false,
  email_verified_at timestamptz,
  last_seen_at timestamptz not null default now(),
  deletion_requested_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  work_view_prefs jsonb not null default '{"view":"grid","sort":"newest","density":"comfortable"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_language_idx on public.profiles(language);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_path text,
  country text,
  timezone text not null default 'UTC',
  default_language text not null default 'en',
  is_personal boolean not null default false,
  plan text not null default 'free',
  seat_limit integer not null default 3,
  billing_owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'team' check (kind in ('personal', 'team')),
  region text not null default 'us' check (region in ('eu', 'us', 'apac')),
  sso_enforced boolean not null default false,
  domain_verified text,
  settings jsonb not null default '{}'::jsonb,
  billing jsonb,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  purge_at timestamptz,
  purged_at timestamptz,
  billing_state text not null default 'active',
  lockout_at timestamptz,
  downgrade_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspaces_slug_idx on public.workspaces(slug);
create index if not exists workspaces_billing_owner_idx on public.workspaces(billing_owner_id);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists workspace_members_unique
  on public.workspace_members(workspace_id, user_id);
create index if not exists workspace_members_user_idx
  on public.workspace_members(user_id);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role public.workspace_role not null default 'member',
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  status public.invite_status not null default 'pending',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  resend_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists invites_workspace_idx on public.invites(workspace_id);
create index if not exists invites_email_idx on public.invites(email);

create table if not exists public.user_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_at timestamptz not null,
  cancelled_at timestamptz
);

-- Explicit access grants; row access is subsequently constrained by the RLS
-- policies installed in 0001_identity_workspaces.sql.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.profiles to authenticated, service_role;
grant select, insert, update, delete on public.workspaces to authenticated, service_role;
grant select, insert, update, delete on public.workspace_members to authenticated, service_role;
grant select, insert, update, delete on public.invites to authenticated, service_role;
grant select, insert, update, delete on public.user_sessions to authenticated, service_role;
grant select, insert, update, delete on public.deletion_requests to authenticated, service_role;
