-- ───────────────────────────────────────────────
-- 0067_supa_os_sandbox_preview.sql
-- Supa OS sandbox + preview instance tables.
--
-- Tables:
--   - sandbox_sessions: per-build-session sandbox state (filesystem + terminal).
--   - sandbox_files: individual file nodes in the sandbox virtual filesystem.
--   - sandbox_terminal_lines: terminal output lines (stdout + stderr).
--   - preview_instances: live preview state (port, status, started_at).
--
-- Referenced by:
--   - lib/supa-os/sandbox-execution-engine.ts (in-memory store)
--   - lib/builder/live-preview.ts (in-memory store)
--   - API routes: /api/supa-os/build/[id]/sandbox*, /preview*
--
-- Phase 2 persistence: replaces the in-memory Map<string, ...> stores so
-- the sandbox state survives server restarts + scales horizontally.
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- sandbox_sessions — one row per (build session, sandbox instance).
-- ───────────────────────────────────────────────

create table sandbox_sessions (
  id                    uuid primary key default gen_random_uuid(),
  build_session_id      uuid not null references build_sessions(id) on delete cascade,
  state                 text not null check (state in ('booting', 'mounted', 'installing', 'migrating', 'running', 'sleeping', 'stopped', 'failed')) default 'booting',
  port                  int,
  started_at            timestamptz not null default now(),
  stopped_at            timestamptz,
  last_activity_at      timestamptz not null default now(),
  memory_used_mb        int default 0,
  cpu_used_percent      numeric(5,2) default 0,
  unique (build_session_id)
);

create index idx_sandbox_sessions_state on sandbox_sessions (state, last_activity_at desc);

comment on table sandbox_sessions is
  'global_system — One row per active sandbox instance. State machine: booting → mounted → installing → migrating → running → sleeping → stopped. Failed is terminal.';

-- ───────────────────────────────────────────────
-- sandbox_files — individual file nodes in the sandbox VFS.
-- ───────────────────────────────────────────────

create table sandbox_files (
  id                    uuid primary key default gen_random_uuid(),
  sandbox_session_id    uuid not null references sandbox_sessions(id) on delete cascade,
  path                  text not null,                     -- '/app/src/index.ts'
  content               text not null,
  byte_size             int not null,
  content_type          text,                              -- 'text/typescript', 'application/json', etc.
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            text,                              -- 'architect_agent' | 'user' | 'self_heal_loop'
  unique (sandbox_session_id, path)
);

create index idx_sandbox_files_session on sandbox_files (sandbox_session_id, path);

comment on table sandbox_files is
  'global_system — individual file nodes in the sandbox virtual filesystem. One row per (sandbox_session, path).';

-- ───────────────────────────────────────────────
-- sandbox_terminal_lines — terminal output lines (stdout + stderr).
-- Stored as a ring buffer per sandbox session (capped at 1000 lines per
-- session by the application layer — older lines roll off).
-- ───────────────────────────────────────────────

create table sandbox_terminal_lines (
  id                    bigserial primary key,
  sandbox_session_id    uuid not null references sandbox_sessions(id) on delete cascade,
  seq                   int not null,                      -- per-session sequence number (1..1000 ring buffer).
  stream                text not null check (stream in ('stdout', 'stderr', 'system')),
  content               text not null,
  source                text,                              -- command that produced the line.
  timestamp             timestamptz not null default now(),
  unique (sandbox_session_id, seq)
);

create index idx_sandbox_terminal_session on sandbox_terminal_lines (sandbox_session_id, seq desc);

comment on table sandbox_terminal_lines is
  'global_system — terminal output lines per sandbox session. Ring buffer (max 1000 lines per session).';

-- ───────────────────────────────────────────────
-- preview_instances — live preview state.
-- ───────────────────────────────────────────────

create table preview_instances (
  id                    uuid primary key default gen_random_uuid(),
  build_session_id      uuid not null references build_sessions(id) on delete cascade,
  port                  int not null,
  url                   text not null,                     -- 'https://preview-<id>.supa-hosting.local:<port>'.
  status                text not null check (status in ('starting', 'running', 'sleeping', 'stopped', 'failed')) default 'starting',
  started_at            timestamptz not null default now(),
  stopped_at            timestamptz,
  last_health_check_at  timestamptz,
  health_status         text check (health_status in ('healthy', 'unhealthy', 'unknown')),
  unique (build_session_id)
);

create index idx_preview_instances_status on preview_instances (status, started_at desc);

comment on table preview_instances is
  'global_system — live preview instances. One row per (build_session). Lifecycle: starting → running → sleeping → stopped.';
