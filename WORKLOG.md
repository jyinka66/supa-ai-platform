# Supa AI — Work Log & New-Chat Handoff

> **Standing rule:** Read this file first in every new session. Update it after every meaningful code change, investigation, migration, or deployment. Keep current state, verified/unverified status, next actions, and the change log accurate so work can resume without asking the user to repeat context.

**Updated:** 2026-10-18  
**Repository:** `jyinka66/supa-ai-platform` · **Branch:** `main`  
**Latest verified source commit:** `e3259c0cef5c0ff408730042e8699bd33cac3252` (serverless DB pooler support; Vercel READY/CI success before the current prompt-handoff follow-up).  
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

Current Home has a welcome banner, eight mode cards, four summary cards, recent conversations, and workspace list/selector. This code change replaces the dashboard's bespoke sidebar with the shared sidebar and creates a real searchable History screen with reopen, pin, rename, and delete actions. It is still not the final full dashboard: work/library overview, files/saved outputs, projects/tasks, and usage insights remain to be integrated. Verify this commit's build before treating the UI as released.

A shared `WorkspaceSidebar` and persistent active-workspace endpoint are added in the current code change. The server validates membership before setting the HTTP-only `ws` cookie; dashboard and chat resolve the saved workspace against the caller's RLS-filtered workspace list. Shared sidebar is present on Home and chat; a real searchable History screen supports reopen, pin/unpin, rename, and delete. The capability dropdown persists Chat/Code/Write/etc. mode on the same conversation. Home is now being changed from separate tool cards to a single prompt-first AI Studio launcher with prompt forwarding and pinned conversation shortcuts; verify the follow-up commit's build. Workspace/mode switching still needs a signed-in browser test.

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

Chat includes “Ask Supa AI”, prompt suggestions, three animated red thinking dots, optional soft beeps (enabled on a fresh visit), live status text, stop, retry, copy response, and code-fence rendering. The current code change adds a mode selector within the same conversation; changing Chat/Code/Write/etc. persists the mode on the existing conversation rather than forcing a separate interface. A shared navigation/sidebar now also appears in chat. The deeper product integration and real provider response still require testing.

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

### P0 — repair direct database readiness without exposing credentials
- Confirm the deployed `DATABASE_URL` target/host and port safely (never log credentials).
- Supabase project region is `eu-west-1`; project metadata identifies direct host `db.ikugfclxahxvjduowjbo.supabase.co`. The live direct-db health check fails. Get the exact shared pooler URI from Supabase Dashboard → Connect (session mode if the driver requires session/prepared statements; transaction mode only after verifying driver settings), then update Vercel production `DATABASE_URL` without printing or committing the password.
- Redeploy and verify `/api/health` reports DB and feature_flags healthy before exposing work-library/usage APIs in Home.

### P1 — prove AI chat works end to end
1. Sign in to production and send a short prompt.
2. Verify `POST /api/chat/stream`, first token, progressive deltas, saved assistant response, and that reload restores it.
3. If it fails, use the request ID and safe provider reason; verify Gemini/OpenRouter keys and model access server-side without exposing key values.
4. Test cancel/stop, retry, provider fallback, idempotency, stream-buffer/reconnect behavior, and Redis TTL.
5. Add tests for SSE frame boundaries, provider-key filtering, user-message persistence, retry, and error paths.

### P2 — unified application shell and workspace
1. Build shared authenticated layout: sidebar/mobile drawer, global header, New Chat, account menu, workspace selector.
2. Persist selected workspace securely; validate membership on every API use and align it with the `ws` cookie expected by work APIs.
3. Unify Chat and Code in one AI Studio; switch mode inside the same product surface.
4. Add full History: search, rename, pin, delete, reopen.

### P3 — real Home dashboard
1. Add Continue Working, pinned/recent chats, saved outputs/files, projects/tasks/activity, quick capture, and useful “view all” links.
2. Source each section from live APIs/data. Add proper loading, empty and actionable error states.
3. Show usage/limits only when backed by reliable data.
4. Design/test desktop and mobile layouts.

### P4 — Library and AI artifacts
- Build Files & Work Library against existing items/folders/export/share APIs after resolving workspace context.
- Save AI answers/artifacts and connect them to source conversations.
- Add attachments only after upload/storage/download flow is verified.
- In Code mode, add code artifacts/diffs/run output only when sandbox execution and permission checks are proven.

### P5 — remaining product modules and security
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


### 2026-10-18 — Shared workspace navigation and same-thread modes (new commit pending CI at time of log update)
- Added shared `WorkspaceSidebar` to dashboard and chat, with Home, AI Studio, History, New Chat, and workspace selection.
- Added `POST /api/workspaces/active`, which checks membership through the authenticated Supabase client before setting an HTTP-only, same-site `ws` cookie.
- Added `getActiveWorkspaceId()` to resolve the cookie only against the signed-in user's allowed workspace list; dashboard and chat now receive this saved selection.
- Added a real localized `/history` page with search, pinned filter, reopen, rename, pin/unpin, and delete actions using the existing conversation API.
- Added conversation-mode updates to `PATCH /api/conversations/:id` and its Supabase update helper; AI Studio can switch Chat/Code/Write/etc. without changing conversation ID.
- Mobile navigation was added to the shared sidebar and reserved bottom space in the page layouts.
- **Build and runtime status:** source changes are committed with this log update; the triggered Vercel build must be checked. Workspace switching and same-thread mode switching still need a signed-in browser test.


### 2026-10-18 — Prompt-first Home and pinned conversations (source follow-up pending CI at time of log update)
- Replaced the grid of separate AI-tool launch cards with one Supa AI Studio composer and capability selector.
- Home submits prompt + selected mode into a new conversation; chat reads the initial prompt from the URL, removes it from the address bar, and sends it once.
- Added pinned-conversation shortcuts pulled from the existing conversation list and linked to History; empty state explains how to pin work.
- Production health smoke test found `/api/health` reports `db: fail`, `feature_flags: fail`, `redis: ok`; `/api/readyz` returns `not_ready`. This is now the top infrastructure blocker.


### 2026-10-18 — Database pooler support implementation (`e3259c0`, deployment READY)
- Added exported `resolveDatabaseUrl()` in `packages/db/src/client.ts`.
- If `SUPABASE_DB_POOLER_HOST` is configured, it validates the host suffix and hostname-only input, preserves the existing DB password, sets the shared-pooler username to `postgres.<project-ref>`, and defaults to port `6543` (transaction mode). Port `5432` is available for explicit session-mode use.
- Supabase endpoints use `ssl: "require"`; Vercel instances use a client pool max of 1, `prepare: false`, 10-second connect timeout and 20-second idle timeout.
- Added `packages/db/tests/database-url.test.ts` for passthrough, pooler rewrite, password preservation, host validation and port validation. Added optional vars to `.env.example`.
- **This does not fix production by itself:** the production `SUPABASE_DB_POOLER_HOST` is not yet configured because its pooler cluster cannot be derived from region. Need the exact hostname from Supabase Dashboard > Connect > Transaction pooler, then set it in Vercel and verify both health endpoints return 200.


### 2026-10-18 — Home prompt handoff privacy fix (source follow-up pending CI)
- Changed new Home prompt handoff from a `?prompt=` query string to per-tab `sessionStorage` keyed by conversation ID, so prompt text is not written into the address bar, browser history, or request URLs.
- Kept a compatibility path for older `?prompt=` links; the chat removes the old parameter from the address bar as soon as it consumes it.
- This commit needs build/CI verification. Database health is still blocked until the exact Supabase transaction-pooler hostname is configured in Vercel; do not claim healthy until `/api/health` and `/api/readyz` return 200.
