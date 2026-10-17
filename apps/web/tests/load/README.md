/**
 * k6 load test configuration for the Supa AI chat stack.
 *
 * Prerequisites:
 *   1. Install k6: https://k6.io/docs/getting-started/installation/
 *   2. Start the dev server: pnpm dev
 *   3. Start local Supabase: pnpm supabase:start
 *   4. Sign in via the UI and copy your access_token from localStorage
 *   5. Run:
 *        API_TOKENS=eyJhbGciOi... BASE_URL=http://localhost:3000 \
 *          pnpm --filter @supa/web test:load
 *
 * Scenarios:
 *   S1 (steady)      — ramps 0→50→50→0 VUs over 7 minutes; sends chat messages
 *   S2 (history)     — 10 req/s for 5 minutes; fetches 500-message conversations
 *   S3 (failover)    — 5 VUs for 2 minutes; kills the primary provider and verifies
 *                       the response still comes through via a fallback
 *
 * Thresholds (CI gates):
 *   - chat_ttfb_ms p(95) < 800ms
 *   - chat_total_ms p(95) < 2500ms
 *   - stream_errors count < 50
 *   - http_req_failed rate < 1% (steady) / < 5% (history)
 *   - history_read_ms p(95) < 1500ms
 *
 * Environment variables:
 *   BASE_URL          — target URL (default http://localhost:3000)
 *   API_TOKENS        — comma-separated Supabase access tokens
 *   WORKSPACE_ID      — workspace to create conversations in
 *   HISTORY_CONV_IDS  — pre-seeded conversation IDs with 500+ messages
 *                       (if unset, the test creates them via /api/test/seed-conversation)
 *
 * NOTE: the /api/test/mock-fail and /api/test/seed-conversation endpoints
 * are test-only and must NOT be deployed to production. They're gated by
 * NODE_ENV !== 'production' in their route handlers.
 */
