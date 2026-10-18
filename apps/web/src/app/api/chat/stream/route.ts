import { ModelRouter, type Provider, type RouteMode } from "@/lib/router/router";
import { callProvider, isProviderConfigured } from "@/lib/llm/provider-registry";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  conversationId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  clientMessageId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(32_000),
  idempotencyKey: z.string().min(8).max(128),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en"),
  mode: z.enum(["chat", "write", "rewrite", "summarize", "translate", "code", "image", "document", "plan"]).default("chat"),
  needsVision: z.boolean().optional(),
  userOverride: z.enum(["gemini", "groq", "openrouter"]).optional(),
});

type FailureDetail = { provider: Provider; reason: string };

const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
};

const PROVIDER_MODEL: Record<Provider, string> = {
  gemini: "gemini-3.8-flash",
  groq: "openai/gpt-oss-120b",
  openrouter: "openrouter/auto",
};

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function headers(requestId?: string): HeadersInit {
  const result: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (requestId) result["X-Request-Id"] = requestId;
  return result;
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/API_KEY.*not set|key.*missing|missing.*api.?key/i.test(message)) {
    return "API key is not configured";
  }
  if (/\b(401|403)\b|unauthorized|invalid api key|permission denied/i.test(message)) {
    return "API key or provider permissions were rejected";
  }
  if (/\b429\b|quota|rate.?limit|resource_exhausted/i.test(message)) {
    return "Provider quota or rate limit was reached";
  }
  if (/\b404\b|model.*not found|not supported/i.test(message)) {
    return "Configured model or endpoint is unavailable";
  }
  if (/\b5\d\d\b|overloaded|temporarily unavailable/i.test(message)) {
    return "Provider is temporarily unavailable";
  }
  if (/timeout|timed out|fetch failed|ECONN|ENOTFOUND|network/i.test(message)) {
    return "Connection to the provider failed";
  }
  if (/empty_provider_response/i.test(message)) {
    return "Provider returned an empty response";
  }
  return "Provider request failed";
}

export async function POST(req: NextRequest) {
  const denied = await guard(req, "chat");
  if (denied) return denied;

  let user;
  try {
    user = await requireUser();
  } catch {
    return problem(401, "unauthenticated", "Please sign in again to continue chatting.");
  }

  const requestId = req.headers.get("x-request-id") ?? req.headers.get("x-trace-id") ?? crypto.randomUUID();

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return problem(400, "invalid_json", "Your message could not be read. Please try again.");
  }

  const parsed = Body.safeParse(rawBody);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message ?? "Please check your message and try again.");
  }

  const {
    conversationId,
    parentId,
    clientMessageId,
    content,
    idempotencyKey,
    language,
    mode,
    needsVision,
    userOverride,
  } = parsed.data;

  let conversation;
  try {
    conversation = await getConversation(conversationId, user.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "not_found") return problem(404, "conversation_not_found", "This conversation no longer exists.");
    if (code === "forbidden") return problem(403, "forbidden", "You don't have access to this conversation.");
    console.error("[chat] conversation_load_failed", { requestId, error });
    return problem(503, "conversation_load_failed", "Supa AI couldn't open this conversation. Please retry.");
  }

  // Idempotency cache errors should be visible and actionable, never swallowed.
  // Old "error" sentinels are cleared so the user can retry a failed generation.
  let existing: string | null = null;
  try {
    existing = await redis.get<string>(`idem:${idempotencyKey}`);
    if (existing === "error") {
      await redis.del(`idem:${idempotencyKey}`);
      existing = null;
    }
  } catch (error) {
    console.error("[chat] redis_idempotency_read_failed", { requestId, error });
    return problem(503, "chat_cache_unavailable", "Supa AI is temporarily unavailable. Please try again in a moment.");
  }

  if (existing === "in-flight") {
    return problem(409, "duplicate_in_flight", "This message is already being processed. Please wait a moment.");
  }

  if (existing) {
    try {
      const messages = await getMessages(conversationId, 100);
      const saved = messages.find((item) => item.id === existing);
      if (saved) {
        const replay = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sseEncode("status", { phase: "writing", message: "Loading your saved reply…" }));
            if (saved.content) controller.enqueue(sseEncode("delta", { text: saved.content, replay: true }));
            controller.enqueue(sseEncode("done", { messageId: saved.id, provider: "saved", fallbackPath: [] }));
            controller.close();
          },
        });
        return new Response(replay, { headers: headers(requestId) });
      }
      await redis.del(`idem:${idempotencyKey}`);
    } catch (error) {
      console.error("[chat] idempotency_replay_failed", { requestId, error });
      return problem(503, "chat_replay_unavailable", "Supa AI couldn't resume the previous response. Please try again.");
    }
  }

  let claimed: string | null = null;
  try {
    claimed = await redis.set(`idem:${idempotencyKey}`, "in-flight", {
      ex: IDEMPOTENCY_TTL_SECONDS,
      nx: true,
    });
  } catch (error) {
    console.error("[chat] redis_idempotency_claim_failed", { requestId, error });
    return problem(503, "chat_cache_unavailable", "Supa AI is temporarily unavailable. Please try again in a moment.");
  }
  if (!claimed) {
    return problem(409, "duplicate_in_flight", "This message is already being processed. Please wait a moment.");
  }

  const effectiveMode: Mode = isMode(conversation.mode) ? conversation.mode : mode;
  const effectiveLanguage = conversation.languagePref ?? language ?? "en";
  const { system, version: promptVersion } = getPrompt(effectiveMode, effectiveLanguage);

  let history: Awaited<ReturnType<typeof getMessages>>;
  try {
    history = await getMessages(conversationId, 50);
  } catch (error) {
    console.error("[chat] history_load_failed", { requestId, error });
    await redis.del(`idem:${idempotencyKey}`).catch(() => {});
    return problem(503, "history_load_failed", "Supa AI couldn't load this conversation's history. Please retry.");
  }
  const historyMessages = history
    .filter((message) => message.role !== "system" && message.status === "completed")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.role === "user" ? wrapUserContent(message.content) : message.content,
    }));

  let userMessageId: string;
  try {
    userMessageId = await persistMessage({
      conversationId,
      parentId: parentId ?? null,
      messageId: clientMessageId,
      role: "user",
      content,
      provider: "user",
      model: "user",
      status: "completed",
      firstTokenMs: null,
      totalMs: 0,
      fallbackPath: [],
    });
  } catch (error) {
    console.error("[chat] user_message_save_failed", { requestId, error });
    await redis.del(`idem:${idempotencyKey}`).catch(() => {});
    return problem(503, "message_save_failed", "Your message couldn't be saved. Please try again.");
  }

  const router = new ModelRouter();
  const routeResult = router.route({
    mode: effectiveMode as RouteMode,
    needsVision,
    userOverride,
    language: effectiveLanguage,
  });
  // Only attempt providers that have an API key configured in this deployment.
  const configuredProviders = router.knownProviders.filter(isProviderConfigured);
  const preferredProvider = configuredProviders.includes(routeResult.provider)
    ? routeResult.provider
    : configuredProviders[0];
  const providers: Provider[] = preferredProvider
    ? [preferredProvider, ...configuredProviders.filter((item) => item !== preferredProvider)]
    : [];
  const unconfiguredProviders = router.knownProviders.filter((item) => !isProviderConfigured(item));
  const streamId = crypto.randomUUID();
  // Replay buffers are private to the user who started the request.
  await redis.set(`stream-owner:${streamId}`, user.id, { ex: STREAM_TTL_SECONDS }).catch((error) => {
    console.warn("[chat] stream_owner_persist_failed", { requestId, error });
  });
  const fallbackPath: Provider[] = [];
  const failures: FailureDetail[] = unconfiguredProviders.map((provider) => ({
    provider,
    reason: "API key is not configured",
  }));
  const clientAbort = new AbortController();
  const release = new AbortController();
  const buffer = new ThrottledStreamBuffer(streamId, redis, { intervalMs: 250, sizeThresholdBytes: 1024, ttlSeconds: STREAM_TTL_SECONDS });

  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let accumulated = "";
      let firstTokenMs: number | null = null;
      let selectedProvider: Provider | null = null;
      let providerStartedAt = Date.now();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event, data));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The client may have disconnected or the stream may already be closed.
        }
      };
      const releaseRequest = () => {
        req.signal.removeEventListener("abort", onRequestAbort);
      };
      const onRequestAbort = () => {
        clientAbort.abort();
        release.abort();
      };
      req.signal.addEventListener("abort", onRequestAbort, { once: true });

      send("status", {
        phase: "thinking",
        message: "Supa AI is thinking through your request…",
      });

      try {
        for (const provider of providers) {
          if (release.signal.aborted) break;
          if (router.getHealthSnapshot(provider).circuitOpen) {
            failures.push({ provider, reason: "Provider is temporarily paused after recent failures" });
            continue;
          }

          providerStartedAt = Date.now();
          accumulated = "";
          send("status", {
            phase: "thinking",
            message: `Supa AI is preparing an answer with ${PROVIDER_LABEL[provider]}…`,
            provider,
          });

          try {
            const providerStream = await callProvider(provider, {
              system,
              messages: [
                ...historyMessages,
                { role: "user" as const, content: wrapUserContent(content) },
              ],
              language: effectiveLanguage,
              conversationId,
              signal: clientAbort.signal,
            });

            for await (const chunk of providerStream) {
              if (release.signal.aborted) break;
              if (!chunk.text) continue;

              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - providerStartedAt;
                send("status", {
                  phase: "writing",
                  message: "Supa AI is writing your response…",
                  provider,
                });
              }

              accumulated += chunk.text;
              buffer.append(chunk.text);
              send("delta", { streamId, text: chunk.text, provider });
            }

            if (release.signal.aborted) {
              const partial = sanitizeModelOutput(accumulated);
              if (partial) {
                try {
                  await persistMessage({
                    conversationId,
                    parentId: userMessageId,
                    role: "assistant",
                    content: partial,
                    provider,
                    model: PROVIDER_MODEL[provider],
                    status: "aborted",
                    firstTokenMs,
                    totalMs: Date.now() - providerStartedAt,
                    fallbackPath: [...fallbackPath],
                    promptVersion,
                    requestId,
                    outputTokens: Math.ceil(partial.length / 4),
                  });
                } catch (error) {
                  console.error("[chat] aborted_message_save_failed", { requestId, error });
                }
              }
              send("done", { status: "aborted", provider });
              await buffer.destroy();
              close();
              return;
            }

            if (!accumulated.trim()) {
              throw new Error("empty_provider_response");
            }

            selectedProvider = provider;
            router.onResult(provider, firstTokenMs, false);
            break;
          } catch (error) {
            if (release.signal.aborted || clientAbort.signal.aborted) {
              throw error;
            }

            const reason = safeFailureReason(error);
            failures.push({ provider, reason });
            fallbackPath.push(provider);
            router.onResult(provider, firstTokenMs, true);
            console.warn("[chat] provider_attempt_failed", {
              requestId,
              provider,
              reason,
              error: error instanceof Error ? error.message : String(error),
            });

            // Once a model has emitted text, do not splice a second model's
            // answer into it. Preserve the partial answer and explain clearly.
            if (accumulated.trim()) {
              const partial = sanitizeModelOutput(accumulated);
              try {
                await persistMessage({
                  conversationId,
                  parentId: userMessageId,
                  role: "assistant",
                  content: partial,
                  provider,
                  model: PROVIDER_MODEL[provider],
                  status: "error",
                  firstTokenMs,
                  totalMs: Date.now() - providerStartedAt,
                  fallbackPath: [...fallbackPath],
                  idempotencyKey,
                  promptVersion,
                  requestId,
                  outputTokens: Math.ceil(partial.length / 4),
                });
              } catch (persistError) {
                console.error("[chat] partial_response_save_failed", { requestId, persistError });
              }
              send("error", {
                partial: true,
                content: partial,
                message: "Supa AI's connection ended before the response was complete. The text above is the partial answer.",
                reason,
                provider,
                fallbackPath,
              });
              await buffer.destroy();
              close();
              return;
            }

            const nextAvailable = providers.some((candidate) =>
              candidate !== provider && !fallbackPath.includes(candidate) && !router.getHealthSnapshot(candidate).circuitOpen,
            );
            send("fallback", {
              from: provider,
              reason,
              message: nextAvailable
                ? `${PROVIDER_LABEL[provider]} couldn't respond (${reason.toLowerCase()}). Trying another AI provider…`
                : `${PROVIDER_LABEL[provider]} couldn't respond (${reason.toLowerCase()}). No other provider is available.`,
              fallbackPath,
            });
          }
        }

        if (release.signal.aborted) {
          await buffer.destroy();
          close();
          return;
        }

        if (!selectedProvider) {
          try {
            await persistMessage({
              conversationId,
              parentId: userMessageId,
              role: "assistant",
              content: "",
              provider: failures[failures.length - 1]?.provider ?? "none",
              model: failures.length ? PROVIDER_MODEL[failures[failures.length - 1]!.provider] : "none",
              status: "error",
              firstTokenMs,
              totalMs: 0,
              fallbackPath: [...fallbackPath],
              idempotencyKey,
              promptVersion,
              requestId,
            });
          } catch (error) {
            console.error("[chat] failed_response_record_failed", { requestId, error });
          }

          await redis.set(`idem:${idempotencyKey}`, "error", { ex: IDEMPOTENCY_TTL_SECONDS }).catch((error) => {
            console.warn("[chat] idempotency_error_mark_failed", { requestId, error });
          });
          send("error", {
            allProvidersFailed: true,
            message: "Supa AI couldn't get a response from the configured AI providers.",
            reason: failures,
            fallbackPath,
            nextStep: "Check the provider API keys, quotas, and model access in your deployment settings.",
          });
          await buffer.destroy();
          close();
          return;
        }

        const finalContent = sanitizeModelOutput(accumulated);
        let messageId: string;
        try {
          messageId = await persistMessage({
            conversationId,
            parentId: userMessageId,
            role: "assistant",
            content: finalContent,
            provider: selectedProvider,
            model: PROVIDER_MODEL[selectedProvider],
            status: "completed",
            firstTokenMs,
            totalMs: Date.now() - providerStartedAt,
            fallbackPath: [...fallbackPath],
            idempotencyKey,
            promptVersion,
            requestId,
            outputTokens: Math.ceil(finalContent.length / 4),
          });
        } catch (error) {
          console.error("[chat] completed_response_save_failed", {
            requestId,
            provider: selectedProvider,
            error,
          });
          send("error", {
            partial: true,
            content: finalContent,
            message: "Supa AI generated your response, but couldn't save it to conversation history.",
            reason: "The response is visible above. Copy it before leaving this page, then retry if needed.",
            provider: selectedProvider,
            fallbackPath,
          });
          await buffer.destroy();
          close();
          return;
        }

        await redis.set(`idem:${idempotencyKey}`, messageId, { ex: IDEMPOTENCY_TTL_SECONDS }).catch((error) => {
          console.warn("[chat] idempotency_save_failed", { requestId, error });
        });
        send("done", {
          messageId,
          provider: selectedProvider,
          model: PROVIDER_MODEL[selectedProvider],
          fallbackPath,
        });
        await buffer.destroy();
        close();
      } catch (error) {
        console.error("[chat] stream_unhandled_failure", { requestId, error });
        send("error", {
          message: "Supa AI couldn't finish this response.",
          reason: "A chat service error interrupted this request. Please try again.",
          requestId,
        });
        await buffer.destroy().catch(() => {});
        close();
      } finally {
        releaseRequest();
      }
    },
    async cancel() {
      clientAbort.abort();
      release.abort();
      await buffer.destroy().catch(() => {});
    },
  });

  return new Response(responseStream, { headers: headers(requestId) });
}

export async function GET(req: Request) {
  const streamId = new URL(req.url).searchParams.get("streamId");
  if (!streamId) return problem(400, "missing_stream_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(streamId)) {
    return problem(400, "invalid_stream_id");
  }

  let user;
  try {
    user = await requireUser();
  } catch {
    return problem(401, "unauthenticated", "Please sign in to resume this response.");
  }

  try {
    const owner = await redis.get<string>(`stream-owner:${streamId}`);
    if (!owner) {
      return problem(410, "stream_expired", "This response can no longer be resumed. Please start a new message.");
    }
    if (owner !== user.id) {
      return problem(403, "forbidden", "You don't have access to this response.");
    }

    const accumulated = await redis.get<string>(`stream:${streamId}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (accumulated) controller.enqueue(sseEncode("resume", { streamId, text: accumulated }));
        else controller.enqueue(sseEncode("expired", { streamId }));
        controller.enqueue(sseEncode("done", {}));
        controller.close();
      },
    });
    return new Response(stream, { headers: headers() });
  } catch (error) {
    console.error("[chat] stream_resume_failed", { streamId, error });
    return problem(503, "stream_resume_failed", "Supa AI couldn't resume this response. Please retry.");
  }
}
