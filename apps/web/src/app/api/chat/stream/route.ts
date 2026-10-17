import { ModelRouter, type Provider, type RouteMode } from "@/lib/router/router";
import { callProvider } from "@/lib/llm/provider-registry";
import { persistMessage } from "@/lib/llm/persist-message";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem } from "@/lib/api/problem";
import { getPrompt, isMode, type Mode } from "@/lib/prompts";
import { wrapUserContent, sanitizeModelOutput } from "@/lib/prompts/injection-defense";
import { getConversation, getMessages } from "@/lib/chat/queries";
import { ThrottledStreamBuffer } from "@/lib/stream/buffer";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";
import { z } from "zod";

const redis = Redis.fromEnv();
const STREAM_TTL_SECONDS = 300;
const IDEMPOTENCY_TTL_SECONDS = 60;

/**
 * NOTE: this route runs on the Node.js runtime, NOT edge.
 *
 * Edge runtime doesn't support:
 *   - drizzle-orm/postgres-js (needs the postgres-js driver)
 *   - @upstash/redis when using REST fallback
 *   - crypto.subtle timing-safe comparison helpers
 *
 * The streaming response itself is still chunked; the only trade-off is
 * slightly higher cold-start latency vs. edge (mitigated by Vercel's
 * warm-instance reuse).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // matches Vercel Pro plan max for streaming

const Body = z.object({
  conversationId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(32_000),
  idempotencyKey: z.string().min(8).max(128),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en"),
  mode: z
    .enum(["chat", "write", "rewrite", "summarize", "translate", "code", "image", "document", "plan"])
    .default("chat"),
  needsVision: z.boolean().optional(),
  userOverride: z.string().optional(),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export async function POST(req: NextRequest) {
  // Rate-limit first (by user if authenticated, by IP if anonymous).
  // Tier: "chat" = 20 req/min per user — strict because each call costs money.
  const denied = await guard(req, "chat");
  if (denied) return denied;

  // Auth — anonymous streaming is not allowed.
  let user;
  try {
    user = await requireUser();
  } catch {
    return problem(401, "unauthenticated");
  }

  // Extract the request ID for traceability — threads through to message_meta.
  const requestId =
    req.headers.get("x-request-id") ??
    req.headers.get("x-trace-id") ??
    crypto.randomUUID();

  // Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }
  const { conversationId, parentId, content, idempotencyKey, language, mode, needsVision, userOverride } =
    parsed.data;

  // Idempotency: same key = same response (dedupe).
  // Value stored is the message id, so the client can fetch the existing message.
  const existing = await redis.get<string>(`idem:${idempotencyKey}`);
  if (existing) {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(sseEncode("idempotent", { messageId: existing }));
          controller.enqueue(sseEncode("done", {}));
          controller.close();
        },
      }),
      { headers: streamHeaders() },
    );
  }

  // Claim the idempotency key BEFORE we start — prevents concurrent
  // duplicates from racing past the GET check.
  const claim = await redis.set(`idem:${idempotencyKey}`, "in-flight", {
    ex: IDEMPOTENCY_TTL_SECONDS,
    nx: true, // only set if not exists
  });
  if (!claim) {
    // Another request is in flight with the same key — tell the client
    // to retry / deduplicate on their end.
    return problem(409, "duplicate_in_flight");
  }

  const router = new ModelRouter();
  const streamId = crypto.randomUUID();
  const fallbackPath: string[] = [];
  let firstTokenMs: number | null = null;
  let totalOutputTokens = 0;

  // Load the conversation to verify access + get the actual mode/language.
  let conversation;
  try {
    conversation = await getConversation(conversationId, user.id);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "conversation_load_failed");
  }

  // Use the conversation's mode if the body didn't specify one, or if
  // the body's mode doesn't match (the conversation's mode is canonical).
  const effectiveMode: Mode = isMode(conversation.mode)
    ? conversation.mode
    : isMode(mode)
      ? mode
      : "chat";
  const effectiveLanguage =
    conversation.languagePref ?? language ?? "en";

  // Build the system prompt from the versioned prompt library.
  const { system, version: promptVersion } = getPrompt(effectiveMode, effectiveLanguage);

  // Load recent conversation history so the LLM has context.
  // We cap at 50 messages (most recent) to stay within token budgets.
  const history = await getMessages(conversationId, 50);
  const historyMessages = history
    .filter((m) => m.role !== "system" && m.status === "completed")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // Persist the user message first (so it's visible in the conversation
  // history immediately, even if the assistant stream fails).
  await persistMessage({
    conversationId,
    parentId: parentId ?? null,
    role: "user",
    content,
    provider: "user",
    model: "user",
    status: "completed",
    firstTokenMs: null,
    totalMs: 0,
    fallbackPath: [],
    idempotencyKey: undefined,
  });

  // Abort controller so client disconnect cancels the provider call.
  const clientAbort = new AbortController();
  const release = new AbortController(); // used to signal the stream is done

  // Throttled Redis buffer — coalesces per-delta writes into ~1 write per 250ms
  // (or when 1KB accumulates). Cuts Redis write volume ~10× vs. per-token writes.
  const buffer = new ThrottledStreamBuffer(streamId, redis);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      // Listen for client disconnect.
      req.signal.addEventListener("abort", () => {
        clientAbort.abort();
        release.abort();
      });

      // Build the routing request.
      const routeResult = router.route({
        mode: mode as RouteMode,
        needsVision,
        userOverride,
        language,
      });

      // Build the list of providers to try — primary first, then fallbacks.
      const providersToTry: Provider[] = [routeResult.provider];
      for (const p of router.knownProviders) {
        if (p !== routeResult.provider) providersToTry.push(p);
      }

      let accumulated = "";
      let lastProvider: Provider | null = null;

      for (const provider of providersToTry) {
        // Skip providers whose circuit breaker is open. The router's `route()`
        // already does this for the primary pick, but we re-check here for
        // fallback candidates (which may have tripped since the route call).
        if (router.getHealthSnapshot(provider).circuitOpen) continue;
        const started = Date.now();
        try {
          const providerStream = await callProvider(provider, {
            system,
            messages: [
              ...historyMessages.map((m) => ({
                role: m.role,
                // Wrap historical user messages too so the model treats
                // prior turns as data, not as instructions in context.
                content: m.role === "user" ? wrapUserContent(m.content) : m.content,
              })),
              { role: "user" as const, content: wrapUserContent(content) },
            ],
            language: effectiveLanguage,
            conversationId,
            signal: clientAbort.signal,
          });

          for await (const chunk of providerStream) {
            if (release.signal.aborted) break;

            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - started;
            }
            accumulated += chunk.text;
            totalOutputTokens++;

            // Throttled buffer — coalesces writes to Redis.
            // The buffer flushes every 250ms or when 1KB accumulates,
            // so we don't write per-token (which would be ~10× more writes).
            void buffer.append(chunk.text);

            controller.enqueue(sseEncode("delta", { streamId, text: chunk.text }));
          }

          if (release.signal.aborted) {
            // Client disconnected — save what we have as 'aborted'.
            const messageId = await persistMessage({
              conversationId,
              parentId: parentId ?? null,
              role: "assistant",
              content: sanitizeModelOutput(accumulated),
              provider,
              model: routeResult.model,
              status: "aborted",
              firstTokenMs,
              totalMs: Date.now() - started,
              fallbackPath,
              idempotencyKey,
              promptVersion,
              requestId,
              outputTokens: totalOutputTokens,
            });
            await redis.set(`idem:${idempotencyKey}`, messageId, {
              ex: IDEMPOTENCY_TTL_SECONDS,
            });
            await buffer.destroy().catch(() => {});
            cleanup();
            return;
          }

          // Successful completion.
          const messageId = await persistMessage({
            conversationId,
            parentId: parentId ?? null,
            role: "assistant",
            content: sanitizeModelOutput(accumulated),
            provider,
            model: routeResult.model,
            status: "completed",
            firstTokenMs,
            totalMs: Date.now() - started,
            fallbackPath,
            idempotencyKey,
            promptVersion,
            requestId,
            outputTokens: totalOutputTokens,
          });
          await redis.set(`idem:${idempotencyKey}`, messageId, {
            ex: IDEMPOTENCY_TTL_SECONDS,
          });
          controller.enqueue(sseEncode("done", { messageId, provider, fallbackPath }));
          // Final flush of the throttled buffer before closing the stream.
          await buffer.destroy().catch(() => {});
          cleanup();
          router.onResult(provider, firstTokenMs, false);
          return;
        } catch (err) {
          router.onResult(provider, firstTokenMs, true);
          fallbackPath.push(provider);
          lastProvider = provider;

          // Partial content from this provider — don't lose it.
          if (accumulated.length > 0) {
            await persistMessage({
              conversationId,
              parentId: parentId ?? null,
              role: "assistant",
              content: sanitizeModelOutput(accumulated),
              provider,
              model: routeResult.model,
              status: "error",
              firstTokenMs,
              totalMs: Date.now() - started,
              fallbackPath,
              idempotencyKey,
              promptVersion,
              requestId,
              outputTokens: totalOutputTokens,
            });
            controller.enqueue(
              sseEncode("error", {
                partial: true,
                content: sanitizeModelOutput(accumulated),
                provider,
                fallbackPath,
                message: err instanceof Error ? err.message : "unknown",
              }),
            );
            await buffer.destroy().catch(() => {});
            cleanup();
            return;
          }

          // No content yet — try the next provider.
          controller.enqueue(
            sseEncode("fallback", {
              from: provider,
              to: "next",
              reason: err instanceof Error ? err.message : "unknown",
            }),
          );
          // Don't reset firstTokenMs — we want to track the very first
          // token across the whole request lifecycle for latency metrics.
          continue;
        }
      }

      // All providers failed.
      await persistMessage({
        conversationId,
        parentId: parentId ?? null,
        role: "assistant",
        content: accumulated,
        provider: lastProvider ?? "none",
        model: "none",
        status: "error",
        firstTokenMs,
        totalMs: 0,
        fallbackPath,
        idempotencyKey,
        promptVersion,
        requestId,
        outputTokens: totalOutputTokens,
      });
      await redis.set(`idem:${idempotencyKey}`, "error", {
        ex: IDEMPOTENCY_TTL_SECONDS,
      });
      controller.enqueue(
        sseEncode("error", {
          allProvidersFailed: true,
          fallbackPath,
        }),
      );
      await buffer.destroy().catch(() => {});
      cleanup();
    },
    async cancel() {
      // Client disconnected — propagate to provider call.
      clientAbort.abort();
      release.abort();
      // Flush any pending buffer content so the client can resume.
      await buffer.destroy().catch(() => {});
    },
  });

  // GET response — no requestId on resume (the streamId IS the correlation key).
  return new Response(stream, { headers: streamHeaders() });
}

/**
 * GET /api/chat/stream?streamId=...
 *
 * Resumes a previously-started stream by replaying the accumulated content
 * from Redis. Returns a `resume` event with the full buffer; the client
 * then optionally reconnects to the live stream if it's still in flight.
 *
 * If the buffer has expired (TTL > 5 min), returns an `expired` event.
 */
export async function GET(req: Request) {
  const streamId = new URL(req.url).searchParams.get("streamId");
  if (!streamId) {
    return problem(400, "missing_stream_id");
  }

  // Validate format — must be a UUID.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(streamId)) {
    return problem(400, "invalid_stream_id");
  }

  const accumulated = await redis.get<string>(`stream:${streamId}`);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (accumulated) {
        controller.enqueue(sseEncode("resume", { streamId, text: accumulated }));
      } else {
        controller.enqueue(sseEncode("expired", { streamId }));
      }
      controller.enqueue(sseEncode("done", {}));
      controller.close();
    },
  });

  // GET response — no requestId on resume (the streamId IS the correlation key).
  return new Response(stream, { headers: streamHeaders() });
}

function streamHeaders(requestId?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering
  };
  if (requestId) {
    // Echo the request ID so clients can include it in support tickets.
    headers["X-Request-Id"] = requestId;
  }
  return headers;
}
