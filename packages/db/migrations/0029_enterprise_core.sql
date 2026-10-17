-- ───────────────────────────────────────────────
-- 0029_enterprise_core.sql
-- Enterprise tenancy core — SSO, SCIM, API keys, hash-chained audit log,
-- retention policies, webhook endpoints.
--
-- Tenancy rule: EVERY table in this phase carries ws_id with RLS.
-- Region column is on the ROOT table (workspaces): the database itself is
-- per-region (eu, us, apac clusters); workspaces never span regions.
--
-- FIXES from the pasted spec:
--   1. `users(id)` FK → separate ALTER TABLE with auth.users FK (Drizzle/
--      Supabase can't reference auth schema directly — same pattern as 0026).
--   2. `citext` extension → CREATE EXTENSION IF NOT EXISTS.
--   3. `invite_token hash` → `invite_token text` (hash is not a Postgres type;
--      the invite token is a SHA-256 hash stored as text — same pattern as the
--      invites table from 0001).
--   4. `audit_log` → renamed to `enterprise_audit_log` (collision with the
--      existing audit_log from migration 0011 — the enterprise audit log is a
--      DIFFERENT, more stringent design with hash chain columns; keeping it
--      separate avoids a destructive drop of the existing audit_log).
--   5. Hash chain trigger → implemented (compute_hash_chain function +
--      before-insert trigger that sets prev_hash + hash).
--   6. RLS → uses auth.uid() → memberships join (codebase pattern from 0024/
--      0026, NOT current_setting('app.ws_id') — the spec's pattern is for a
--      different deployment model; the codebase's pattern is the Supabase
--      standard).
--   7. Indexes → added on all foreign-key + lookup columns.
--   8. workspaces table → ALTER existing (add region, sso_enforced,
--      domain_verified columns) rather than CREATE (workspaces exists from 0001).
-- ───────────────────────────────────────────────

-- citext extension (for citext columns on workspaces.slug, memberships.invited_email).
create extension if not exists citext;

-- ───────────────────────────────────────────────
-- workspaces — ALTER existing table (0001 created it; 0029 adds enterprise columns)
-- ───────────────────────────────────────────────
-- The spec's `create table workspaces (...)` would collide with 0001's table.
-- ALTER is the right path: add the enterprise columns to the existing table.

alter table workspaces
  add column if not exists kind text not null default 'team'
    check (kind in ('personal','team')),
  add column if not exists region text not null default 'us'
    check (region in ('eu','us','apac')),  -- residency, immutable after creation
  add column if not exists sso_enforced boolean not null default false,
  add column if not exists domain_verified text,  -- verified domain for auto-join
  add column if not exists settings jsonb not null default '{}',
  add column if not exists billing jsonb,
  add column if not exists deleted_at timestamptz,  -- soft delete; purge job honors retention+legal hold
  add column if not exists deleted_by uuid;

-- FIX: add FK to auth.users for deleted_by via ALTER (can't reference auth schema inline).
alter table workspaces
  drop constraint if exists workspaces_deleted_by_fkey;
alter table workspaces
  add constraint workspaces_deleted_by_fkey
  foreign key (deleted_by) references auth.users(id) on delete set null;

-- ───────────────────────────────────────────────
-- memberships — the enterprise membership table (separate from workspace_members
-- from 0001; enterprise memberships carry SSO/SCIM/MFA state that the basic
-- workspace_members table doesn't).
-- ───────────────────────────────────────────────
create table memberships (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid,  -- null until invite is accepted (invited by email). FK added below.
  role text not null default 'member'
    check (role in ('owner','admin','member','viewer','custom')),
  custom_role_id uuid,  -- FK to custom_roles added below (forward reference)
  status text not null default 'active'
    check (status in ('active','invited','suspended')),
  invited_by uuid,  -- FIX: FK to auth.users added below
  invited_at timestamptz,
  joined_at timestamptz,
  invited_email citext,
  invite_token text,  -- FIX: was `hash` (not a Postgres type); now text (SHA-256 hash of the invite token)
  invite_expires_at timestamptz,
  mfa_enrolled boolean not null default false,
  suspended_by uuid,  -- FIX: FK to auth.users added below
  suspended_at timestamptz,
  suspend_reason text,
  seat_id uuid,  -- billing seat (no FK — external billing system owns the seat id)
  unique (ws_id, user_id)  -- at most one membership per (ws, user). Null user_id (invited) is excluded.
);

-- FIX: add FKs to auth.users via ALTER (Drizzle/Supabase pattern).
alter table memberships
  add constraint memberships_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table memberships
  add constraint memberships_invited_by_fkey
  foreign key (invited_by) references auth.users(id) on delete set null;
alter table memberships
  add constraint memberships_suspended_by_fkey
  foreign key (suspended_by) references auth.users(id) on delete set null;

create index on memberships (user_id, status);
create index on memberships (ws_id, status);
create index on memberships (invited_email) where invited_email is not null;
-- invite_token lookup (for invite acceptance flow).
create index on memberships (invite_token) where invite_token is not null;

alter table memberships enable row level security;
create policy memberships_ws on memberships
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- custom_roles — named bundles of granular permissions (Enterprise).
-- ───────────────────────────────────────────────
create table custom_roles (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  perms jsonb not null,  -- e.g. ["chat.read","work.write","agents.use","billing.view"]
  builtin boolean not null default false,
  created_by uuid,  -- FIX: FK to auth.users added below
  created_at timestamptz not null default now(),
  unique (ws_id, name)
);

alter table custom_roles
  add constraint custom_roles_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

-- memberships.custom_role_id FK (forward reference — now that custom_roles exists).
alter table memberships
  add constraint memberships_custom_role_id_fkey
  foreign key (custom_role_id) references custom_roles(id) on delete set null;

create index on custom_roles (ws_id);

alter table custom_roles enable row level security;
create policy custom_roles_ws on custom_roles
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- sso_configs — one SSO config per workspace (OIDC or SAML).
-- ───────────────────────────────────────────────
create table sso_configs (
  ws_id uuid primary key references workspaces(id) on delete cascade,
  protocol text not null check (protocol in ('oidc','saml')),
  provider text not null,  -- google_workspace|entra_id|okta|onelogin|generic
  oidc jsonb,  -- issuer, client_id, secret(encrypted), scopes
  saml jsonb,  -- idp_metadata, entity_id, cert fingerprint
  enforced boolean not null default false,
  owner_bypass boolean not null default true,  -- owner break-glass, audited
  domain_claim text,
  updated_by uuid,  -- FIX: FK to auth.users added below
  updated_at timestamptz not null default now()
);

alter table sso_configs
  add constraint sso_configs_updated_by_fkey
  foreign key (updated_by) references auth.users(id) on delete set null;

alter table sso_configs enable row level security;
create policy sso_configs_ws on sso_configs
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- sso_nonces — SAML replay defense.
-- ───────────────────────────────────────────────
create table sso_nonces (
  nonce text primary key,
  ws_id uuid references workspaces(id) on delete cascade,
  consumed_at timestamptz not null default now()
);

create index on sso_nonces (consumed_at);  -- for TTL cleanup of old nonces.

alter table sso_nonces enable row level security;
create policy sso_nonces_ws on sso_nonces
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- scim_tokens — bearer tokens for SCIM provisioning.
-- ───────────────────────────────────────────────
create table scim_tokens (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  token_hash text not null unique,  -- argon2id(token); full token stored NOWHERE
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index on scim_tokens (ws_id, revoked_at);
create index on scim_tokens (token_hash) where revoked_at is null;  -- lookup for active tokens.

alter table scim_tokens enable row level security;
create policy scim_tokens_ws on scim_tokens
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- scim_groups — group → role mapping.
-- ───────────────────────────────────────────────
create table scim_groups (
  ws_id uuid references workspaces(id) on delete cascade,
  scim_group_id text not null,
  display_name text not null,
  mapped_role text,  -- group → role mapping (FK to custom_roles if enterprise, or a builtin role)
  primary key (ws_id, scim_group_id)
);

alter table scim_groups enable row level security;
create policy scim_groups_ws on scim_groups
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- scim_log — full request log, for debugging + acceptance proof.
-- ───────────────────────────────────────────────
create table scim_log (
  id bigserial primary key,
  ws_id uuid references workspaces(id) on delete cascade,
  op text,  -- GET / POST / PUT / PATCH / DELETE
  resource text,  -- Users / Groups
  request_id text,
  payload jsonb,
  result text,  -- success / error / rate_limited
  ts timestamptz not null default now()
);

create index on scim_log (ws_id, ts desc);
create index on scim_log (request_id);  -- for correlation.

alter table scim_log enable row level security;
create policy scim_log_ws on scim_log
  for select using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
      and role in ('owner', 'admin')  -- SCIM log is admin-only.
    )
  );

-- ───────────────────────────────────────────────
-- api_keys — workspace API keys (argon2id hashed, never reversible).
-- ───────────────────────────────────────────────
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,  -- creator; subject of the key's perms. FK to auth.users added below.
  name text not null,
  prefix text not null,  -- display: sk_live_<prefix>…; hash never reversible
  hash bytea not null,  -- argon2id(key) — full key stored NOWHERE
  scopes text[] not null check (array_length(scopes, 1) > 0),
  expires_at timestamptz,  -- default 90d, max 365d (enforced at app layer)
  last_used_at timestamptz,
  rotated_from uuid references api_keys(id) on delete set null,  -- rotation chain
  revoked_at timestamptz,
  revoked_by uuid,  -- FK to auth.users added below
  created_at timestamptz not null default now()
);

alter table api_keys
  add constraint api_keys_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table api_keys
  add constraint api_keys_revoked_by_fkey
  foreign key (revoked_by) references auth.users(id) on delete set null;

create index on api_keys (ws_id, revoked_at);
create index on api_keys (user_id);
-- Hash lookup (for auth: hash the presented key, look up by hash). Only active
-- (non-revoked, non-expired) keys are in the lookup path.
create index on api_keys (hash) where revoked_at is null;

alter table api_keys enable row level security;
create policy api_keys_ws on api_keys
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- enterprise_audit_log — hash-chained, tamper-evident.
-- (Renamed from `audit_log` to avoid collision with the existing audit_log
--  from migration 0011 — the enterprise audit log is a DIFFERENT design with
--  hash chain columns + actor_type/target jsonb + seq for monotonic ordering.)
-- ───────────────────────────────────────────────
create table enterprise_audit_log (
  seq bigserial,  -- monotonic per region cluster (partition-ready by ts).
  ws_id uuid references workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  actor_type text not null check (actor_type in ('user','api_key','scim','sso','system')),
  actor_id text not null,  -- user uuid | api_key id | scim token id | sso provider | 'system'
  action text not null,  -- namespaced: ws.member.invite, api.key.create, auth.sso…
  target jsonb,  -- resource refs; NEVER raw secrets/PII beyond ids
  ip inet,
  user_agent text,
  ts timestamptz not null default now(),
  prev_hash bytea not null,  -- hash chain: h = sha256(prev_hash || canonical(record))
  hash bytea not null,
  primary key (id, ts)  -- partition-ready by ts.
);

create index on enterprise_audit_log (ws_id, ts desc, action);
create index on enterprise_audit_log (actor_type, actor_id, ts desc);
create index on enterprise_audit_log (seq);  -- for chain verification (sequential scan).

-- Append-only: revoke UPDATE + DELETE from all roles.
revoke update, delete on enterprise_audit_log from public, authenticated, anon;
revoke update, delete on enterprise_audit_log_seq_seq from public, authenticated, anon;

alter table enterprise_audit_log enable row level security;

-- READ: workspace admins only (owner + admin).
create policy enterprise_audit_log_read on enterprise_audit_log
  for select using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
      and role in ('owner', 'admin')
    )
  );

-- INSERT: via security-definer function only (no direct DML from app roles).
-- The app calls enterprise_audit_log_append(...) which runs as the table owner
-- and inserts with a computed hash chain. This prevents app roles from
-- inserting forged entries (the hash chain would break, but the function
-- ensures only the function's logic can insert — no raw INSERT from app roles).
create policy enterprise_audit_log_no_insert on enterprise_audit_log
  for insert to authenticated
  with check (false);  -- deny all direct inserts; use the security-definer function.

-- ───────────────────────────────────────────────
-- Hash chain function + trigger.
-- Computes prev_hash = (last hash in the chain for this ws_id) and
-- hash = sha256(prev_hash || canonical(record)).
-- ───────────────────────────────────────────────

create or replace function compute_audit_hash_chain()
returns trigger as $$
declare
  v_prev_hash bytea;
  v_canonical text;
  v_hash bytea;
begin
  -- Get the previous hash for this workspace (the last entry by seq).
  select hash into v_prev_hash
  from enterprise_audit_log
  where ws_id = new.ws_id
  order by seq desc
  limit 1;

  -- If no previous entry, prev_hash = '\x00' (genesis).
  if v_prev_hash is null then
    v_prev_hash := '\x00'::bytea;
  end if;

  -- Canonical JSON of the record (deterministic key order).
  v_canonical := jsonb_build_object(
    'ws_id', new.ws_id,
    'id', new.id,
    'actor_type', new.actor_type,
    'actor_id', new.actor_id,
    'action', new.action,
    'target', new.target,
    'ip', new.ip::text,
    'user_agent', new.user_agent,
    'ts', new.ts::text
  )::text;

  -- hash = sha256(prev_hash || canonical(record)).
  v_hash := digest(v_prev_hash || convert_to(v_canonical, 'UTF8'), 'sha256');

  new.prev_hash := v_prev_hash;
  new.hash := v_hash;

  return new;
end;
$$ language plpgsql;

-- The trigger fires before insert. The security-definer function
-- (enterprise_audit_log_append) calls INSERT, which fires this trigger.
create trigger audit_hash_chain_trigger
  before insert on enterprise_audit_log
  for each row execute function compute_audit_hash_chain();

-- Security-definer function for appending to the audit log. App roles call
-- this; it runs as the table owner (bypasses the no-insert RLS policy).
create or replace function enterprise_audit_log_append(
  p_ws_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_action text,
  p_target jsonb default null,
  p_ip inet default null,
  p_user_agent text default null
) returns uuid as $$
declare
  v_id uuid;
begin
  insert into enterprise_audit_log (ws_id, actor_type, actor_id, action, target, ip, user_agent, ts)
  values (p_ws_id, p_actor_type, p_actor_id, p_action, p_target, p_ip, p_user_agent, now())
  returning id into v_id;
  return v_id;
end;
$$ language plpgsql security definer;

-- pgcrypto for digest() (sha256).
create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────
-- retention_policies — per-workspace data retention + legal hold.
-- ───────────────────────────────────────────────
create table retention_policies (
  ws_id uuid primary key references workspaces(id) on delete cascade,
  chat_days int default 365,
  work_days int default 3650,  -- work items: long default.
  audit_days int default 3650,  -- audit: long default.
  legal_hold boolean not null default false,  -- blocks purge entirely.
  hold_scope jsonb  -- e.g. {"users":["..."],"range":["2025-01-01","2025-06-30"]}
);

alter table retention_policies enable row level security;
create policy retention_policies_ws on retention_policies
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
      and role in ('owner', 'admin')  -- retention policy is admin-only.
    )
  );

-- ───────────────────────────────────────────────
-- webhook_endpoints — per-workspace webhook targets.
-- ───────────────────────────────────────────────
create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  secret bytea not null,  -- for HMAC signing; per-endpoint.
  events text[] not null,  -- event types this endpoint subscribes to.
  disabled_until timestamptz,  -- circuit breaker: disable after repeated failures.
  created_at timestamptz not null default now()
);

create index on webhook_endpoints (ws_id);

alter table webhook_endpoints enable row level security;
create policy webhook_endpoints_ws on webhook_endpoints
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- webhook_deliveries — at-most-once per endpoint per event.
-- ───────────────────────────────────────────────
create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_id text not null,  -- the fact id that triggered the delivery.
  attempts int not null default 0,
  next_retry timestamptz,  -- exponential backoff.
  status text not null default 'pending'
    check (status in ('pending','delivered','failed','disabled')),
  response_code int,
  delivered_at timestamptz,
  unique (endpoint_id, event_id)  -- at-most-once per endpoint per event.
);

create index on webhook_deliveries (status, next_retry) where status = 'pending';
create index on webhook_deliveries (endpoint_id, delivered_at desc);

alter table webhook_deliveries enable row level security;
create policy webhook_deliveries_ws on webhook_deliveries
  for all using (
    endpoint_id in (
      select id from webhook_endpoints
      where ws_id in (
        select workspace_id from workspace_members
        where user_id = auth.uid()
      )
    )
  );
