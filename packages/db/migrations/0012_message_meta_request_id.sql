-- ============ MESSAGE_META: request_id column ============
-- Adds a `request_id` column so every message can be traced back to the
-- specific HTTP request that generated it. This closes the support-ticket
-- loop: "my reply was slow at 3pm" → find the message_meta row with
-- matching request_id → see exact provider, latency, token counts, cost.

alter table public.message_meta
  add column if not exists request_id text;

create index if not exists idx_message_meta_request_id
  on public.message_meta (request_id)
  where request_id is not null;

comment on column public.message_meta.request_id is
  'Edge-generated request ID (UUID). Threads through middleware → route → provider → audit log. Used for support-ticket traceability.';
