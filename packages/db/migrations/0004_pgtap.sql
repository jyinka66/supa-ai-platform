-- ============ PGTAP EXTENSION ============
-- Installs pgTAP for SQL-level testing.
-- The rls_test.sql file uses pgTAP's plan(), is(), lives_ok(), throws_ok() helpers.
--
-- This migration is safe to run in production — pgTAP is test-only and
-- doesn't add any tables or functions to the public schema.
-- In CI, the integration job installs pgTAP before running test:sql.

create extension if not exists pgtap with schema "extensions";

-- Make pgTAP functions available without schema qualification.
-- (Supabase's local dev stack already has `extensions` in the search_path.)
comment on extension pgtap is 'Unit testing framework for PostgreSQL — used by tests/rls_test.sql';
