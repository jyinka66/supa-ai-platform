-- ───────────────────────────────────────────────
-- 0028_agent_teams.sql
-- Agent-to-agent delegation graph (the "team" view).
--
-- An edge (from_agent → to_agent, granted_tools[]) means: agent A delegates
-- the ability to invoke tools [X, Y, Z] to agent B. When B is invoked as an
-- a2a target by A, the executor's canInvoke checks:
--   1. tool is in B's own grants (toolGrants column on agents).
--   2. A's live perms allow the tool's requiredPermission.
--   3. The chain's perms all allow it (transitive).
--
-- The team graph renders this: for each edge, the EFFECTIVE permission set is
-- grants ∩ from_agent_live_perms ∩ to_agent_live_perms (live-computed by
-- teamGraph, never cached — the "live" property is the contract).
--
-- Cycles are allowed (A→B→C→A). The executor's a2a depth limit (max 3)
-- prevents infinite loops at runtime; the graph itself can have cycles.
-- ───────────────────────────────────────────────

create table agent_teams (
  id uuid primary key default gen_random_uuid(),
  ws_id uuid not null references workspaces(id) on delete cascade,
  from_agent uuid not null references agents(id) on delete cascade,
  to_agent uuid not null references agents(id) on delete cascade,
  -- Tools the from_agent delegates to the to_agent. Must be a subset of the
  -- from_agent's own toolGrants (enforced at the application layer — the
  -- createDelegation function checks this before inserting).
  granted_tools text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- One edge per (from, to) pair — multiple edges between the same pair would
  -- be ambiguous (which granted_tools list is in effect?). UNIQUE enforces one.
  unique (from_agent, to_agent)
);

create index on agent_teams (ws_id);
create index on agent_teams (from_agent);
create index on agent_teams (to_agent);

alter table agent_teams enable row level security;
create policy agent_teams_ws on agent_teams
  for all using (
    ws_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()
    )
  );
