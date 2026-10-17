-- ============ PGTAP RLS TESTS ============
-- Tests Row Level Security policies on chat core tables.
-- Run via: psql with pgtap extension installed, or `pnpm --filter @supa/db test:integration:sql`.
--
-- This file is the SQL-level test suite; the TypeScript RLS tests in
-- tests/rls.isolation.test.ts are the application-level smoke tests.
-- Both must pass — they catch different classes of bugs.

begin;
create extension if not exists pgtap;

select plan(12);

-- ============ FIXTURES ============
-- Use auth.users table directly so the handle_new_user trigger fires
-- and creates profiles + personal workspaces. This mirrors real signup flow.

insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'alice@test.dev',
   crypt('TestPassword!2024', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Alice","language":"en"}'::jsonb,
   now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'bob@test.dev',
   crypt('TestPassword!2024', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Bob","language":"en"}'::jsonb,
   now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   '33333333-3333-3333-3333-333333333333',
   'authenticated', 'authenticated', 'carol@test.dev',
   crypt('TestPassword!2024', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Carol","language":"en"}'::jsonb,
   now(), now())
on conflict (id) do nothing;

-- Create a shared workspace (the handle_new_user trigger already created
-- personal workspaces for each user).
insert into public.workspaces (id, slug, name, is_personal, billing_owner_id)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'acme-test', 'Acme Test', false,
        '11111111-1111-1111-1111-111111111111')
on conflict (slug) do nothing;

-- Add alice + bob as members of the shared workspace.
insert into public.workspace_members (workspace_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member')
on conflict do nothing;

-- Create conversations: alice's in the workspace, bob's outside (no workspace).
insert into public.conversations (id, workspace_id, user_id, mode) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'chat'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd',
   (select id from public.workspaces where slug = 'u-22222222-2222-2222-2222-222222222222' and is_personal = true),
   '22222222-2222-2222-2222-222222222222', 'chat')
on conflict (id) do nothing;

-- Alice's message in the workspace conversation.
insert into public.messages (id, conversation_id, role, content) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
   'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'user', 'alice secret')
on conflict (id) do nothing;

-- ============ HELPER: set auth context ============
-- Supabase RLS reads auth.uid() from the request.jwt.claims setting.
-- We set it via set_config(., ., true) so it propagates to nested calls.
create or replace function set_auth(uid uuid, ws uuid default null)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  -- The workspace context is set when the caller is acting on behalf
  -- of a workspace session. Our RLS policies use is_workspace_member()
  -- which reads auth.uid() directly, so this is mainly for tests that
  -- want to assert workspace-scoped access.
  perform set_config('app.current_workspace', coalesce(ws::text, ''), true);
end;
$$;

-- ============ TESTS ============

-- 1. Alice sees her own conversation.
select set_auth('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is(
  (select count(*) from public.conversations where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1::bigint,
  'alice can read own conversation'
);

-- 2. Bob cannot read Alice's conversation when not in the workspace context.
select set_auth('22222222-2222-2222-2222-222222222222', null);
select is(
  (select count(*) from public.conversations where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  0::bigint,
  'bob cannot read alice conversation without workspace context'
);

-- 3. Bob CAN read via workspace membership (he's a member of Acme).
select set_auth('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is(
  (select count(*) from public.conversations where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1::bigint,
  'bob reads alice conversation via workspace membership'
);

-- 4. Carol (not a member of any workspace) sees zero conversations.
select set_auth('33333333-3333-3333-3333-333333333333', null);
select is(
  (select count(*) from public.conversations),
  0::bigint,
  'carol sees zero conversations'
);

-- 5. Cross-user message read denied when not in workspace context.
select set_auth('22222222-2222-2222-2222-222222222222', null);
select is(
  (select count(*) from public.messages where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0::bigint,
  'bob cannot read alice messages without workspace context'
);

-- 6. Alice can write to her own conversation.
select set_auth('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select lives_ok(
  $$insert into public.messages (conversation_id, role, content)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'user', 'hello')$$,
  'alice can insert into own conversation'
);

-- 7. Bob (workspace member) cannot insert into Alice's conversation —
--    only the conversation owner can write messages.
select set_auth('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  $$insert into public.messages (conversation_id, role, content)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'user', 'hijack')$$,
  '42501',  -- insufficient_privilege (RLS denied)
  'bob cannot insert into alice conversation even as workspace member'
);

-- 8. Budget visibility: user sees own budget only.
insert into public.usage_budgets (scope_type, scope_id, cost_limit_usd) values
  ('user', '11111111-1111-1111-1111-111111111111', 10.00),
  ('user', '22222222-2222-2222-2222-222222222222', 20.00)
on conflict (scope_type, scope_id, period) do nothing;

select set_auth('11111111-1111-1111-1111-111111111111', null);
select is(
  (select count(*) from public.usage_budgets),
  1::bigint,
  'alice sees only own budget'
);

-- 9. Check constraint on feedback rating (must be 1 or -1, not 5).
select set_auth('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  $$insert into public.message_feedback (message_id, user_id, rating)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            '11111111-1111-1111-1111-111111111111', 5)$$,
  '23514',  -- check_violation
  'rating must be 1 or -1'
);

-- 10. Role check constraint on messages (role must be user/assistant/system).
select throws_ok(
  $$insert into public.messages (conversation_id, role, content)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'admin', 'x')$$,
  '23514',  -- check_violation
  'invalid role rejected'
);

-- 11. Cascade delete: deleting a conversation deletes its messages.
select set_auth('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select lives_ok(
  $$delete from public.conversations where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  'alice deletes own conversation'
);
select is(
  (select count(*) from public.messages where conversation_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  0::bigint,
  'messages cascade-deleted with conversation'
);

-- 12. Share-link expiry enforced: an expired share link grants no access.
-- The RLS policy on share_links must check `expires_at > now()` so that
-- even if a token hash matches, an expired link returns zero rows.
--
-- We use Bob's personal-workspace conversation ('dddddddd-...') so we
-- don't need Alice's deleted conversation from test 11. Bob is the owner,
-- so we set auth to Bob BEFORE inserting the share link (RLS requires
-- the conversation owner to be the auth.uid() for share_links INSERT).
select set_auth('22222222-2222-2222-2222-222222222222', null);
insert into public.share_links (id, conversation_id, token_hash, expires_at) values
  ('ffffffff-ffff-ffff-ffff-ffffffffffff',
   'dddddddd-dddd-dddd-dddd-dddddddddddd',
   encode(digest('tok123', 'sha256'), 'hex'),
   now() - interval '1 hour')  -- already expired
on conflict (id) do nothing;

-- Bob (the conversation owner) tries to read via the expired share link.
-- Even though Bob owns the conversation, the JOIN through share_links
-- should return zero rows because the link is expired.
select is(
  (select count(*)
   from public.conversations c
   join public.share_links s on s.conversation_id = c.id
   where s.token_hash = encode(digest('tok123', 'sha256'), 'hex')),
  0::bigint,
  'expired share link grants no access'
);

select * from finish();
rollback;
