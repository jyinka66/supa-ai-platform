-- 0078_supa_app_rls_role_hardening.sql
-- Keep the application role subject to row-level security. PostgreSQL role
-- attributes are changed with ALTER ROLE; BYPASSRLS is not a GRANT privilege.
alter role supa_app nobypassrls;
alter role supa_app set row_security = on;
