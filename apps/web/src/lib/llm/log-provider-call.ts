import type { Provider } from "@/lib/router/router";
import { callProvider } from "@/lib/llm/provider-registry";
import type { ProviderStreamChunk } from "@/lib/llm/provider-registry";
import type { StreamRequest } from "@/lib/llm/types";
import { getCtx } from "@/lib/observability/context";
import { withSpan, getCurrentSpan } from "@/lib/observability/tracing";
import { circuitBreaker, CircuitOpenError } from "@/lib/reliability/circuit-breaker";
import {
  aiCallsTotal,
  aiCallDuration,
  aiFirstTokenDuration,
  aiCostTotal,
} from "@/lib/observability/metrics";
import { recordAiCost } from "@/lib/cost/tracker";

/**
 * Wraps a provider call with structured logging + OpenTelemetry tracing.
 *
 * Logging: one line per provider attempt — the `requestId` in the context
 * threads through to `message_meta.request_id` so a support ticket
 * ("my reply was slow at 3pm") resolves to exact provider traces.
 *
 * Tracing: creates a `provider.call` span with `gen_ai.*` semantic
 * attributes per the OTEL GenAI convention:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * If tracing isn't initialized (no OTEL endpoint), the span is a no-op
 * and only the structured log is emitted.
 *
 * The wrapper:
 *   1. Starts a `provider.call` span with gen_ai.* attributes
 *   2. Records the start time
 *   3. Calls the provider via the registry
 *   4. On success: logs `provider_call` + sets span status OK
 *   5. On error: logs `provider_error` + records exception on span
 *   6. Returns the async iterable (for streaming) or throws (for errors)
 *
 * NOTE: token counts are only known AFTER the stream completes, so the
 * success log + span attributes are finalized via `logProviderResult()`
 * after the stream is consumed.
 */

export interface ProviderCallResult {
  stream: AsyncIterable<ProviderStreamChunk>;
  provider: Provider;
  model: string;
  startTime: number;
}

/**
 * Calls a provider with logging + tracing context.
 *
 * @example
 *   const { stream, provider, model, startTime } = await callProviderWithLogging(
 *     "gemini", { system, messages, language }, promptVersion, 1, false,
 *   );
 *   let outputTokens = 0;
 *   for await (const chunk of stream) {
 *     outputTokens++;
 *   }
 *   logProviderResult(provider, model, startTime, promptVersion, 1, false,
 *     inputTokens, outputTokens, costUsd, "completed");
 */
export async function callProviderWithLogging(
  provider: Provider,
  req: StreamRequest,
  promptVersion: string,
  attempt: number,
  fallbackUsed: boolean,
): Promise<ProviderCallResult> {
  const ctx = getCtx();
  const startTime = Date.now();
  const model = getModelForProvider(provider);

  ctx.log.debug("provider_call_start", {
    provider,
    model,
    promptVersion,
    attempt,
    fallbackUsed,
  });

  // Wrap the actual provider call in an OTEL span.
  // If tracing isn't initialized, withSpan is a no-op.
  try {
    const stream = await withSpan("provider.call", async (span) => {
      // Set gen_ai.* semantic attributes on the span.
      if (span) {
        span.setAttribute("gen_ai.system", provider);
        span.setAttribute("gen_ai.request.model", model);
        span.setAttribute("gen_ai.prompt.version", promptVersion);
        span.setAttribute("provider.attempt", attempt);
        span.setAttribute("provider.fallback_used", fallbackUsed);
      }

      // Circuit breaker: protects against cascading failure when the provider
      // is slow/down. Fast-fails (CircuitOpenError) if the circuit is open —
      // the route's fallback path catches this + tries the next provider.
      const breaker = circuitBreaker(`ai:${provider}`, {
        failureThreshold: 5,    // trip after 5 consecutive failures.
        cooldownMs: 30_000,     // half-open probe after 30s.
        timeoutMs: 30_000,      // 30s timeout per call (AI can be slow).
        halfOpenMaxCalls: 1,
      });

      return breaker.exec(() => callProvider(provider, req));
    });

    // Record Prometheus metrics on success.
    aiCallsTotal.inc({ provider, status: "success" });

    return {
      stream,
      provider,
      model,
      startTime,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    // Record failure metrics.
    if (err instanceof CircuitOpenError) {
      aiCallsTotal.inc({ provider, status: "circuit_open" });
      ctx.log.warn("provider_circuit_open", {
        provider,
        model,
        latencyMs,
        attempt,
        fallbackUsed,
      });
    } else {
      aiCallsTotal.inc({ provider, status: "error" });
      ctx.log.warn("provider_error", {
        provider,
        model,
        latencyMs,
        attempt,
        fallbackUsed,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // The span's exception is recorded by withSpan's catch block automatically.
    // No need to call span.recordException() here.

    throw err;
  }
}

/**
 * Logs the final result of a provider call (after the stream completes).
 *
 * Also updates the active OTEL span with token counts + cost (if tracing
 * is enabled). Call this AFTER the stream is fully consumed (or aborted).
 */
export function logProviderResult(
  provider: Provider,
  model: string,
  startTime: number,
  promptVersion: string,
  attempt: number,
  fallbackUsed: boolean,
  inputTokens: number | null,
  outputTokens: number,
  costUsd: number | null,
  status: "completed" | "aborted" | "error",
): void {
  const ctx = getCtx();
  const latencyMs = Date.now() - startTime;

  const level = status === "error" ? "warn" : status === "aborted" ? "info" : "info";

  ctx.log[level]("provider_call", {
    provider,
    model,
    promptVersion,
    latencyMs,
    ...(inputTokens !== null ? { tokensIn: inputTokens } : {}),
    tokensOut: outputTokens,
    ...(costUsd !== null ? { costUsd } : {}),
    attempt,
    fallbackUsed,
    status,
  });

  // Update the active span with final token counts + cost.
  // This is the `provider.call` span started in callProviderWithLogging.
  const span = getCurrentSpan();
  if (span) {
    if (inputTokens !== null) {
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
    }
    span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
    if (costUsd !== null) {
      span.setAttribute("gen_ai.usage.cost_usd", costUsd);
    }
    span.setAttribute("provider.latency_ms", latencyMs);
    span.setAttribute("provider.status", status);
  }

  // ── Prometheus metrics (duration + cost) ──
  // Record the total call duration in the histogram (for p95 SLO measurement).
  aiCallDuration.observe(
    { provider, status },
    latencyMs / 1000, // Prometheus convention: seconds, not ms.
  );

  // Record the cost in the cost counter (for the cost dashboard + alerts).
  if (costUsd !== null && costUsd > 0) {
    aiCostTotal.inc({ provider, model }, costUsd);
  }

  // ── Cost ledger (per-user / per-ws / per-feature) ──
  // Record the cost in the append-only ledger. Fire-and-forget — never blocks
  // the response (if the DB is down, the cost is logged + dropped).
  //
  // Uses the route's pre-computed cost (costUsd) — the route knows the exact
  // provider pricing. We record via recordAiCost which re-computes from the
  // pricing table; if they differ, the route's cost is the authoritative record
  // (persisted in message_meta.cost_usd). The ledger is for aggregation, not
  // exact per-call accounting.
  if (inputTokens !== null && costUsd !== null && costUsd > 0 && status === "completed") {
    try {
      recordAiCost(model, inputTokens, outputTokens, {
        provider,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.workspaceId ? { wsId: ctx.workspaceId } : {}),
      });
    } catch {
      // Cost tracking must never break the response.
    }
  }
}

/**
 * Maps a provider key to its concrete model identifier.
 * Must stay in sync with the CATALOG in lib/router/router.ts.
 */
function getModelForProvider(provider: Provider): string {
  const models: Record<Provider, string> = {
    gemini: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    openrouter: "openrouter/auto",
  };
  return models[provider] ?? "unknown";
}
