-- ============ EXPORT JOBS ============
-- Async export jobs for work items (PDF, DOCX, Markdown, JSON, ZIP).
--
-- Jobs are created via POST /api/work/export, processed by a background
-- worker (or Vercel Cron), and the result URL is returned when done.
--
-- The `selection` JSONB defines what to export:
--   { "itemIds": ["uuid1", "uuid2"] }
--   { "filter": { "type": "invoice", "favorite": true } }
--   { "folderId": "uuid" }
--   { "all": true }
--
-- Results expire after 7 days (configurable per job via `expires_at`).

create table if not exists public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users via raw SQL
  format text not null check (format in ('pdf', 'docx', 'md', 'json', 'zip')),
  selection jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'expired')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  result_url text,
  result_size bigint check (result_size is null or result_size >= 0),
  result_mime text,
  error text,
  expires_at timestamptz,             -- result TTL (null = default 7 days)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_export_jobs_user
  on public.export_jobs(user_id, created_at desc);
create index if not exists idx_export_jobs_status
  on public.export_jobs(status, created_at)
  where status in ('queued', 'running');
create index if not exists idx_export_jobs_expires
  on public.export_jobs(expires_at)
  where status = 'done' and expires_at is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'export_jobs_user_id_fkey'
      and table_name = 'export_jobs'
  ) then
    alter table public.export_jobs
      add constraint export_jobs_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ RLS ============
alter table public.export_jobs enable row level security;

drop policy if exists export_jobs_select on public.export_jobs;
drop policy if exists export_jobs_insert on public.export_jobs;
drop policy if exists export_jobs_update on public.export_jobs;
drop policy if exists export_jobs_delete on public.export_jobs;

-- User sees only their own export jobs.
create policy export_jobs_select on public.export_jobs
  for select using (user_id = auth.uid());

create policy export_jobs_insert on public.export_jobs
  for insert with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

-- UPDATE only via service_role (the worker updates progress/status).
-- Users can't update jobs directly.
create policy export_jobs_update on public.export_jobs
  for update using (auth.role() = 'service_role');

create policy export_jobs_delete on public.export_jobs
  for delete using (user_id = auth.uid());

-- ============ UPDATED_AT TRIGGER ============
create or replace function public.touch_export_jobs_updated_at()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_export_jobs_touch on public.export_jobs;
create trigger trg_export_jobs_touch
before update on public.export_jobs
for each row execute function public.touch_export_jobs_updated_at();

-- ============ AUTO-EXPIRE TRIGGER ============
-- When a job is marked 'done' without an explicit expires_at, set it to
-- 7 days from now.
create or replace function public.set_export_job_expiry()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  if new.status = 'done' and new.expires_at is null and (old.status is null or old.status <> 'done') then
    new.expires_at := now() + interval '7 days';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_export_job_expiry on public.export_jobs;
create trigger trg_export_job_expiry
before update of status on public.export_jobs
for each row execute function public.set_export_job_expiry();
