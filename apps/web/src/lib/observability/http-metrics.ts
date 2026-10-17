// HTTP metrics middleware — records Prometheus metrics for every HTTP request.
//
// The spec: "Backend performance — edge functions, Node runtime where needed,
// streaming, connection pooling, query optimization, N+1 prevention, read
// replicas, Redis, HTTP caching, compression, HTTP/2 and HTTP/3." +
// "Observability — metrics (Prometheus-compatible)."
//
// Records:
//   - http_requests_total{method, route, status} — counter.
//   - http_request_duration_seconds{method, route, status} — histogram.
//   - http_requests_in_flight — gauge (current in-flight count).
//
// Usage (in a route handler):
//   export async function GET(req: NextRequest) {
//     const end = recordHttpStart(req);
//     try {
//       ... // handler logic.
//       const res = NextResponse.json({ ok: true });
//       recordHttpEnd(end, req, res.status);
//       return res;
//     } catch (err) {
//       recordHttpEnd(end, req, 500);
//       throw err;
//     }
//   }
//
// Or use the wrapper:
//   export const GET = withHttpMetrics("GET", async (req) => { ... });

import type { NextRequest, NextResponse } from "next/server";
import {
  httpRequestTotal,
  httpRequestDuration,
  httpRequestInFlight,
} from "@/lib/observability/metrics";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface HttpMetricsHandle {
  method: string;
  route: string;
  startTime: number;
}

// ───────────────────────────────────────────────
// Route normalization — collapses path params to a stable route pattern.
// ───────────────────────────────────────────────

/**
 * Normalize a URL pathname to a stable route pattern (for metric labels).
 *
 *   /api/v1/chat/threads/abc-123 → /api/v1/chat/threads/:id
 *   /api/v1/files/abc-123/download → /api/v1/files/:id/download
 *
 * This prevents high-cardinality label explosion (one label per UUID = millions
 * of time series). UUIDs + numeric IDs are collapsed to `:id`.
 */
export function normalizeRoute(pathname: string): string {
  return pathname
    // Replace UUIDs with :id.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    // Replace numeric IDs with :id.
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    // Replace long base64url tokens (43+ chars) with :token.
    .replace(/\/[A-Za-z0-9_-]{43,}/g, "/:token");
}

// ───────────────────────────────────────────────
// recordHttpStart / recordHttpEnd
// ───────────────────────────────────────────────

/**
 * Record the start of an HTTP request. Returns a handle to pass to recordHttpEnd.
 *
 * Increments the in-flight gauge. The route is normalized (UUIDs/IDs collapsed)
 * to prevent label cardinality explosion.
 */
export function recordHttpStart(req: NextRequest): HttpMetricsHandle {
  const method = req.method;
  const route = normalizeRoute(new URL(req.url).pathname);
  httpRequestInFlight.inc({ method, route });
  return { method, route, startTime: Date.now() };
}

/**
 * Record the end of an HTTP request. Decrements the in-flight gauge +
 * records the total + duration metrics.
 *
 * @param handle — from recordHttpStart.
 * @param status — the HTTP status code of the response.
 */
export function recordHttpEnd(handle: HttpMetricsHandle, status: number): void {
  const durationSec = (Date.now() - handle.startTime) / 1000;
  const statusClass = `${Math.floor(status / 100)}xx`;

  httpRequestInFlight.dec({ method: handle.method, route: handle.route });
  httpRequestTotal.inc(
    { method: handle.method, route: handle.route, status: String(status), status_class: statusClass },
  );
  httpRequestDuration.observe(
    { method: handle.method, route: handle.route, status_class: statusClass },
    durationSec,
  );
}

// ───────────────────────────────────────────────
// withHttpMetrics — wrapper for route handlers
// ───────────────────────────────────────────────

/**
 * Wrap a route handler with HTTP metrics recording.
 *
 * Usage:
 *   export const GET = withHttpMetrics(async (req) => {
 *     return NextResponse.json({ ok: true });
 *   });
 *
 * The wrapper records http_requests_total + http_request_duration_seconds +
 * http_requests_in_flight. On error, records status 500 + re-throws.
 */
export function withHttpMetrics<T extends NextResponse>(
  method: string,
  handler: (req: NextRequest) => Promise<T>,
): (req: NextRequest) => Promise<T> {
  return async (req: NextRequest) => {
    const handle = recordHttpStart(req);
    try {
      const res = await handler(req);
      recordHttpEnd(handle, res.status);
      return res;
    } catch (err) {
      recordHttpEnd(handle, 500);
      throw err;
    }
  };
}
