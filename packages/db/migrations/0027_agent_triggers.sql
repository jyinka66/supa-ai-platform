-- ───────────────────────────────────────────────
-- 0027_agent_triggers.sql
-- Agent triggers — schedules, events, webhooks as first-class entities.
-- Referenced by:
--   • src/triggers/dispatcher.ts — the dispatch gate (Gate 2: triggers enabled?)
--   • src/killswitch.ts         — the triggers-disable step (was skipped in
--                                 0026; now wired against this table).
--
-- Also adds:
--   • agents.max_concurrent_runs  — the concurrency cap (Gate 3 in dispatcher)
--   • runs.idempotency_key        — 10-min dedup window for trigger fires
--   • runs.chain_depth            — a2a chain depth (carried from enqueueRun)
--
-- FIXES from the pasted spec:
--   1. agent_triggers table now EXISTS (was referenced but not created)
--   2. max_concurrent_runs added to agents (was referenced but not present)
--   3. idempotency_key added to runs (was referenced but not present)
--   4. chain_depth added to runs (was referenced but not present)
--   5. RLS + policy on agent_triggers (same ws_id join pattern as 0026)
-- ───────────────────────────────────────────────

-- Agent triggers — schedules, events, webhooks.
-- kind: 'manual' | 'schedule' | 'event' | 'webhook'
-- config: jsonb — { cron: '0 9 * * *', event: 'expense.created',
--                   webhookUrl: '...', webhookSecretHash: '...' }
-- The dispatcher reads `enabled` + `kind` + `config->>'event'` to match.
create table agent_triggers (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  kind text not null check (kind in ('manual','schedule','event','webhook')),
  config jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on agent_triggers (ws_id, agent_id, enabled);
create index on agent_triggers (agent_id, kind, enabled);
-- Event trigger matching: WHERE kind='event' AND config->>'event' = $1
create index on agent_triggers ((config->>'event'))
  where kind = 'event' and enabled = true;

alter table agent_triggers enable row level security;
create policy agent_triggers_ws on agent_triggers
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- ───────────────────────────────────────────────
-- agents.max_concurrent_runs — the concurrency cap
-- ───────────────────────────────────────────────
alter table agents
  add column max_concurrent_runs int not null default 5
    check (max_concurrent_runs between 1 and 50);

-- ───────────────────────────────────────────────
-- runs.idempotency_key — 10-min dedup window for trigger fires
-- ───────────────────────────────────────────────
alter table runs
  add column idempotency_key text;

-- Unique index on (agent_id, idempotency_key) where idempotency_key is not null.
-- This makes the dedup defense DB-level: a second insert with the same key
-- within the window is a unique-violation (caught + swallowed in enqueueRun).
-- NULL keys are excluded from the index (multiple manual runs have no key).
create unique index idx_runs_idempotency
  on runs (agent_id, idempotency_key)
  where idempotency_key is not null;

-- ───────────────────────────────────────────────
-- runs.chain_depth — a2a chain depth (carried from enqueueRun)
-- ───────────────────────────────────────────────
alter table runs
  add column chain_depth int not null default 0
    check (chain_depth between 0 and 3);
