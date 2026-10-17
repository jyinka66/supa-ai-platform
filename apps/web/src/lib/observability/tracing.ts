/**
 * OpenTelemetry tracing setup — OPTIONAL, recommended for pre-launch.
 *
 * If you don't have an OTEL collector (Tempo, Jaeger, Honeycomb, Datadog),
 * this module is a no-op. The structured logging from Week 7 (lib/observability/logger.ts)
 * is sufficient for most debugging.
 *
 * Enable by setting `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTEL env var):
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 *
 * Spans created:
 *   http.request          (auto-instrumented by @opentelemetry/instrumentation-http)
 *     → chat.route        (manual span in withCtx)
 *       → provider.call   (manual span in callProviderWithLogging)
 *         → db.insert     (auto-instrumented if you add @opentelemetry/instrumentation-pg)
 *
 * Provider spans include `gen_ai.*` semantic attributes per the OTEL
 * GenAI convention: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *   gen_ai.system, gen_ai.request.model, gen_ai.usage.input_tokens,
 *   gen_ai.usage.output_tokens, gen_ai.response.finish_reason
 *
 * Sampling: 10% in production (configurable via OTEL_TRACES_SAMPLER_ARG).
 * The router/health/cost code already logs every call via pino — OTEL
 * traces are for distributed profiling, not audit.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace, type Span, type Tracer, context } from "@opentelemetry/api";
import { getCtx } from "./context";

let tracer: Tracer | null = null;
let started = false;

/**
 * Initializes the OpenTelemetry SDK.
 *
 * Safe to call multiple times — only starts once.
 * Safe to call when no OTEL endpoint is configured — exports are silently
 * dropped (the SDK handles this internally).
 *
 * Called from the app's instrumentation.ts (Next.js convention).
 */
export function initTracing(): void {
  if (started) return;
  started = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // No collector configured — tracing is a no-op.
    // The app still works; logs are the primary observability surface.
    return;
  }

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: "supa-ai-web",
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
  });

  try {
    sdk.start();
    tracer = trace.getTracer("supa-ai");
    console.info(
      JSON.stringify({
        event: "otel_initialized",
        endpoint,
        sampleRate: process.env.OTEL_TRACES_SAMPLER_ARG ?? "0.1",
      }),
    );
  } catch (err) {
    // Tracing failure must NEVER crash the app.
    console.warn(
      JSON.stringify({
        event: "otel_init_failed",
        error: String(err),
      }),
    );
  }

  // Graceful shutdown — flush pending spans before process exits.
  if (typeof process !== "undefined") {
    const shutdown = async () => {
      try {
        await sdk.shutdown();
      } catch {
        // Best-effort.
      }
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  }
}

/**
 * Creates a traced span around an async operation.
 *
 * If tracing isn't initialized, this is a no-op — the callback runs
 * without a span, and no attributes are recorded.
 *
 * @example
 *   return withSpan("provider.call", async (span) => {
 *     span.setAttribute("gen_ai.system", provider);
 *     span.setAttribute("gen_ai.request.model", model);
 *     const result = await callProvider(provider, req);
 *     span.setAttribute("gen_ai.usage.output_tokens", result.tokens);
 *     return result;
 *   });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!tracer) {
    return fn(null);
  }

  return tracer.startActiveSpan(name, async (span) => {
    try {
      // Bind the request ID from the AsyncLocalStorage context.
      const ctx = getCtx();
      if (ctx.requestId !== "no-ctx") {
        span.setAttribute("request.id", ctx.requestId);
      }
      if (ctx.userId) {
        span.setAttribute("user.id", ctx.userId);
      }
      if (ctx.route) {
        span.setAttribute("http.route", ctx.route);
      }

      const result = await fn(span);
      span.setStatus({ code: 1 /* OK */ });
      return result;
    } catch (err) {
      span.setStatus({
        code: 2 /* ERROR */,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Returns the active tracer (or null if tracing isn't initialized).
 */
export function getTracerInstance(): Tracer | null {
  return tracer;
}

/**
 * Returns the current span (for adding attributes from deep in the call stack).
 * Returns null if no span is active.
 */
export function getCurrentSpan(): Span | undefined {
  if (!tracer) return undefined;
  const span = trace.getSpan(context.active());
  return span ?? undefined;
}
