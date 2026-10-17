-- 0070_supa_os_marketplace_security.sql
-- Forward-safe role and RLS setup for already-provisioned databases.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supa_system') then
    create role supa_system login password null;
  end if;
end
$$;

-- Align persisted workflow states with the application state machine.
alter table supa_os_marketplace_items drop constraint if exists supa_os_marketplace_items_status_check;
update supa_os_marketplace_items set status = 'in_review' where status = 'under_review';
alter table supa_os_marketplace_items add constraint supa_os_marketplace_items_status_check
  check (status in ('draft','submitted','in_review','approved','rejected','published','deprecated','removed','yanked'));
alter table supa_os_marketplace_items drop constraint if exists supa_os_marketplace_items_price_check;
alter table supa_os_marketplace_items add constraint supa_os_marketplace_items_price_check
  check (price >= 0 and (monetization <> 'free' or price = 0));

alter table supa_os_marketplace_items enable row level security;
alter table supa_os_marketplace_reviews enable row level security;

drop policy if exists supa_marketplace_public_read on supa_os_marketplace_items;
create policy supa_marketplace_public_read on supa_os_marketplace_items
  for select to anon, authenticated using (status = 'published');
drop policy if exists supa_marketplace_system_select on supa_os_marketplace_items;
create policy supa_marketplace_system_select on supa_os_marketplace_items for select to supa_system using (true);
drop policy if exists supa_marketplace_system_insert on supa_os_marketplace_items;
create policy supa_marketplace_system_insert on supa_os_marketplace_items for insert to supa_system with check (true);
drop policy if exists supa_marketplace_system_update on supa_os_marketplace_items;
create policy supa_marketplace_system_update on supa_os_marketplace_items for update to supa_system using (true) with check (true);
drop policy if exists supa_marketplace_system_delete on supa_os_marketplace_items;
create policy supa_marketplace_system_delete on supa_os_marketplace_items for delete to supa_system using (true);

drop policy if exists supa_marketplace_reviews_public_read on supa_os_marketplace_reviews;
drop policy if exists supa_marketplace_reviews_system_select on supa_os_marketplace_reviews;
create policy supa_marketplace_reviews_system_select on supa_os_marketplace_reviews for select to supa_system using (true);
drop policy if exists supa_marketplace_reviews_system_insert on supa_os_marketplace_reviews;
create policy supa_marketplace_reviews_system_insert on supa_os_marketplace_reviews for insert to supa_system with check (true);
drop policy if exists supa_marketplace_reviews_system_update on supa_os_marketplace_reviews;
create policy supa_marketplace_reviews_system_update on supa_os_marketplace_reviews for update to supa_system using (true) with check (true);
drop policy if exists supa_marketplace_reviews_system_delete on supa_os_marketplace_reviews;
create policy supa_marketplace_reviews_system_delete on supa_os_marketplace_reviews for delete to supa_system using (true);

grant usage on schema public to supa_system;
grant select on supa_os_marketplace_items to anon, authenticated;
grant select, insert, update, delete on supa_os_marketplace_items, supa_os_marketplace_reviews to supa_system;
