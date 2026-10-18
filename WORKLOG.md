# Supa AI — Work Log & New-Chat Handoff

> **Standing rule:** Read this file first in every new session. Update it after every meaningful code change, investigation, migration, or deployment. Keep current state, verified/unverified status, next actions, and the change log accurate so work can resume without asking the user to repeat context.

**Updated:** 2026-10-18  
**Repository:** `jyinka66/supa-ai-platform` · **Branch:** `main`  
**Source at last check:** `eddbd38818b09158986dced0998295dacd35f502`  
**Production:** https://supa-ai-platform.vercel.app/  
**Supabase project ref:** `ikugfclxahxvjduowjbo`

## Product direction agreed with the user

Supa should be a **connected AI workspace**, not a static dashboard full of disconnected tool cards.

- **One AI Studio, one conversation experience.** General chat, Code, Write, Rewrite, Summarize, Translate, Analyze, and Plan should be modes inside one shared conversational workspace, not separate products with different interfaces and disconnected history.
- **Code Help belongs inside AI Studio.** Keep the same conversation/context. Add syntax-aware output, copy, file creation/editing, diffs, and execution output only when the secure sandbox backend works end to end.
- **Home is a real dashboard, not just a launcher.** Prioritize Continue Working, pinned/recent conversations, saved AI outputs, files, projects/work/tasks, activity, quick capture, and live usage where reliable data exists.
- **Persistent app shell:** Home, AI Studio, History, Projects & Workspaces, Files & Library, Templates, Automations/Agents (only when end-to-end working), Integrations, Usage/Billing, Settings. Include mobile navigation, global New Chat, account menu, and workspace switcher.
- No dead buttons, fake counts, decorative integrations, or unfinished features presented as complete.
- Onboarding remains optional; successful sign-in should lead to dashboard.
- After each substantive session, update this file. Never claim a feature works just because the build passed.

## Current state (last verified 2026-10-18)

### Production and verification
- Latest source commit observed: `eddbd38818b09158986dced0998295dacd35f502`, message `fix(chat): skip unconfigured providers and protect stream resume`.
- Latest Vercel deployment observed: `dpl_9a5YBK98jaXg6dvj29wrjPkadHhj`, **READY**, with production alias `supa-ai-platform.vercel.app`. Vercel CI reported success.
- Live unauthenticated GET `/api/chat/stream` returned the expected `400 missing_stream_id`: the endpoint responds, but this is **not** proof that a signed-in AI request succeeds.
- Recent chat error aggregation returned no errors during the inspected window; this is not proof of successful usage.
- **No signed-in end-to-end browser test has proved that an answer streams progressively, persists, and reloads from history.** That test remains a release gate.

### Dashboard
Files: `apps/web/src/app/[locale]/dashboard/page.tsx` and `dashboard/dashboard-client.tsx`.

Current Home has a welcome banner, eight mode cards, four summary cards, recent conversations, and workspace list/selector. It is still too thin: no persistent app shell, full History, work/library overview, files/saved outputs, projects/tasks, or unified global workspace context.

The active workspace selector is local component state. Some work APIs expect a `ws` cookie. Workspace selection must become persistent and be membership-validated server-side across APIs.

### Chat
Files:
- `apps/web/src/app/[locale]/chat/[conversationId]/chat-client.tsx`
- `apps/web/src/app/[locale]/chat/[conversationId]/composer.tsx`
- `apps/web/src/app/[locale]/chat/[conversationId]/message-bubble.tsx`
- `apps/web/src/app/api/chat/stream/route.ts`
- `apps/web/src/lib/chat/queries.ts`
- `apps/web/src/lib/llm/persist-message.ts`
- `apps/web/src/lib/llm/provider-registry.ts`
- `apps/web/src/lib/router/router.ts`

Chat includes “Ask Supa AI”, prompt suggestions, three animated red thinking dots, optional soft beeps (enabled on a fresh visit), live status text, stop, retry, copy response, and code-fence rendering. The deeper product integration and real provider response still require testing.

The earlier stream failure included DB constraint `message_meta_provider_check` rejecting provider metadata for user messages. Live migration `0077_chat_provider_metadata.sql` was applied and verified; user-message persistence was changed to avoid AI-provider metadata. Core chat reads/writes were moved to the signed-in Supabase Data API after the direct PostgreSQL connection previously timed out.

The latest source commit:
- Filters providers by whether their API-key environment variable is non-empty.
- Requires authentication and per-user ownership for stream-resume GET.
- Updates Gemini request handling to send the key in a header and removes an unsupported request field.
- Uses `APP_URL` for the OpenRouter HTTP referer.

### Environment and reliability caveats
The Vercel environment listing showed variable names including `DATABASE_URL`, Supabase URL/anon/service-role variables, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `APP_URL`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY`. Secret values are not readable through the current tool, so actual key validity is unknown. No `GROQ_API_KEY` variable name was present; Groq should be skipped. Earlier logs showed `DATABASE_URL is required` and direct PostgreSQL `ETIMEDOUT`; non-chat Drizzle APIs remain unverified.

Migrations live under `packages/db/migrations`. Bootstrap and migration-chain repairs were applied to the connected Supabase project; live migration `0077_chat_provider_metadata.sql` is in source. Confirm the normal migration pipeline reproduces live schema changes. Prior inspection found about 165 base tables. A DB table or API endpoint does not prove a finished frontend feature.

Existing API areas found include conversations, chat stream/complete, work items/folders/share/export, signed upload, builder sessions, workspaces, templates by ID, Supa OS catalog/compliance/ledger/loan/marketplace/system prompt/WASM, sessions, invites, user export/deletion, health, metrics, and observability. Some use Drizzle/direct PostgreSQL and must be tested before surfacing as working product features.

## Next actions — continue in this order

### P0 — prove AI chat works end to end
1. Sign in to production and send a short prompt.
2. Verify `POST /api/chat/stream`, first token, progressive deltas, saved assistant response, and that reload restores it.
3. If it fails, use the request ID and safe provider reason; verify Gemini/OpenRouter keys and model access server-side without exposing key values.
4. Test cancel/stop, retry, provider fallback, idempotency, stream-buffer/reconnect behavior, and Redis TTL.
5. Add tests for SSE frame boundaries, provider-key filtering, user-message persistence, retry, and error paths.

### P1 — unified application shell and workspace
1. Build shared authenticated layout: sidebar/mobile drawer, global header, New Chat, account menu, workspace selector.
2. Persist selected workspace securely; validate membership on every API use and align it with the `ws` cookie expected by work APIs.
3. Unify Chat and Code in one AI Studio; switch mode inside the same product surface.
4. Add full History: search, rename, pin, delete, reopen.

### P2 — real Home dashboard
1. Add Continue Working, pinned/recent chats, saved outputs/files, projects/tasks/activity, quick capture, and useful “view all” links.
2. Source each section from live APIs/data. Add proper loading, empty and actionable error states.
3. Show usage/limits only when backed by reliable data.
4. Design/test desktop and mobile layouts.

### P3 — Library and AI artifacts
- Build Files & Work Library against existing items/folders/export/share APIs after resolving workspace context.
- Save AI answers/artifacts and connect them to source conversations.
- Add attachments only after upload/storage/download flow is verified.
- In Code mode, add code artifacts/diffs/run output only when sandbox execution and permission checks are proven.

### P4 — remaining product modules and security
- Integrate Projects/Tasks, Templates, workspace members/invites, Settings/security sessions, usage/billing, integrations, and agents only after end-to-end API and permission checks.
- Investigate direct DB connection and all Drizzle-backed routes.
- Review RLS/SECURITY DEFINER advisor findings individually; do not blanket-grant access.
- Confirm migration sync/deploy reproducibility.

### Acceptance gate
Test: sign in → Home → switch workspace → create chat → stream answer → stop/retry → reload history → switch to Code inside the same AI Studio → save output → reopen from Library. Verify mobile layout and cross-user access denial. A successful production build is not an end-to-end test.

## Change log

### 2026-10-18 — Handoff and product direction
- User confirmed Supa should be a connected AI workspace and that Chat and Code should be built together.
- Created this persistent handoff log to maintain continuity between chats.

### 2026-10-18 — Latest chat/provider hardening (`eddbd388`)
- Skip provider attempts when their API-key env variable is absent/empty.
- Secure stream-resume GET using auth and stream-owner check.
- Update Gemini request handling and OpenRouter referer.
- Deployment READY and CI success; signed-in provider response remains unverified.

### 2026-10-18 — Chat UI and metadata repair (`c4dab580`, type fix `ae79fe3`)
- Added unified Ask Supa AI panel, red thinking dots, soft optional beeps, status, stop/retry/copy, prompt suggestions, and code fence rendering.
- Fixed user-message persistence violation of `message_meta_provider_check`; migration `0077` applied and verified.
- Updated model IDs in source; live signed-in response still needs testing.

### Earlier — auth/bootstrap/migrations
- Removed onboarding as a sign-in blocker.
- Added identity/workspace bootstrap/backfill and repaired historical migration SQL.
- Switched core chat persistence to Supabase Data API following direct Postgres timeout.
