import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { serializeMetrics } from "@/lib/observability/metrics";
import { listCircuitBreakers } from "@/lib/reliability/circuit-breaker";
import { listConcurrencyLimiters } from "@/lib/reliability/backpressure";

/**
 * GET /api/metrics
 *
 * Prometheus scrape endpoint. Exposes all registered metrics in Prometheus
 * text format. Scraped by the Prometheus instance + visualized in Grafana.
 *
 * Auth: `Authorization: Bearer ${METRICS_TOKEN}` (separate from CRON_SECRET —
 * the Prometheus scraper uses its own token). If METRICS_TOKEN is unset,
 * the endpoint is open (local dev only — in production, the env must be set).
 *
 * The endpoint also appends circuit breaker + concurrency limiter states
 * (so Grafana can alert on open circuits / shedding).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  if (!token) {
    // No token configured — allow in non-production, deny in production.
    return process.env.NODE_ENV !== "production";
  }
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7);
  return safeEqual(provided, token);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Serialize the standard metrics (counters, histograms, gauges).
  let body = serializeMetrics();

  // Append circuit breaker states as gauges.
  const breakers = listCircuitBreakers();
  for (const b of breakers) {
    const stateValue = b.state === "closed" ? 0 : b.state === "half_open" ? 1 : 2;
    body += `circuit_breaker_state{name="${b.name}"} ${stateValue}\n`;
    body += `circuit_breaker_total_requests{name="${b.name}"} ${b.stats.totalRequests}\n`;
    body += `circuit_breaker_total_failures{name="${b.name}"} ${b.stats.totalFailures}\n`;
    body += `circuit_breaker_total_rejected{name="${b.name}"} ${b.stats.totalRejected}\n`;
  }

  // Append concurrency limiter states.
  const limiters = listConcurrencyLimiters();
  for (const l of limiters) {
    body += `concurrency_limiter_in_flight{name="${l.name}"} ${l.stats.inFlight}\n`;
    body += `concurrency_limiter_peak{name="${l.name}"} ${l.stats.peakInFlight}\n`;
    body += `concurrency_limiter_total_admitted{name="${l.name}"} ${l.stats.totalAdmitted}\n`;
    body += `concurrency_limiter_total_shed{name="${l.name}"} ${l.stats.totalShed}\n`;
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
