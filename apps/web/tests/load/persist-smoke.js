import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// ============ Custom metrics ============
const resumeSuccess = new Counter("resume_success");
const resumeEmpty = new Counter("resume_empty");
const resumeExpired = new Counter("resume_expired");
const resumeMissed = new Counter("resume_no_streamId");

// ============ Config ============
const BASE = __ENV.BASE_URL || "http://localhost:3000";
const TOKENS = __ENV.API_TOKENS ? __ENV.API_TOKENS.split(",") : ["dev-token-1"];
const WORKSPACE_ID = __ENV.WORKSPACE_ID || "00000000-0000-0000-0000-000000000000";

/**
 * Resume-path verification under load.
 *
 * Flow per iteration:
 *   1. Create a conversation
 *   2. Start a streaming request, abort it after ~300ms
 *   3. Extract the streamId from whatever SSE events we got
 *   4. Hit GET /api/chat/stream?streamId=... to resume
 *   5. Verify the resume response contains accumulated content
 *
 * Thresholds:
 *   - http_req_failed rate < 5% (some aborts are expected to 499)
 *   - resume_success count should be > 0 (at least some resumes work)
 *
 * NOTE: this test is inherently flaky because it races the abort against
 * the first delta. If the LLM responds faster than 300ms (rare), we might
 * get a full response before aborting — that's fine, the resume check
 * still runs. If the LLM is slow, we might abort before ANY delta — then
 * we can't extract a streamId and the iteration is a no-op.
 */
export const options = {
  vus: 10,
  duration: "2m",
  thresholds: {
    http_req_failed: ["rate<0.10"], // aborts count as failures; allow up to 10%
    resume_success: ["count>10"], // at least 10 successful resumes over the run
  },
};

function authHeaders(vuIdx) {
  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKENS[vuIdx % TOKENS.length]}`,
    },
  };
}

function createConversation(vuIdx) {
  const res = http.post(
    `${BASE}/api/conversations`,
    JSON.stringify({ workspaceId: WORKSPACE_ID, mode: "chat" }),
    authHeaders(vuIdx),
  );
  if (res.status !== 200 && res.status !== 201) return null;
  try {
    const body = JSON.parse(res.body);
    return body?.data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Extracts the streamId from an SSE response body.
 *
 * The stream route emits `event: delta\ndata: {"streamId":"...",...}` on the
 * first chunk. We search for the first occurrence of `"streamId":"..."`.
 */
function extractStreamId(body) {
  if (!body) return null;
  const match = body.match(/"streamId":"([0-9a-f-]{36})"/);
  return match ? match[1] : null;
}

export default function () {
  // 1. Create a conversation (the stream route requires a valid UUID).
  const conversationId = createConversation(__VU);
  if (!conversationId) {
    sleep(1);
    return;
  }

  // 2. Start the stream — abort after 300ms via responseTimeout.
  //    k6 will throw if the response takes longer than responseTimeout,
  //    but the partial body is still available on `res.body`.
  //
  //    NOTE: k6's `responseTimeout` causes the request to error out, so
  //    `res.status` will be 0 and `res.error` will be set. But `res.body`
  //    contains whatever was received before the timeout — that's what
  //    we extract the streamId from.
  const streamPayload = JSON.stringify({
    conversationId,
    content: "Write a detailed essay about eventual consistency in distributed systems.",
    idempotencyKey: `resume-${__VU}-${__ITER}-${Date.now()}`,
    language: "en",
    mode: "chat",
  });

  const res = http.post(`${BASE}/api/chat/stream`, streamPayload, {
    ...authHeaders(__VU),
    responseType: "text",
    responseTimeout: "300ms",
  });

  // The request likely errored (timeout), but we may have partial body.
  const partialBody = res.body || "";
  const streamId = extractStreamId(partialBody);

  if (!streamId) {
    // The LLM hadn't emitted any deltas within 300ms — nothing to resume.
    resumeMissed.add(1);
    sleep(0.5);
    return;
  }

  // 3. Small delay so the throttled buffer has time to flush to Redis.
  // The ThrottledStreamBuffer flushes every 250ms, so waiting 350ms
  // ensures at least one flush happened.
  sleep(0.35);

  // 4. Resume by streamId.
  const resumeRes = http.get(
    `${BASE}/api/chat/stream?streamId=${streamId}`,
    authHeaders(__VU),
  );

  const resumeBody = resumeRes.body || "";

  const checks = check(resumeBody, {
    "resume returns content": (b) => b.includes("event: resume"),
    "resume content non-empty": (b) => !b.includes('"text":""'),
  });

  if (checks) {
    resumeSuccess.add(1);
  } else if (resumeBody.includes("event: expired")) {
    resumeExpired.add(1);
  } else if (resumeBody.includes('"text":""')) {
    resumeEmpty.add(1);
  }

  sleep(0.5);
}
