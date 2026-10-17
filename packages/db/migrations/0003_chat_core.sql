-- ============ CHAT CORE SCHEMA ============
-- Conversations, messages, feedback, reports, share links, budgets.
-- All tables use RLS; workspace-scoped tables route via the
-- is_workspace_member() / workspace_role() helpers from migration 0001.

create extension if not exists pgcrypto;

-- ============ FOLDERS ============
-- Lightweight grouping for conversations (per-user, optional).
create table if not exists conversation_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users set in raw SQL (see migration 0001 pattern)
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists idx_folders_user on conversation_folders(user_id);

-- ============ CONVERSATIONS ============
create table conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users via raw SQL below (Drizzle can't reference auth schema)
  mode text not null default 'chat'
    check (mode in ('chat','write','rewrite','summarize','translate','code','image','document','plan')),
  title text check (title is null or char_length(title) <= 200),
  title_auto boolean not null default true,
  language_pref text check (language_pref is null or (language_pref ~ '^[a-z]{2}(-[A-Z]{2})?$')),
  pinned boolean not null default false,
  folder_id uuid references conversation_folders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_conv_workspace on conversations(workspace_id, updated_at desc);
create index idx_conv_user on conversations(user_id, updated_at desc);
create index idx_conv_pinned on conversations(user_id, pinned) where pinned = true;

-- ============ MESSAGES (immutable, versioned, branching) ============
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  parent_message_id uuid references messages(id) on delete set null,
  role text not null check (role in ('user','assistant','system')),
  content text not null check (char_length(content) > 0),
  version int not null default 1 check (version >= 1),
  language_detected text check (language_detected is null or (language_detected ~ '^[a-z]{2}(-[A-Z]{2})?$')),
  prompt_version text,
  status text not null default 'completed'
    check (status in ('streaming','completed','aborted','error','refused')),
  created_at timestamptz not null default now()
);

create index idx_msg_conv on messages(conversation_id, created_at);
create index idx_msg_parent on messages(parent_message_id);
create index idx_msg_status on messages(status) where status <> 'completed';

-- ============ MESSAGE META (cost, latency, routing) ============
create table message_meta (
  message_id uuid primary key references messages(id) on delete cascade,
  model text not null,
  provider text not null check (provider in ('openai','anthropic','google','mistral','cohere','azure','local')),
  input_tokens int check (input_tokens is null or input_tokens >= 0),
  output_tokens int check (output_tokens is null or output_tokens >= 0),
  cost_usd numeric(10,6) check (cost_usd is null or cost_usd >= 0),
  latency_first_token_ms int check (latency_first_token_ms is null or latency_first_token_ms >= 0),
  latency_total_ms int check (latency_total_ms is null or latency_total_ms >= 0),
  retries int not null default 0 check (retries >= 0),
  fallback_path jsonb not null default '[]'::jsonb,
  idempotency_key text unique
);

-- ============ FEEDBACK ============
create table message_feedback (
  message_id uuid references messages(id) on delete cascade,
  user_id uuid not null,  -- FK to auth.users via raw SQL
  rating smallint not null check (rating in (1,-1)),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index idx_feedback_msg on message_feedback(message_id);

-- ============ REPORTS ============
create table message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  reporter_id uuid not null,  -- FK to auth.users via raw SQL
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  reviewed_by uuid,  -- FK to auth.users via raw SQL
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_reports_status on message_reports(status) where status in ('open','reviewing');
create index idx_reports_message on message_reports(message_id);

-- ============ SHARE LINKS ============
create table share_links (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  token_hash text not null unique,   -- sha256 of token; raw token never stored
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index idx_share_conv on share_links(conversation_id);
create index idx_share_expires on share_links(expires_at) where revoked_at is null;

-- ============ USAGE BUDGETS ============
create table usage_budgets (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('user','workspace')),
  scope_id uuid not null,
  period text not null default 'monthly' check (period in ('daily','weekly','monthly','yearly')),
  cost_limit_usd numeric(10,2) not null check (cost_limit_usd >= 0),
  alert_threshold numeric(3,2) not null default 0.80 check (alert_threshold between 0 and 1),
  created_at timestamptz not null default now(),
  unique (scope_type, scope_id, period)
);

-- ============ FKs TO auth.users (raw SQL — Drizzle can't reference auth schema) ============
-- Pattern from migration 0001: profile FK is created in raw SQL.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'conversations_user_id_fkey' and table_name = 'conversations'
  ) then
    alter table conversations
      add constraint conversations_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'message_feedback_user_id_fkey' and table_name = 'message_feedback'
  ) then
    alter table message_feedback
      add constraint message_feedback_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'message_reports_reporter_id_fkey' and table_name = 'message_reports'
  ) then
    alter table message_reports
      add constraint message_reports_reporter_id_fkey
      foreign key (reporter_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'message_reports_reviewed_by_fkey' and table_name = 'message_reports'
  ) then
    alter table message_reports
      add constraint message_reports_reviewed_by_fkey
      foreign key (reviewed_by) references auth.users(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'conversation_folders_user_id_fkey' and table_name = 'conversation_folders'
  ) then
    alter table conversation_folders
      add constraint conversation_folders_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ============ CONVERSATION UPDATED_AT TRIGGER ============
-- Bumps conversations.updated_at whenever a new message is inserted,
-- so conversation lists reorder by activity.
create or replace function public.touch_conversation_updated_at()
returns trigger
security definer
set search_path = public
language plpgsql
as $function$
begin
  update public.conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$function$;

drop trigger if exists trg_msg_touch_conv on public.messages;
create trigger trg_msg_touch_conv
after insert on public.messages
for each row execute function public.touch_conversation_updated_at();

-- ============ ENABLE RLS ============
alter table conversation_folders enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table message_meta enable row level security;
alter table message_feedback enable row level security;
alter table message_reports enable row level security;
alter table share_links enable row level security;
alter table usage_budgets enable row level security;

-- ============ CONVERSATIONS RLS ============
-- Owner can see all their conversations; workspace members can see
-- conversations scoped to their workspace (read-only — only the owner
-- can write/delete).
create policy conv_select on conversations
  for select using (
    user_id = auth.uid()
    or public.is_workspace_member(workspace_id)
  );

create policy conv_insert on conversations
  for insert with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy conv_update on conversations
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy conv_delete on conversations
  for delete using (user_id = auth.uid());

-- ============ MESSAGES RLS ============
create policy msg_select on messages
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and (c.user_id = auth.uid()
             or public.is_workspace_member(c.workspace_id))
    )
  );

create policy msg_insert on messages
  for insert with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

create policy msg_update on messages
  for update using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy msg_delete on messages
  for delete using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- ============ MESSAGE META RLS ============
create policy meta_select on message_meta
  for select using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_meta.message_id
        and (c.user_id = auth.uid()
             or public.is_workspace_member(c.workspace_id))
    )
  );

create policy meta_insert on message_meta
  for insert with check (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_meta.message_id and c.user_id = auth.uid()
    )
  );

create policy meta_delete on message_meta
  for delete using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_meta.message_id and c.user_id = auth.uid()
    )
  );

-- ============ FEEDBACK RLS ============
create policy feedback_select on message_feedback
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_feedback.message_id
        and public.is_workspace_member(c.workspace_id)
    )
  );

create policy feedback_insert on message_feedback
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_feedback.message_id
        and (c.user_id = auth.uid()
             or public.is_workspace_member(c.workspace_id))
    )
  );

create policy feedback_delete on message_feedback
  for delete using (user_id = auth.uid());

-- ============ REPORTS RLS ============
-- Reporters can see their own reports; workspace admins/owners can see
-- all reports in their workspace (for moderation queue).
create policy reports_select on message_reports
  for select using (
    reporter_id = auth.uid()
    or exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_reports.message_id
        and public.workspace_role(c.workspace_id) in ('owner','admin')
    )
  );

create policy reports_insert on message_reports
  for insert with check (
    reporter_id = auth.uid()
    and exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_reports.message_id
        and (c.user_id = auth.uid()
             or public.is_workspace_member(c.workspace_id))
    )
  );

create policy reports_update on message_reports
  for update using (
    exists (
      select 1 from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_reports.message_id
        and public.workspace_role(c.workspace_id) in ('owner','admin')
    )
  );

-- ============ SHARE LINKS RLS ============
create policy share_select on share_links
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = share_links.conversation_id
        and (c.user_id = auth.uid()
             or public.is_workspace_member(c.workspace_id))
    )
  );

create policy share_insert on share_links
  for insert with check (
    exists (
      select 1 from public.conversations c
      where c.id = share_links.conversation_id and c.user_id = auth.uid()
    )
  );

create policy share_update on share_links
  for update using (
    exists (
      select 1 from public.conversations c
      where c.id = share_links.conversation_id and c.user_id = auth.uid()
    )
  );

create policy share_delete on share_links
  for delete using (
    exists (
      select 1 from public.conversations c
      where c.id = share_links.conversation_id and c.user_id = auth.uid()
    )
  );

-- ============ USAGE BUDGETS RLS ============
create policy budget_select on usage_budgets
  for select using (
    (scope_type = 'user' and scope_id = auth.uid())
    or (scope_type = 'workspace' and public.is_workspace_member(scope_id))
  );

create policy budget_insert on usage_budgets
  for insert with check (
    (scope_type = 'user' and scope_id = auth.uid())
    or (scope_type = 'workspace' and public.workspace_role(scope_id) in ('owner','admin'))
  );

create policy budget_update on usage_budgets
  for update using (
    (scope_type = 'user' and scope_id = auth.uid())
    or (scope_type = 'workspace' and public.workspace_role(scope_id) in ('owner','admin'))
  );

create policy budget_delete on usage_budgets
  for delete using (
    (scope_type = 'user' and scope_id = auth.uid())
    or (scope_type = 'workspace' and public.workspace_role(scope_id) in ('owner','admin'))
  );
