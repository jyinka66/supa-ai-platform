-- ───────────────────────────────────────────────
-- 0030_scim_refs.sql
-- SCIM reference table — maps IdP external IDs to local user IDs.
-- The bridge between SCIM's `externalId`/`id` and our `memberships.user_id`.
--
-- Used by:
--   • src/scim/router.ts — createUser matches by externalId first (via this
--     table), then by email. The ref row is inserted on first create, so
--     subsequent creates are idempotent (matched → 200, not 201).
--   • deactivateUser — looks up by scim_user_id (the IdP's id), finds the
--     local user_id, suspends.
--
-- Two unique indexes enforce the 1:1 mapping:
--   (ws_id, scim_external_id) — the IdP's externalId → one local user.
--   (ws_id, scim_user_id) — the IdP's id → one local user.
-- ───────────────────────────────────────────────

create table scim_refs (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users added below
  scim_external_id text not null,  -- IdP's externalId (e.g. Okta user id)
  scim_user_id text not null,      -- IdP's id (SCIM resource id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ws_id, scim_external_id),
  unique (ws_id, scim_user_id)
);

create index on scim_refs (ws_id, user_id);
create index on scim_refs (ws_id, scim_external_id);
create index on scim_refs (ws_id, scim_user_id);

-- FIX: add FK to auth.users via ALTER (can't reference auth schema inline).
alter table scim_refs
  add constraint scim_refs_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table scim_refs enable row level security;
create policy scim_refs_ws on scim_refs
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );
