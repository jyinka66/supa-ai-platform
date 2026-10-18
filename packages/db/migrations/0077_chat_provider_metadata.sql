-- 0077_chat_provider_metadata.sql
-- Keep message metadata compatible with the AI providers configured by the app.
-- User messages do not receive provider metadata; "none" marks failed generations
-- that are still recorded for observability.

alter table public.message_meta
  drop constraint if exists message_meta_provider_check;

alter table public.message_meta
  add constraint message_meta_provider_check
  check (
    provider = any (
      array[
        'openai',
        'anthropic',
        'google',
        'mistral',
        'cohere',
        'azure',
        'local',
        'gemini',
        'groq',
        'openrouter',
        'none'
      ]::text[]
    )
  );
