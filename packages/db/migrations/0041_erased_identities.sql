-- ───────────────────────────────────────────────
-- 0041_erased_identities.sql
-- erased_identities — view-level pseudonymization for GDPR erasure.
--
-- When a user is erased (DSAR), their identity is anonymized but the audit
-- chain is NOT mutated (rewriting actor_id would break the hash chain).
-- Instead, the old user id is inserted into erased_identities. The admin
-- UI + exports join through this table: if an actor_id exists in
-- erased_identities, the display shows "erased user" instead of the
-- original name/email.
--
-- This is the "view-level mapping" approach: the raw data stays (legal/
-- compliance — the audit chain is immutable), but readable surfaces
-- (UI, exports) never leak the erased user's identity.
-- ───────────────────────────────────────────────

create table erased_identities (
  old_id uuid primary key,  -- the erased user's id.
  erased_at timestamptz not null default now()
);

-- No RLS (not a tenant table — system-level mapping).
-- Only the system role (supa_system) writes to this table (during erasure).
-- Admins read it via the audit log join (is_ws_member on the audit row).

comment on table erased_identities is
  'View-level pseudonymization for GDPR erasure. The audit chain stays intact (actor_id not mutated); readable surfaces join through this table to show "erased user".';
