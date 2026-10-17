-- ───────────────────────────────────────────────
-- 0050_admin_confirmations.sql
-- Admin confirmations — 2nd-admin approval for dangerous control-plane actions.
--
-- Used by `requireConfirmation` (lib/admin/confirmation.ts) for kill_switch
-- flag changes: a kill_switch flip requires a 2nd owner to approve. The
-- confirmation stores the pending action (the flag patch) + the requesting
-- admin + the required phrase. The 2nd admin approves via the API; the
-- original action then proceeds.
--
-- Lifecycle:
--   1. Owner A calls PATCH /feature-flags/:key with a kill_switch patch.
--   2. requireConfirmation detects secondAdmin=true → creates a pending
--      confirmation (status='pending') → throws ConfirmationRequired.
--   3. The route returns 202 with the confirmationId.
--   4. Owner B calls POST /feature-flags/:key/confirm with confirmationId.
--   5. The confirmation service verifies B is a different owner → sets
--      status='approved' + approver_id=B → applies the stored patch.
--   6. The confirmation is consumed (can't be reused).
--
-- TTL: pending confirmations expire after 10 minutes (the 2nd admin must
-- approve within the window). Expired confirmations are reaped by the
-- sweep-admin-sessions cron (or a dedicated reaper).
-- ───────────────────────────────────────────────

create table admin_confirmations (
  id            uuid primary key default gen_random_uuid(),
  action_type   text not null check (action_type in ('flag_set')),
  target_key    text not null,                    -- the flag key.
  requested_by  uuid not null,                    -- the requesting admin's user_id.
  approver_id    uuid,                             -- the approving (2nd) admin's user_id.
  patch          jsonb not null,                   -- the stored patch to apply on approval.
  phrase         text not null,                    -- the typed phrase the requester entered.
  status         text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  created_at     timestamptz not null default now(),
  approved_at    timestamptz,
  expires_at     timestamptz not null               -- 10 min TTL.
);

comment on table admin_confirmations is
  'global_system — 2nd-admin approval for dangerous control-plane actions (kill_switch flips).';

create index idx_admin_confirmations_status_expires on admin_confirmations (status, expires_at) where status = 'pending';
create index idx_admin_confirmations_target on admin_confirmations (action_type, target_key) where status = 'pending';

-- Grants: supa_app can read (for the confirmation UI), supa_system can CRUD.
grant select on admin_confirmations to supa_app;
grant select, insert, update, delete on admin_confirmations to supa_system;

-- No RLS — the app layer enforces owner-only access (the routes use requireAdminSession(req, "owner")).

-- Audit the migration.
do $$
begin
  perform admin_audit_log_append(
    'migration-0050',
    'admin.confirmations.created',
    jsonb_build_object('table', 'admin_confirmations'),
    'migration 0050 — create the 2nd-admin confirmation table for kill_switch flips',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
