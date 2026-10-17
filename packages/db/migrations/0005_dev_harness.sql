-- ============ DEV HARNESS TABLE ============
-- Stores mock-failure state for the local dev harness.
-- This table is only used when NODE_ENV = 'development'; the
-- /api/test/mock-fail route is gated by testGate() and 404s in production.
--
-- The table is created unconditionally (even in prod) so that migration
-- order doesn't matter, but it's never written to outside dev.

create table if not exists dev_mock_failures (
  provider    text primary key check (provider in ('gemini', 'groq', 'openrouter')),
  status      integer check (status is null or (status >= 400 and status <= 599)),
  updated_at  timestamptz not null default now()
);

comment on table dev_mock_failures is
  'Dev harness mock-failure state. Written by /api/test/mock-fail in dev only.';

-- Enable RLS — only service_role can read/write (the app uses service-role
-- in dev; the table is never accessed via PostgREST in prod because the
-- route is gated).
alter table dev_mock_failures enable row level security;

-- Drop existing policies if re-running the migration.
drop policy if exists dev_mock_select on dev_mock_failures;
drop policy if exists dev_mock_write on dev_mock_failures;

-- Only the service role can access this table.
create policy dev_mock_select on dev_mock_failures
  for select using (auth.role() = 'service_role');

create policy dev_mock_write on dev_mock_failures
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
