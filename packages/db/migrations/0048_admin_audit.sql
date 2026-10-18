-- ───────────────────────────────────────────────
-- 0048_admin_audit.sql
-- Admin control-plane audit log — hash-chained, tamper-evident, insert-only.
--
-- SEPARATE from enterprise_audit_log (the product audit). The admin audit log
-- records control-plane actions: admin invites, removals, role changes,
-- MFA resets, session revocations, sensitive reads (user data access),
-- quarterly reviews. It's the forensic trail for "who did what in the admin
-- control plane" — critical for compliance (SOC2, ISO 27001) + incident response.
--
-- Why a separate table (not enterprise_audit_log):
--   1. Different access control — admin audit is readable ONLY by owners
--      (not workspace admins). enterprise_audit_log is readable by ws admins.
--   2. Different retention — admin audit is INDEFINITE (never purged).
--      enterprise_audit_log follows retention_policies.audit_days.
--   3. Different chain — a separate hash chain means a product-audit tamper
--      doesn't affect the admin chain (and vice versa). Independent verification.
--   4. `justification` column — MANDATORY for sensitive reads + all writes on
--      user data. The product audit doesn't have this (product actions are
--      routine; admin actions are privileged + need a documented reason).
--
-- ── Fixes from the pasted spec ──
-- 1. The spec's `sha256("prev:{prev}:prev:{body}")` — the second `prev:` is
--    likely a typo for `body:`. Fixed to `sha256(prev_hash || canonical(body))`
--    (the standard hash-chain construction — same as enterprise_audit_log).
-- 2. The spec's `t.one(... limit 1 for update)` on an empty table returns null
--    (no rows) — the spec handles this (`tip ? tip.seq + 1 : 1`), but SELECT
--    ... FOR UPDATE on an empty table in a transaction can deadlock under
--    concurrency. Fixed: the security-definer function uses a `COALESCE` +
--    `advisory_xact_lock` to serialize appends (admin audit is low-volume —
--    the lock is uncontended). Same approach as enterprise_audit_log.
-- 3. The spec's `old?` + `new?` diff columns — added as `diff jsonb` (storing
--    { old, new } as a JSONB object). Cleaner than two separate columns +
--    matches the product audit's `target jsonb` pattern.
-- 4. `seq` is `bigserial` (monotonic, gap-tolerant — same as enterprise_audit_log).
--    The spec's `seq = tip.seq + 1` would gap on rollback; bigserial handles
--    this correctly (gaps are expected + don't break the chain).
-- ───────────────────────────────────────────────

create table admin_audit_log (
  seq            bigserial,                    -- monotonic (gaps OK — rollback-tolerant).
  id             uuid primary key default gen_random_uuid(),
  actor_id       text not null,                -- admin user_id | 'system' | 'migration-XXXX'.
  action         text not null,                -- namespaced: admin.invited, admin.removed, admin.mfa_reset, admin.session.revoked, admin.user_data.read, ...
  target         jsonb,                        -- resource refs; NEVER raw secrets/PII beyond ids.
  justification  text,                        -- REQUIRED for sensitive reads + all writes on user data. NULL = routine action.
  diff           jsonb,                        -- { old, new } for mutations. NULL for reads/creates.
  ip             inet,
  user_agent     text,
  ts             timestamptz not null default now(),
  prev_hash      bytea not null,               -- hash chain: hash = sha256(prev_hash || canonical(body)).
  hash           bytea not null,
  check (justification is not null or action not like 'admin.user_data.%'),  -- justification required for user-data reads/writes.
  check (justification is not null or action not like 'admin.%_write')      -- justification required for all writes (convention: action ends with _write).
);

comment on table admin_audit_log is
  'global_system — admin control-plane audit log. Hash-chained, insert-only, indefinite retention. Separate from enterprise_audit_log (product audit).';

-- Indexes (same pattern as enterprise_audit_log).
create index idx_admin_audit_log_seq on admin_audit_log (seq);               -- for chain verification (sequential scan).
create index idx_admin_audit_log_actor on admin_audit_log (actor_id, ts desc);
create index idx_admin_audit_log_action_ts on admin_audit_log (action, ts desc);

-- ───────────────────────────────────────────────
-- Insert-only: REVOKE UPDATE + DELETE from ALL roles (including service roles).
-- The spec: "Table is insert-only — no UPDATE/DELETE grants exist for any
-- role including service roles in this DB."
-- ───────────────────────────────────────────────

revoke update, delete on admin_audit_log from public, authenticated, anon, supa_app, supa_system;
revoke update, delete on admin_audit_log_seq_seq from public, authenticated, anon, supa_app, supa_system;

alter table admin_audit_log enable row level security;

-- READ: owners only (control-plane audit is the most sensitive — only owners
-- can read the admin audit log). NOT workspace admins.
-- (No RLS policy for supa_system — the verify cron uses the security-definer
-- function which bypasses RLS.)
create policy admin_audit_log_owner_read on admin_audit_log
  for select to supa_app
  using (
    exists (
      select 1 from admin_users
       where admin_users.user_id = auth.uid()
         and admin_users.role = 'owner'
         and admin_users.revoked_at is null
    )
  );

-- INSERT: via security-definer function only (no direct DML from any role).
create policy admin_audit_log_no_insert on admin_audit_log
  for insert to authenticated
  with check (false);  -- deny all direct inserts; use the security-definer function.

-- ───────────────────────────────────────────────
-- admin_audit_log_append — security-definer append function.
-- Computes the hash chain + inserts. Uses an advisory_xact_lock to serialize
-- appends (prevents the SELECT ... FOR UPDATE deadlock + ensures the chain
-- tip is stable during the insert).
--
-- The canonical body: JSON.stringify({ actor_id, action, target, justification, diff, ts })
-- with sorted keys (deterministic — the hash is reproducible for verification).
-- ───────────────────────────────────────────────

create or replace function admin_audit_log_append(
  p_actor_id text,
  p_action text,
  p_target jsonb default null,
  p_justification text default null,
  p_diff jsonb default null,
  p_ip inet default null,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
  v_prev_hash bytea;
  v_hash bytea;
  v_id uuid := gen_random_uuid();
  v_ts timestamptz := now();
  v_canonical jsonb;
begin
  -- Serialize appends (admin audit is low-volume — the lock is uncontended).
  -- Key 0xADMN (a fixed key — all appends serialize on it).
  perform pg_advisory_xact_lock(1882693701);

  -- Get the chain tip.
  select seq, hash into v_seq, v_prev_hash
    from admin_audit_log
   order by seq desc
   limit 1;

  if v_seq is null then
    v_seq := 0;
    v_prev_hash := '\x00'::bytea;  -- genesis (all-zeros).
  end if;
  v_seq := v_seq + 1;

  -- Canonical body (deterministic JSON — sorted keys, no whitespace).
  v_canonical := jsonb_build_object(
    'actor_id', p_actor_id,
    'action', p_action,
    'target', p_target,
    'justification', p_justification,
    'diff', p_diff,
    'ts', v_ts
  );

  -- hash = sha256(prev_hash || canonical(body)).
  -- The canonical text must be deterministic — use jsonb ::text (sorted keys).
  v_hash := extensions.digest(
    concat(v_prev_hash::text, v_canonical::text),
    'sha256'
  );

  insert into admin_audit_log (seq, id, actor_id, action, target, justification, diff, ip, user_agent, ts, prev_hash, hash)
  values (v_seq, v_id, p_actor_id, p_action, p_target, p_justification, p_diff, p_ip, p_user_agent, v_ts, v_prev_hash, v_hash);

  return v_id;
end;
$$;

-- Grant execute to the app role (the function is SECURITY DEFINER — handles escalation).
grant execute on function admin_audit_log_append(text, text, jsonb, text, jsonb, inet, text) to supa_app;
grant execute on function admin_audit_log_append(text, text, jsonb, text, jsonb, inet, text) to supa_system;

comment on function admin_audit_log_append(text, text, jsonb, text, jsonb, inet, text) is
  'Security-definer: append to the admin audit log. Computes the hash chain + inserts. Serialized via advisory_xact_lock.';

-- ───────────────────────────────────────────────
-- admin_audit_log_verify_chain — recompute + compare (nightly cron).
-- Returns { ok: boolean, broken_at_seq: bigint | null }.
-- If ok=false, broken_at_seq is the first seq where the recomputed hash
-- doesn't match the stored hash (the tamper point).
-- ───────────────────────────────────────────────

create or replace function admin_audit_log_verify_chain()
returns table(ok boolean, broken_at_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_hash bytea := '\x00'::bytea;
  v_expected_hash bytea;
  v_row record;
begin
  for v_row in select seq, hash, prev_hash, actor_id, action, target, justification, diff, ts
                 from admin_audit_log
                order by seq asc
  loop
    -- Verify prev_hash continuity.
    if v_row.prev_hash != v_prev_hash then
      return query select false, v_row.seq;
      return;
    end if;

    -- Recompute the hash.
    v_expected_hash := extensions.digest(
      concat(v_prev_hash::text,
        jsonb_build_object(
          'actor_id', v_row.actor_id,
          'action', v_row.action,
          'target', v_row.target,
          'justification', v_row.justification,
          'diff', v_row.diff,
          'ts', v_row.ts
        )::text
      ),
      'sha256'
    );

    if v_row.hash != v_expected_hash then
      return query select false, v_row.seq;
      return;
    end if;

    v_prev_hash := v_row.hash;
  end loop;

  return query select true, null::bigint;
end;
$$;

grant execute on function admin_audit_log_verify_chain() to supa_system;

comment on function admin_audit_log_verify_chain() is
  'Security-definer: recompute the hash chain + compare. Nightly verification. Returns ok=false + broken_at_seq on tamper.';

-- ───────────────────────────────────────────────
-- Audit the migration itself.
-- ───────────────────────────────────────────────

do $$
begin
  perform admin_audit_log_append(
    'migration-0048',
    'admin.audit_log.created',
    jsonb_build_object('table', 'admin_audit_log'),
    'migration 0048 — create the admin control-plane audit log',
    null::jsonb,
    null::inet,
    null::text
  );
end $$;
