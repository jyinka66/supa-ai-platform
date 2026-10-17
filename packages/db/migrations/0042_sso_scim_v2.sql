-- ───────────────────────────────────────────────
-- 0042_sso_scim_v2.sql
-- SSO connections + SCIM identities v2 — the spec's canonical design.
--
-- DIVERGENCE from migration 0029 (which created `sso_configs` + `scim_tokens` +
-- `scim_groups` + `scim_log` + `scim_refs`):
--   - 0042 uses `sso_connections` (SAML-specific: IdP entity id, SSO URL,
--     cert PEM, SP entity id, IdP-initiated flag, enforce_sso + enforced_domain).
--   - 0029 used `sso_configs` (generic OIDC/SAML with JSONB config columns).
--   - 0042 adds `scim_identities` (IdP user ↔ our user mapping, per connection).
--   - 0029 used `scim_refs` (similar but ws-scoped, not connection-scoped).
--
-- FIX from the pasted spec:
--   The spec uses `has_role(ws_id, 'admin')` which doesn't exist in our schema.
--   Replaced with `is_ws_member(ws_id, 'admin')` (the canonical predicate
--   from migration 0033).
--
-- Both v1 (0029) and v2 (0042) tables coexist. A future migration would
-- migrate data from v1 → v2 + drop v1.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- sso_connections — SAML connection config linking IdP to one workspace.
-- ───────────────────────────────────────────────

create table sso_connections (
  id            uuid primary key default gen_random_uuid(),
  ws_id         uuid not null references workspaces(id) on delete cascade,
  idp_entity_id text not null,                                     -- IdP's entity id.
  idp_sso_url   text not null check (idp_sso_url ~ '^https://'), -- HTTPS only (SSRF discipline).
  idp_cert_pem  text not null,                                     -- X.509 cert, verified at save.
  sp_entity_id  text not null,                                     -- our ACS entity id.
  idp_initiated_ok boolean not null default false,                 -- default deny IdP-initiated SSO.
  enforce_sso   boolean not null default false,                    -- block password logins for domain.
  enforced_domain text not null,                                   -- email domain this binds to.
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  unique (ws_id, enforced_domain)                                  -- one connection per ws + domain.
);

alter table sso_connections enable row level security;
-- Admin+ only (SSO config contains the IdP cert + enforce_sso flag — sensitive).
create policy sso_admin on sso_connections for all to supa_app
  using (is_ws_member(ws_id, 'admin'))
  with check (is_ws_member(ws_id, 'admin'));

comment on table sso_connections is
  '@tenant_table — SAML SSO connections (IdP config, HTTPS-only, admin-only RLS)';

create index on sso_connections (ws_id);
create index on sso_connections (enforced_domain) where enforce_sso = true;

-- Force RLS.
alter table sso_connections force row level security;

-- ───────────────────────────────────────────────
-- scim_identities — IdP user ↔ our user mapping, per connection.
-- ───────────────────────────────────────────────

create table scim_identities (
  scim_user_id  text not null,                -- IdP's stable userName/id.
  sso_conn_id   uuid not null references sso_connections(id) on delete cascade,
  user_id       uuid,                         -- null until first JIT link (user not yet created).
  ws_id         uuid not null references workspaces(id) on delete cascade,
  primary key (scim_user_id, sso_conn_id)
);

alter table scim_identities enable row level security;
-- Admin+ only (mapping contains user_id — sensitive).
create policy scim_ident on scim_identities for all to supa_app
  using (is_ws_member(ws_id, 'admin'))
  with check (is_ws_member(ws_id, 'admin'));

comment on table scim_identities is
  '@tenant_table — SCIM external identity mapping (IdP user ↔ our user, per connection)';

create index on scim_identities (ws_id);
create index on scim_identities (user_id) where user_id is not null;

-- Force RLS.
alter table scim_identities force row level security;
