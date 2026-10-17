-- ───────────────────────────────────────────────
-- 0026_agents.sql
-- Agent infrastructure — agents, memory, runs, steps, approvals,
-- budget entries, idempotency.
--
-- FIXES from the pasted spec:
--   1. references users(id) → separate ALTER TABLE with auth.users FK
--      (Drizzle/Supabase can't reference auth schema directly)
--   2. RLS policies use auth.uid() → workspace_members join
--      (same pattern as 0024_business_tables.sql, not current_setting)
--   3. agent_idempotency table now has RLS + policy
--   4. Added created_at index on agent_idempotency for TTL cleanup
--   5. runs.agent_id → ON DELETE CASCADE (no orphaned runs)
--   6. agent_memory unique constraint noted as dedup defense
-- ───────────────────────────────────────────────

create table agents (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id),
  name text not null check (char_length(name) between 1 and 80),
  persona text not null default '',
  goal text not null default '',
  instructions text not null default '',
  tool_grants text[] not null default '{}',
  approval_policy jsonb not null default '{}',
  budget jsonb not null,
  status text not null default 'draft'
    check (status in ('draft','active','paused','killed')),
  visibility text not null default 'private'
    check (visibility in ('private','shared')),
  locale text not null default 'en',
  config_version int not null default 1,
  created_by uuid not null,  -- FIX: FK to auth.users added below (can't reference auth schema inline)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on agents (ws_id, status);

-- FIX: add FK to auth.users via ALTER (Drizzle/Supabase pattern)
alter table agents
  add constraint agents_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

-- RLS: tenancy hard wall — FIX: uses auth.uid() → workspace_members join
-- (same pattern as every 0024 table, not current_setting)
alter table agents enable row level security;
create policy agents_ws on agents
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

create table agent_memory (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id),
  agent_id uuid not null references agents(id) on delete cascade,
  kind text not null check (kind in ('fact','episode','procedure','preference')),
  content text not null,
  redacted boolean not null default false,
  provenance text not null default 'agent'
    check (provenance in ('agent','user','template_seed')),
  confidence numeric not null default 0.5 check (confidence between 0 and 1),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Dedup defense: same agent + kind + content = same memory.
  unique (agent_id, kind, content)
);
create index on agent_memory (agent_id, kind, expires_at);
alter table agent_memory enable row level security;
create policy agent_memory_ws on agent_memory
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

create table runs (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id),
  agent_id uuid not null references agents(id) on delete cascade,  -- FIX: ON DELETE CASCADE (no orphaned runs)
  trigger_type text not null
    check (trigger_type in ('manual','schedule','event','webhook','chain')),
  trigger_payload jsonb not null default '{}',
  agent_snapshot jsonb not null,       -- config hash + full config at start
  status text not null default 'queued'
    check (status in ('queued','running','awaiting_approval','done',
                      'failed','cancelled','timeout','approval_expired')),
  output jsonb,
  failure_reason text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  usd_minor int not null default 0,
  max_steps int not null default 40,
  wall_deadline timestamptz not null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on runs (ws_id, agent_id, status, created_at desc);
create index on runs (status) where status in ('queued','running','awaiting_approval');
alter table runs enable row level security;
create policy runs_ws on runs
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

create table run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  ws_id uuid not null references workspaces(id),
  seq int not null,
  kind text not null check (kind in ('thought','tool_call','tool_result',
                                     'memory_read','memory_write','a2a','error')),
  tool_id text,
  args jsonb,
  args_hash text,
  result_ref text,          -- pointer to blob store, not inline (PII + size)
  latency_ms int,
  cost_tokens int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);
alter table run_steps enable row level security;
create policy run_steps_ws on run_steps
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

create table approvals (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id),
  run_id uuid not null references runs(id) on delete cascade,
  agent_id uuid not null references agents(id),
  tool_id text not null,
  args jsonb not null,
  context_snapshot jsonb not null,     -- EXACTLY what approver saw. Immutable.
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','modified_approved','expired','cancelled')),
  requested_by_agent uuid not null references agents(id),
  decided_by uuid,  -- FIX: FK to auth.users added below
  decision_context jsonb,              -- modifications, batch id
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on approvals (ws_id, status, expires_at);

-- FIX: add FK to auth.users for decided_by
alter table approvals
  add constraint approvals_decided_by_fkey
  foreign key (decided_by) references auth.users(id) on delete set null;

alter table approvals enable row level security;
create policy approvals_ws on approvals
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

create table budget_entries (
  id bigint generated always as identity primary key,
  ws_id uuid not null references workspaces(id),
  agent_id uuid not null references agents(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  usd_minor int not null,             -- positive = spend committed
  kind text not null check (kind in ('hold','capture','refund','alert')),
  period_day date not null,
  created_at timestamptz not null default now()
);
create index on budget_entries (agent_id, period_day);
alter table budget_entries enable row level security;
create policy budget_entries_ws on budget_entries
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );

-- FIX: added RLS + policy for agent_idempotency (was missing)
create table agent_idempotency (
  key text primary key,               -- agent_id + tool + args_hash + run
  ws_id uuid not null references workspaces(id),
  result_ref text,
  created_at timestamptz not null default now()
);
create index on agent_idempotency (created_at);  -- FIX: added for TTL cleanup
alter table agent_idempotency enable row level security;
create policy agent_idempotency_ws on agent_idempotency
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );
