-- ───────────────────────────────────────────────
-- 0039_files.sql
-- Files — canonical tenant-table pattern.
-- Tree structure (parent_id self-reference), content-hash dedup,
-- soft delete, version history.
-- ───────────────────────────────────────────────

create table files (
  id           uuid primary key default gen_random_uuid(),
  ws_id        uuid not null references workspaces(id) on delete cascade,
  parent_id    uuid references files(id) on delete cascade,   -- tree; null = root
  name         text not null,
  is_dir       boolean not null default false,
  size_bytes   bigint,
  mime         text,
  content_hash bytea,                                          -- sha-256, dedup key
  storage_key  text,                                           -- object-store path
  version      int not null default 1,
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (ws_id, parent_id, name) deferrable initially deferred
);

alter table files enable row level security;
create policy files_select on files for select to supa_app
  using (is_ws_member(ws_id));
create policy files_write  on files for all to supa_app
  using (is_ws_member(ws_id)) with check (is_ws_member(ws_id));

comment on table files is '@tenant_table — file tree (dirs + files), content-hash dedup, soft delete';

create index on files (ws_id, parent_id) where deleted_at is null;
create index on files (ws_id, content_hash) where content_hash is not null and deleted_at is null;
create index on files (ws_id, deleted_at) where deleted_at is not null;

-- Force RLS (migration 0033 pattern — applies to table owners).
alter table files force row level security;

-- ───────────────────────────────────────────────
-- file_versions — version history (dedup via content_hash)
-- ───────────────────────────────────────────────

create table file_versions (
  file_id  uuid not null references files(id) on delete cascade,
  version  int not null,
  storage_key text not null,
  size_bytes bigint not null,
  content_hash bytea not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (file_id, version)
);

alter table file_versions enable row level security;
create policy fv_read on file_versions for select to supa_app
  using (exists (select 1 from files f where f.id = file_id and is_ws_member(f.ws_id)));

comment on table file_versions is '@tenant_table — file version history (content-hash dedup)';

create index on file_versions (file_id, version desc);

-- Force RLS.
alter table file_versions force row level security;
