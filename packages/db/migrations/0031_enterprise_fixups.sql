-- ───────────────────────────────────────────────
-- 0031_enterprise_fixups.sql
-- Fixes from the residency + retention + billing services:
--
--   1. Add `messages.author_erased` (boolean) — tombstone for GDPR erasure.
--      When a user is erased, their messages get author_erased=true (content
--      stays, attribution shows "Erased User").
--
--   2. Add `work_items.creator_erased` (boolean) — same tombstone for work items.
--
--   3. Add `workspaces.purge_at` (timestamptz) — the hard-purge eligibility
--      timestamp (deleted_at + 30d). Set by deleteWorkspace; checked by
--      purgeExpiredWorkspaces.
--
--   4. Add `workspaces.purged_at` (timestamptz) — set when the workspace is
--      hard-purged (the row survives with purged_at set, OR the row is deleted
--      and purged_at is recorded in a separate tombstone table). For now, the
--      row is deleted (cascade) — purged_at is for a future "soft purge" mode.
--
--   5. Change `enterprise_audit_log.ws_id` FK from ON DELETE CASCADE to
--      ON DELETE SET NULL. The audit trail must SURVIVE workspace hard purge
--      (legal/compliance — the audit log is immutable, even if the workspace
--      is deleted). With CASCADE, deleting the workspace would delete the audit
--      entries — wrong. With SET NULL, the entries survive with ws_id=null.
--
--   6. Add `workspaces.billing_state` (text) + `lockout_at` + `downgrade_at` —
--      extracted from the billing JSONB for query performance (the nightly
--      cron scans by billing_state; JSONB extraction is less index-friendly
--      than a dedicated column). The billing JSONB column is kept for
--      provider-specific metadata; billing_state/lockout_at/downgrade_at are
--      the indexed columns for the cron queries.
-- ───────────────────────────────────────────────

-- 1. messages.author_erased — GDPR erasure tombstone.
alter table messages
  add column if not exists author_erased boolean not null default false;
comment on column messages.author_erased is
  'GDPR erasure tombstone. True = the author was erased; attribution shows "Erased User". Content is preserved.';

-- 2. work_items.creator_erased — same tombstone for work items.
alter table work_items
  add column if not exists creator_erased boolean not null default false;
comment on column work_items.creator_erased is
  'GDPR erasure tombstone. True = the creator was erased; attribution shows "Erased User". Content is preserved.';

-- 3. workspaces.purge_at — hard-purge eligibility (deleted_at + 30d).
alter table workspaces
  add column if not exists purge_at timestamptz;
comment on column workspaces.purge_at is
  'Hard-purge eligibility timestamp. Set by deleteWorkspace (deleted_at + 30d). Checked by purgeExpiredWorkspaces.';

-- 4. workspaces.purged_at — set when hard-purged (for the tombstone mode).
alter table workspaces
  add column if not exists purged_at timestamptz;
comment on column workspaces.purged_at is
  'Set when the workspace is hard-purged. (Future: soft-purge mode where the row survives with purged_at set, instead of being deleted.)';

-- 5. Change enterprise_audit_log.ws_id FK from CASCADE to SET NULL.
-- The audit trail must survive workspace hard purge (legal/compliance).
alter table enterprise_audit_log
  drop constraint if exists enterprise_audit_log_ws_id_fkey;
alter table enterprise_audit_log
  add constraint enterprise_audit_log_ws_id_fkey
  foreign key (ws_id) references workspaces(id) on delete set null;
comment on constraint enterprise_audit_log_ws_id_fkey on enterprise_audit_log is
  'SET NULL (not CASCADE) — the audit trail survives workspace hard purge. Legal/compliance: the audit log is immutable, even if the workspace is deleted.';

-- 6. workspaces.billing_state + lockout_at + downgrade_at — indexed columns
--    for the billing cron queries (extracted from billing JSONB for performance).
alter table workspaces
  add column if not exists billing_state text not null default 'active'
    check (billing_state in ('active', 'grace', 'locked', 'canceled'));
alter table workspaces
  add column if not exists lockout_at timestamptz;
alter table workspaces
  add column if not exists downgrade_at timestamptz;

-- Index for the nightly lockout cron: find grace workspaces past lockout_at.
create index if not exists idx_workspaces_billing_state_lockout
  on workspaces (billing_state, lockout_at)
  where billing_state = 'grace';

-- Index for the nightly downgrade cron: find locked workspaces past downgrade_at.
create index if not exists idx_workspaces_billing_state_downgrade
  on workspaces (billing_state, downgrade_at)
  where billing_state = 'locked';

-- Index for the purge cron: find deleted workspaces past purge_at.
create index if not exists idx_workspaces_purge_at
  on workspaces (purge_at)
  where purge_at is not null;

-- Index for the retention purge: find non-deleted workspaces.
create index if not exists idx_workspaces_not_deleted
  on workspaces (id)
  where deleted_at is null;
