-- 0071_supa_os_marketplace_checks.sql
-- Persist the automated review result rather than returning ephemeral checks.
create table if not exists supa_os_marketplace_item_checks (
  item_id uuid primary key references supa_os_marketplace_items(id) on delete cascade,
  checks jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);

alter table supa_os_marketplace_item_checks enable row level security;
drop policy if exists supa_marketplace_checks_system_select on supa_os_marketplace_item_checks;
create policy supa_marketplace_checks_system_select on supa_os_marketplace_item_checks for select to supa_system using (true);
drop policy if exists supa_marketplace_checks_system_insert on supa_os_marketplace_item_checks;
create policy supa_marketplace_checks_system_insert on supa_os_marketplace_item_checks for insert to supa_system with check (true);
drop policy if exists supa_marketplace_checks_system_update on supa_os_marketplace_item_checks;
create policy supa_marketplace_checks_system_update on supa_os_marketplace_item_checks for update to supa_system using (true) with check (true);
drop policy if exists supa_marketplace_checks_system_delete on supa_os_marketplace_item_checks;
create policy supa_marketplace_checks_system_delete on supa_os_marketplace_item_checks for delete to supa_system using (true);
grant select, insert, update, delete on supa_os_marketplace_item_checks to supa_system;
