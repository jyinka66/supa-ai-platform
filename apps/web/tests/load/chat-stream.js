import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// ============ Custom metrics ============
const ttfb = new Trend("chat_ttfb_ms", true);
const totalMs = new Trend("chat_total_ms", true);
const streamErrors = new Counter("stream_errors");
const fallbacks = new Counter("provider_fallbacks");
const historyReadMs = new Trend("history_read_ms", true);

// ============ Config ============
const BASE = __ENV.BASE_URL || "http://localhost:3000";
// API_TOKENS is a comma-separated list of Supabase access tokens.
// In local dev, you can generate these by signing in via the UI and
// copying the access_token from localStorage.
const TOKENS = __ENV.API_TOKENS ? __ENV.API_TOKENS.split(",") : ["dev-token-1"];

// Pre-seeded conversation IDs for the history scenario.
// In a real run, set HISTORY_CONV_IDS=id1,id2,id3 to point at real conversations
// with 500+ messages. If unset, the scenario will create them via the seed endpoint.
const HISTORY_CONV_IDS = __ENV.HISTORY_CONV_IDS
  ? __ENV.HISTORY_CONV_IDS.split(",")
  : [];

// ============ Scenarios ============
export const options = {
  scenarios: {
    // S1: steady traffic — ramp up to 50 VUs, hold, ramp down.
    steady: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 50 },
        { duration: "5m", target: 50 },
        { duration: "1m", target: 0 },
      ],
      exec: "chatScenario",
      startTime: "0s",
    },
    // S2: long-conversation history reads — constant 10 req/s.
    history: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "5m",
      exec: "historyScenario",
      startTime: "30s",
      preAllocatedVUs: 20,
    },
    // S3: failover — kill the primary provider mid-run, verify fallback.
    failover: {
      executor: "constant-vus",
      vus: 5,
      duration: "2m",
      exec: "failoverScenario",
      startTime: "6m",
    },
  },
  thresholds: {
    chat_ttfb_ms: ["p(95)<800"],
    chat_total_ms: ["p(95)<2500"],
    stream_errors: ["count<50"],
    "http_req_failed{scenario:steady}": ["rate<0.01"],
    "http_req_failed{scenario:history}": ["rate<0.05"],
    history_read_ms: ["p(95)<1500"],
  },
};

// ============ Helpers ============
function authHeaders(vuIdx) {
  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKENS[vuIdx % TOKENS.length]}`,
    },
  };
}

/**
 * Parses an SSE response body and extracts:
 *   - TTFB (time to first `event: delta`)
 *   - Full accumulated text from delta events
 *   - Whether a `done` event was received
 *   - Whether a `fallback` event was received
 */
function parseSse(body) {
  const events = body.split("\n\n");
  let firstDeltaOffset = -1;
  let fullText = "";
  let sawDone = false;
  let sawFallback = false;
  let fallbackProviders = [];

  for (const evt of events) {
    const lines = evt.split("\n");
    let eventType = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (!data) continue;

    try {
      const parsed = JSON.parse(data);
      if (eventType === "delta" && firstDeltaOffset === -1) {
        // Mark the byte offset where the first delta appeared.
        firstDeltaOffset = body.indexOf("event: delta");
      }
      if (eventType === "delta" && typeof parsed.text === "string") {
        fullText += parsed.text;
      }
      if (eventType === "done") sawDone = true;
      if (eventType === "fallback") {
        sawFallback = true;
        if (parsed.to) fallbackProviders.push(parsed.to);
      }
    } catch {
      // Skip malformed event.
    }
  }

  return { firstDeltaOffset, fullText, sawDone, sawFallback, fallbackProviders };
}

/**
 * Creates a conversation via the API. Returns the conversation id.
 * Falls back to null if creation fails (the stream route will reject).
 */
function createConversation(vuIdx) {
  const res = http.post(
    `${BASE}/api/conversations`,
    JSON.stringify({
      workspaceId: __ENV.WORKSPACE_ID || "00000000-0000-0000-0000-000000000000",
      mode: "chat",
    }),
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

// ============ Scenarios ============

/**
 * S1: Steady chat traffic.
 * Creates a new conversation per iteration, sends a message, streams the response.
 */
export function chatScenario() {
  const conversationId = createConversation(__VU);
  if (!conversationId) {
    streamErrors.add(1);
    sleep(1);
    return;
  }

  const payload = JSON.stringify({
    conversationId,
    content: `Load test message ${__VU}-${__ITER}-${Date.now()}. Summarize the concept of eventual consistency.`,
    idempotencyKey: `load-${__VU}-${__ITER}-${Date.now()}`,
    language: "en",
    mode: "chat",
  });

  const res = http.post(`${BASE}/api/chat/stream`, payload, {
    ...authHeaders(__VU),
    responseType: "text",
    responseTimeout: "60s",
  });

  const ok = check(res, {
    "stream started": (r) => r.status === 200,
  });
  if (!ok) {
    streamErrors.add(1);
    sleep(1);
    return;
  }

  // TTFB: time from request start to first byte received.
  // k6's `timings.waiting` is the time waiting for the first response byte.
  ttfb.add(res.timings.waiting);
  totalMs.add(res.timings.duration);

  const body = res.body || "";
  const parsed = parseSse(body);

  check(body, {
    "got delta events": (b) => b.includes("event: delta"),
    "got done event": (b) => b.includes("event: done"),
  });

  if (parsed.sawFallback) {
    fallbacks.add(1);
  }

  sleep(Math.random() * 2 + 0.5); // human-like pacing
}

/**
 * S2: History reads — fetches 500 messages from a long conversation.
 * If HISTORY_CONV_IDS is set, cycles through them; otherwise creates a
 * seeded conversation via /api/test/seed-conversation (test-only endpoint).
 */
export function historyScenario() {
  let convId;
  if (HISTORY_CONV_IDS.length > 0) {
    convId = HISTORY_CONV_IDS[__VU % HISTORY_CONV_IDS.length];
  } else {
    // Create a seeded conversation with 500 messages.
    const seedRes = http.post(
      `${BASE}/api/test/seed-conversation`,
      JSON.stringify({ messageCount: 500 }),
      authHeaders(__VU),
    );
    if (seedRes.status !== 200) {
      streamErrors.add(1);
      sleep(1);
      return;
    }
    try {
      convId = JSON.parse(seedRes.body).conversationId;
    } catch {
      streamErrors.add(1);
      sleep(1);
      return;
    }
  }

  const res = http.get(
    `${BASE}/api/conversations/${convId}/messages?limit=500`,
    authHeaders(__VU),
  );

  const ok = check(res, {
    "history 200": (r) => r.status === 200,
    "history < 1.5s": (r) => r.timings.duration < 1500,
  });

  if (ok) {
    historyReadMs.add(res.timings.duration);
  } else {
    streamErrors.add(1);
  }

  sleep(1);
}

/**
 * S3: Failover — kills the primary provider via a test-only mock endpoint,
 * then sends a message and verifies the response still comes through (via
 * a fallback provider).
 *
 * Requires the test endpoint /api/test/mock-fail to be enabled (only in
 * non-production environments).
 */
export function failoverScenario() {
  // Kill the primary provider.
  const mockRes = http.post(
    `${BASE}/api/test/mock-fail`,
    JSON.stringify({ provider: "gemini", status: 500 }),
    authHeaders(0),
  );
  if (mockRes.status !== 200) {
    // Mock endpoint not available — skip this iteration.
    sleep(2);
    return;
  }

  const conversationId = createConversation(__VU);
  if (!conversationId) {
    streamErrors.add(1);
    sleep(1);
    return;
  }

  const res = http.post(
    `${BASE}/api/chat/stream`,
    JSON.stringify({
      conversationId,
      content: "failover probe message",
      idempotencyKey: `fo-${__VU}-${__ITER}-${Date.now()}`,
      language: "en",
      mode: "chat",
    }),
    {
      ...authHeaders(__VU),
      responseType: "text",
      responseTimeout: "60s",
    },
  );

  const body = res.body || "";
  check(res, {
    "still serves on fallback": (r) => r.status === 200,
  });

  const parsed = parseSse(body);
  check(body, {
    "fallback path recorded": (b) =>
      b.includes("groq") || b.includes("openrouter") || b.includes("fallback"),
  });

  if (parsed.sawFallback) {
    fallbacks.add(1);
  }

  sleep(2);
}
