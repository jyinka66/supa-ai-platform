import { ModelRouter, type Provider, type RouteMode } from "@/lib/router/router";
import { callProvider } from "@/lib/llm/provider-registry";
import { persistMessage } from "@/lib/llm/persist-message";
import { getPrompt, isMode, type Mode } from "@/lib/prompts";
import { wrapUserContent, sanitizeModelOutput } from "@/lib/prompts/injection-defense";
import { detectLanguage } from "@/lib/i18n/detect";
import { checkBudget } from "@/lib/cost/accounting";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { getConversation, getMessages } from "@/lib/chat/queries";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";
import { z } from "zod";

const redis = Redis.fromEnv();
const IDEMPOTENCY_TTL_SECONDS = 120; // 2 minutes — non-streaming responses are cacheable

/**
 * NOTE: this route runs on Node.js runtime, NOT edge — same reasons as
 * /api/chat/stream (Drizzle + Upstash REST need Node APIs).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  conversationId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(32_000),
  idempotencyKey: z.string().min(8).max(128),
  mode: z
    .enum(["chat", "write", "rewrite", "summarize", "translate", "code", "image", "document", "plan"])
    .default("chat"),
  userOverride: z.string().optional(),
});

interface CompleteResponse {
  messageId: string;
  content: string;
  language: string;
  provider: Provider;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  fallbackPath: string[];
}

export async function POST(req: NextRequest) {
  // 0. Rate-limit first (tier: "chat" = 20 req/min per user).
  const denied = await guard(req, "chat");
  if (denied) return denied;

  // 1. Auth.
  let user;
  try {
    user = await requireUser();
  } catch {
    return problem(401, "unauthenticated");
  }

  // 2. Parse + validate body.
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
  const { conversationId, parentId, content, idempotencyKey, mode, userOverride } = parsed.data;

  // 3. Idempotency — same key returns cached final response.
  const cached = await redis.get<CompleteResponse>(`idem-final:${idempotencyKey}`);
  if (cached) {
    return ok(cached);
  }

  // 4. Claim the idempotency key (prevents concurrent duplicates).
  const claim = await redis.set(`idem-final:${idempotencyKey}`, "in-flight", {
    ex: IDEMPOTENCY_TTL_SECONDS,
    nx: true,
  });
  if (!claim) {
    return problem(409, "duplicate_in_flight");
  }

  // 5. Load the conversation (verifies access + gets canonical mode/language).
  let conversation;
  try {
    conversation = await getConversation(conversationId, user.id);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "conversation_load_failed");
  }

  // 6. Resolve mode + language.
  const effectiveMode: Mode = isMode(conversation.mode)
    ? conversation.mode
    : isMode(mode)
      ? mode
      : "chat";
  const detectedLanguage = detectLanguage(content);
  const effectiveLanguage = conversation.languagePref ?? detectedLanguage;

  // 7. Build the system prompt (with injection-defense suffix auto-applied).
  const { system, version: promptVersion } = getPrompt(effectiveMode, effectiveLanguage);

  // 8. Pre-estimate cost for budget check.
  // Rough heuristic: 4 chars per input token, ~500 output tokens for a typical response.
  const estimatedInputTokens = Math.ceil(content.length / 4);
  const estimatedOutputTokens = 500;
  const estimatedCostUsd = 0.05; // conservative upper bound across providers
  const budget = await checkBudget(user.id, conversation.workspaceId, estimatedCostUsd);
  if (!budget.allowed) {
    return problem(402, "budget_exceeded", undefined, { reason: budget.reason });
  }

  // 9. Load conversation history.
  const history = await getMessages(conversationId, 50);
  const historyMessages = history
    .filter((m) => m.role !== "system" && m.status === "completed")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.role === "user" ? wrapUserContent(m.content) : m.content,
    }));

  // 10. Persist the user message first.
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

  // 11. Route + iterate providers.
  const router = new ModelRouter();
  const routeResult = router.route({
    mode: effectiveMode as RouteMode,
    userOverride,
    language: effectiveLanguage,
  });
  const providersToTry: Provider[] = [routeResult.provider];
  for (const p of router.knownProviders) {
    if (p !== routeResult.provider) providersToTry.push(p);
  }

  const fallbackPath: string[] = [];
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let lastError: unknown = null;

  for (const provider of providersToTry) {
    if (router.getHealthSnapshot(provider).circuitOpen) continue;
    const providerStart = Date.now();
    try {
      const providerStream = await callProvider(provider, {
        system,
        messages: [...historyMessages, { role: "user", content: wrapUserContent(content) }],
        language: effectiveLanguage,
        conversationId,
      });

      const chunks: string[] = [];
      for await (const chunk of providerStream) {
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - providerStart;
        }
        chunks.push(chunk.text);
      }

      const full = sanitizeModelOutput(chunks.join(""));
      const inputTokens = Math.ceil(content.length / 4);
      const outputTokens = Math.ceil(full.length / 4);
      const costUsd = estimateCost(provider, inputTokens, outputTokens);

      // 12. Persist the assistant message (message_meta is written in the
      // same transaction by persistMessage — no separate recordCost call).
      const messageId = await persistMessage({
        conversationId,
        parentId: parentId ?? null,
        role: "assistant",
        content: full,
        provider,
        model: routeResult.model,
        status: "completed",
        firstTokenMs,
        totalMs: Date.now() - started,
        fallbackPath,
        idempotencyKey,
        promptVersion,
        inputTokens,
        outputTokens,
        costUsd,
      });

      router.onResult(provider, firstTokenMs, false);

      // 13. Cache the complete response for idempotency.
      const payload: CompleteResponse = {
        messageId,
        content: full,
        language: effectiveLanguage,
        provider,
        model: routeResult.model,
        usage: { inputTokens, outputTokens, costUsd },
        fallbackPath,
      };
      await redis.set(`idem-final:${idempotencyKey}`, payload, {
        ex: IDEMPOTENCY_TTL_SECONDS,
      });

      return ok(payload);
    } catch (err) {
      lastError = err;
      router.onResult(provider, firstTokenMs, true);
      fallbackPath.push(provider);
      // Try the next provider.
    }
  }

  // 14. All providers failed — record an error message and return 503.
  await persistMessage({
    conversationId,
    parentId: parentId ?? null,
    role: "assistant",
    content: "",
    provider: "none",
    model: "none",
    status: "error",
    firstTokenMs,
    totalMs: Date.now() - started,
    fallbackPath,
    idempotencyKey,
    promptVersion,
  });

  await redis.set(`idem-final:${idempotencyKey}`, "error", {
    ex: IDEMPOTENCY_TTL_SECONDS,
  });

  return problem(
    503,
    "all_providers_failed",
    undefined,
    {
      fallbackPath,
      lastError: lastError instanceof Error ? lastError.message : "unknown",
    },
  );
}

/**
 * Estimates cost for a provider based on input/output token counts.
 * Uses the same pricing as the router CATALOG.
 *
 * NOTE: this is a rough estimate for budget pre-checks. The actual cost
 * is recorded by `persistMessage` via the `costUsd` field on `messageMeta`.
 */
function estimateCost(provider: Provider, inputTokens: number, outputTokens: number): number {
  const pricing: Record<Provider, { inputPer1M: number; outputPer1M: number }> = {
    gemini: { inputPer1M: 0.075, outputPer1M: 0.3 },
    groq: { inputPer1M: 0.59, outputPer1M: 0.79 },
    openrouter: { inputPer1M: 0.5, outputPer1M: 1.5 },
  };
  const p = pricing[provider];
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}
