-- ───────────────────────────────────────────────
-- 0064_governance_decision_log.sql
-- Hash-chained immutable decision log.
--
-- Every governance decision is appended here. Each entry's hash links to
-- the previous entry's hash — any tampering breaks the chain. This is the
-- cryptographically-verifiable record of "what did the platform decide
-- autonomously, and why."
--
-- The append + verify functions are security-definer PL/pgSQL functions
-- that acquire an advisory lock to prevent hash races under concurrent
-- inserts.
--
-- Referenced by:
--   - lib/governance/governance-decision-log.ts (appendDecisionLog,
--     verifyDecisionLogChain, queryDecisionLog)
--   - API routes: POST/GET /api/governance/decisions/log,
--     POST /api/governance/decisions/log/verify
-- ───────────────────────────────────────────────

create table governance_decision_log (
  -- Sequence number — monotonically increasing. Used for hash chaining.
  seq                   bigserial primary key,

  -- Identity (the row id is a UUID separate from seq, so we can re-hash
  -- without changing the public id).
  id                    uuid not null default gen_random_uuid() unique,

  -- When (server-side, append-only — never updated).
  created_at            timestamptz not null default now(),

  -- Actor — user_id, 'system', or 'agent:<id>'.
  actor                 text not null,

  -- Action — namespaced: 'tool.call', 'agent.run', 'marketplace.publish', etc.
  action                text not null,

  -- Context — the input that triggered the decision.
  context               jsonb not null default '{}'::jsonb,

  -- Policy applied — which policy rule governed this decision.
  policy_applied        jsonb not null default '{}'::jsonb,

  -- Decision — the routing outcome.
  decision              text not null check (decision in (
                          'auto_approved', 'policy_approved', 'human_approved',
                          'blocked', 'deferred'
                        )),

  -- Reasoning — structured rationale (risk factors, reputation tier, etc.).
  reasoning             jsonb not null default '{}'::jsonb,

  -- Downstream effects — side effects observed after the decision (filled
  -- in async when known). This is what makes the log useful for incident
  -- reconstruction: "decision X caused effect Y".
  downstream_effects    jsonb,

  -- Hash chain — each row's hash = sha256(prev_hash || canonical(row)).
  -- Any tampering with a historical row breaks the chain at that seq.
  prev_hash             text,                                 -- null for seq=1 (genesis row).
  hash                  text not null
);

create index idx_gov_decision_log_actor on governance_decision_log (actor, seq desc);
create index idx_gov_decision_log_action on governance_decision_log (action, seq desc);
create index idx_gov_decision_log_created on governance_decision_log (created_at desc);

-- ───────────────────────────────────────────────
-- governance_decision_log_append(p_actor, p_action, p_context, ...)
--
-- Appends a new entry to the chain. Acquires an advisory lock to serialize
-- inserts (otherwise concurrent inserts would race on prev_hash).
--
-- Returns: { id, seq, hash }.
-- ───────────────────────────────────────────────

create or replace function governance_decision_log_append(
  p_actor           text,
  p_action          text,
  p_context         jsonb,
  p_policy_applied  jsonb,
  p_decision        text,
  p_reasoning       jsonb
) returns table (id uuid, seq bigint, hash text) as $$
declare
  v_id               uuid := gen_random_uuid();
  v_seq              bigint;
  v_prev_hash        text;
  v_hash             text;
  v_canonical        text;
  v_created_at       timestamptz := now();
begin
  -- Acquire transaction-level advisory lock to serialize appends.
  perform pg_advisory_xact_lock(89342);

  -- Get the previous seq + hash (or null for the genesis row).
  select seq, hash into v_seq, v_prev_hash
    from governance_decision_log
    order by seq desc
    limit 1
    for update;

  v_seq := coalesce(v_seq + 1, 1);

  -- Canonicalize the row in a stable, sorted-key form (so the same input
  -- always produces the same hash).
  v_canonical := concat_ws('|',
    v_seq::text,
    v_id::text,
    v_created_at::timestamptz::text,
    p_actor,
    p_action,
    p_context::text,
    p_policy_applied::text,
    p_decision,
    p_reasoning::text,
    coalesce(v_prev_hash, '')
  );

  -- Compute the hash: sha256(canonical || prev_hash).
  v_hash := encode(digest(v_canonical, 'sha256'), 'hex');

  insert into governance_decision_log (
    id, created_at, actor, action, context, policy_applied,
    decision, reasoning, prev_hash, hash
  ) values (
    v_id, v_created_at, p_actor, p_action, p_context, p_policy_applied,
    p_decision, p_reasoning, v_prev_hash, v_hash
  );

  return query select v_id, v_seq, v_hash;
end;
$$ language plpgsql security definer;

-- ───────────────────────────────────────────────
-- governance_decision_log_verify_chain()
--
-- Recomputes every hash from scratch + verifies each row's hash matches
-- the recomputed value. Returns ok=true if the chain is intact, ok=false
-- + broken_at_seq if a row was tampered with.
-- ───────────────────────────────────────────────

create or replace function governance_decision_log_verify_chain()
returns table (ok boolean, broken_at_seq bigint, total_entries bigint) as $$
declare
  v_prev_hash text := null;
  v_row record;
  v_recomputed text;
  v_canonical text;
  v_total bigint := 0;
begin
  for v_row in select seq, id, created_at, actor, action, context, policy_applied,
                      decision, reasoning, prev_hash, hash
                 from governance_decision_log
                 order by seq asc
  loop
    v_total := v_total + 1;

    -- Verify prev_hash links correctly.
    if v_row.prev_hash is distinct from v_prev_hash then
      return query select false, v_row.seq, v_total;
      return;
    end if;

    -- Recompute this row's hash.
    v_canonical := concat_ws('|',
      v_row.seq::text,
      v_row.id::text,
      v_row.created_at::timestamptz::text,
      v_row.actor,
      v_row.action,
      v_row.context::text,
      v_row.policy_applied::text,
      v_row.decision,
      v_row.reasoning::text,
      coalesce(v_row.prev_hash, '')
    );
    v_recomputed := encode(digest(v_canonical, 'sha256'), 'hex');

    if v_recomputed <> v_row.hash then
      return query select false, v_row.seq, v_total;
      return;
    end if;

    v_prev_hash := v_row.hash;
  end loop;

  return query select true, null::bigint, v_total;
end;
$$ language plpgsql security definer;

comment on table governance_decision_log is
  'global_system — Hash-chained immutable decision log. Every governance decision is appended here. Each row''s hash = sha256(prev_hash || canonical(row)). Tampering with any historical row breaks the chain.';
