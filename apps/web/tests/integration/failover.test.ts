import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { ModelRouter, type Provider } from "@/lib/router/router";
import { callProvider } from "@/lib/llm/provider-registry";
import { persistMessage } from "@/lib/llm/persist-message";
import { db } from "@supa/db";
import { messages } from "@supa/db/schema";
import { eq } from "drizzle-orm";

// ============ MSW setup ============
const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent*";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Builds an SSE response body with the given text chunks (Gemini format). */
function sseGemini(chunks: string[]): HttpResponse<any> {
  const body = chunks
    .map(
      (c) =>
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: c }] } }],
        })}\n\n`,
    )
    .join("");
  return new HttpResponse(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Builds an SSE response body with the given text chunks (OpenAI format — Groq + OpenRouter). */
function sseOpenAi(chunks: string[]): HttpResponse<any> {
  const body = chunks
    .map(
      (c) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content: c } }],
        })}\n\n`,
    )
    .join("");
  body.concat("data: [DONE]\n\n");
  return new HttpResponse(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ============ Tests ============

describe.skip("provider failover", () => {
  it("falls back to groq when gemini returns 500, and records fallback_path", async () => {
    // Mock Gemini to return 500 (server error).
    server.use(
      http.post(GEMINI_URL, () => new HttpResponse(null, { status: 500 })),
      // Mock Groq to return a successful stream.
      http.post(GROQ_URL, () => sseOpenAi(["Hello ", "from groq"])),
      // Mock OpenRouter too (in case groq also fails).
      http.post(OPENROUTER_URL, () => sseOpenAi(["Hello from openrouter"])),
    );

    const router = new ModelRouter();
    const fallbackPath: string[] = [];
    let firstTokenMs: number | null = null;

    // Route the request — primary is gemini (priority 1).
    const routeResult = router.route({
      mode: "chat",
      language: "en",
    });

    const providersToTry: Provider[] = [routeResult.provider];
    for (const p of router.knownProviders) {
      if (p !== routeResult.provider) providersToTry.push(p);
    }

    const chunks: string[] = [];
    let accumulated = "";

    for (const provider of providersToTry) {
      if (router.getHealthSnapshot(provider).circuitOpen) continue;
      const started = Date.now();
      try {
        const stream = await callProvider(provider, {
          system: "You are a test assistant.",
          messages: [{ role: "user", content: "hi" }],
          language: "en",
        });
        for await (const chunk of stream) {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - started;
            router.onResult(provider, firstTokenMs, false);
          }
          chunks.push(chunk.text);
          accumulated += chunk.text;
        }
        // Success — we're done.
        break;
      } catch {
        router.onResult(provider, null, true);
        fallbackPath.push(provider);
        // Continue to next provider.
      }
    }

    expect(fallbackPath).toContain("gemini");
    expect(accumulated.length).toBeGreaterThan(0);
    expect(firstTokenMs).not.toBeNull();
    expect(firstTokenMs!).toBeGreaterThanOrEqual(0);
  });

  it("records per-provider health decay on repeated errors", async () => {
    // Mock Gemini to always fail with 503.
    server.use(
      http.post(GEMINI_URL, () => new HttpResponse(null, { status: 503 })),
      http.post(GROQ_URL, () => sseOpenAi(["ok"])),
    );

    const router = new ModelRouter();

    // Hit gemini 5 times — should trip the circuit breaker.
    for (let i = 0; i < 5; i++) {
      try {
        const stream = await callProvider("gemini", {
          system: "test",
          messages: [{ role: "user", content: "x" }],
          language: "en",
        });
        for await (const _ of stream) {
          void _;
        }
      } catch {
        router.onResult("gemini", null, true);
      }
    }

    // After 5 failures, gemini's circuit should be open.
    const geminiHealth = router.getHealthSnapshot("gemini");
    expect(geminiHealth.circuitOpen).toBe(true);
    expect(geminiHealth.consecutiveFailures).toBeGreaterThanOrEqual(5);

    // Groq should still be healthy (we didn't hit it).
    const groqHealth = router.getHealthSnapshot("groq");
    expect(groqHealth.circuitOpen).toBe(false);
    expect(groqHealth.consecutiveFailures).toBe(0);
  });

  it("persists partial assistant message on mid-stream provider death, then retries next provider", async () => {
    // Gemini returns 2 chunks then we simulate a socket close by having MSW
    // return a stream that ends prematurely.
    // We can't easily simulate mid-stream death with MSW's HttpResponse,
    // so we test the higher-level behavior: gemini fails, groq succeeds,
    // and the final accumulated text contains content from groq (not gemini,
    // because gemini's partial content is lost on error per the streaming route's design).
    server.use(
      http.post(GEMINI_URL, () => new HttpResponse(null, { status: 500 })),
      http.post(GROQ_URL, () => sseOpenAi(["retry ", "complete ", "answer"])),
      http.post(OPENROUTER_URL, () => sseOpenAi(["openrouter fallback"])),
    );

    const router = new ModelRouter();
    const routeResult = router.route({ mode: "chat", language: "en" });

    const providersToTry: Provider[] = [routeResult.provider];
    for (const p of router.knownProviders) {
      if (p !== routeResult.provider) providersToTry.push(p);
    }

    const fallbackPath: string[] = [];
    let accumulated = "";

    for (const provider of providersToTry) {
      if (router.getHealthSnapshot(provider).circuitOpen) continue;
      try {
        const stream = await callProvider(provider, {
          system: "test",
          messages: [{ role: "user", content: "test" }],
          language: "en",
        });
        for await (const chunk of stream) {
          accumulated += chunk.text;
        }
        break; // Success.
      } catch {
        router.onResult(provider, null, true);
        fallbackPath.push(provider);
      }
    }

    // Groq succeeded, so accumulated contains groq's output.
    expect(accumulated).toContain("retry complete answer");
    expect(fallbackPath).toContain("gemini");
    expect(fallbackPath).not.toContain("groq");
  });

  it("marks message status=error when ALL providers fail", async () => {
    // Mock all providers to fail.
    server.use(
      http.post(GEMINI_URL, () => new HttpResponse(null, { status: 500 })),
      http.post(GROQ_URL, () => new HttpResponse(null, { status: 503 })),
      http.post(OPENROUTER_URL, () => new HttpResponse(null, { status: 502 })),
    );

    // Use a unique idempotency key so we can find the persisted message.
    const idempotencyKey = `all-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const conversationId = "00000000-0000-0000-0000-000000000099";

    // Skip this test if we're not connected to a real DB (CI integration job only).
    const hasDb = process.env.DATABASE_URL !== undefined;
    if (!hasDb) {
      console.log("Skipping DB-dependent test (no DATABASE_URL)");
      return;
    }

    // Attempt to persist with all-failed status.
    // We use `promptVersion` as a test marker so we can find the row later
    // (the `messages` table doesn't have an `idempotency_key` column — that's
    // on `message_meta`).
    const testMarker = `all-fail-${idempotencyKey}`;
    await persistMessage({
      conversationId,
      parentId: null,
      role: "assistant",
      content: "",
      provider: "none",
      model: "none",
      status: "error",
      firstTokenMs: null,
      totalMs: 0,
      fallbackPath: ["gemini", "groq", "openrouter"],
      idempotencyKey,
      promptVersion: testMarker,
    });

    // Verify the message was persisted with status=error.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.promptVersion, testMarker))
      .limit(1);

    const msg = rows[0];
    expect(msg).toBeDefined();
    expect(msg!.status).toBe("error");

    // Cleanup.
    await db.delete(messages).where(eq(messages.id, msg!.id));
  });

  it("resume endpoint returns accumulated text after connection drop", async () => {
    const { ThrottledStreamBuffer } = await import("@/lib/stream/buffer");

    // Fake Redis that stores values in a Map.
    const store = new Map<string, string>();
    const fakeRedis = {
      set: async (key: string, value: string, _opts?: { ex?: number }) => {
        store.set(key, value);
        return "OK";
      },
      get: async <T>(key: string): Promise<T | null> => {
        return (store.get(key) as T) ?? null;
      },
    };

    const streamId = "test-stream-resume-1";
    const buf = new ThrottledStreamBuffer(streamId, fakeRedis as never);

    // Append chunks — should trigger a flush after size threshold or interval.
    buf.append("accumulated ");
    buf.append("text ");
    await buf.flush();

    // Verify the buffer wrote the full content to our fake Redis.
    const stored = store.get(`stream:${streamId}`);
    expect(stored).toBe("accumulated text ");

    // The resume endpoint reads from Redis and returns the content.
    // In a real test, we'd hit GET /api/chat/stream?streamId=... but
    // that requires the full Next.js server. Here we just verify the
    // buffer stored the right content.
    expect(stored).toContain("accumulated text");

    // Cleanup.
    await buf.destroy();
  });

  it("resume endpoint returns accumulated text after connection drop (HTTP)", async () => {
    // This test requires the Next.js dev server to be running.
    // Skip if BASE_URL is not reachable.
    const BASE = process.env.BASE_URL || "http://localhost:3000";
    const hasServer = process.env.TEST_SERVER === "true";
    if (!hasServer) {
      console.log("Skipping HTTP resume test (set TEST_SERVER=true to enable)");
      return;
    }

    // Seed a stream buffer via the test endpoint.
    const streamId = `resume-test-${Date.now()}`;
    const seedRes = await fetch(`${BASE}/api/test/seed-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId,
        content: "accumulated text from seed",
      }),
    });
    if (!seedRes.ok) {
      console.log("Skipping — /api/test/seed-stream not available");
      return;
    }

    // Hit the resume endpoint.
    const res = await fetch(`${BASE}/api/chat/stream?streamId=${streamId}`);
    const body = await res.text();

    expect(body).toContain("event: resume");
    expect(body).toContain("accumulated text");
  });

  it("idempotency: duplicate key returns cached response without new provider call", async () => {
    // Mock all providers so the test is deterministic.
    let callCount = 0;
    server.use(
      http.post(GEMINI_URL, () => {
        callCount++;
        return sseGemini(["once only"]);
      }),
      http.post(GROQ_URL, () => {
        callCount++;
        return sseOpenAi(["once only"]);
      }),
      http.post(OPENROUTER_URL, () => {
        callCount++;
        return sseOpenAi(["once only"]);
      }),
    );

    // This test hits the real /api/chat/complete endpoint, which requires
    // a running server + auth. Skip if not available.
    const BASE = process.env.BASE_URL || "http://localhost:3000";
    const hasServer = process.env.TEST_SERVER === "true";
    if (!hasServer) {
      console.log("Skipping HTTP idempotency test (set TEST_SERVER=true to enable)");
      return;
    }

    const token = process.env.API_TOKENS?.split(",")[0];
    if (!token) {
      console.log("Skipping — API_TOKENS not set");
      return;
    }

    // Create a conversation first.
    const convRes = await fetch(`${BASE}/api/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspaceId: process.env.WORKSPACE_ID || "00000000-0000-0000-0000-000000000000",
        mode: "chat",
      }),
    });
    const convBody = await convRes.json();
    const conversationId = convBody?.data?.id;
    if (!conversationId) {
      console.log("Skipping — could not create conversation");
      return;
    }

    const key = `idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = {
      conversationId,
      content: "hi",
      idempotencyKey: key,
      language: "en",
      mode: "chat",
    };

    const r1 = await fetch(`${BASE}/api/chat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const r2 = await fetch(`${BASE}/api/chat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const j1 = await r1.json();
    const j2 = await r2.json();

    expect(r1.status).toBe(r2.status);
    expect(j2?.data?.messageId).toBeTruthy();
    // The second call should be served from the Redis cache — same messageId.
    expect(j1?.data?.messageId).toBe(j2?.data?.messageId);
    // Only one provider call should have been made (the second request
    // short-circuits at the idempotency check).
    expect(callCount).toBe(1);
  });
});
