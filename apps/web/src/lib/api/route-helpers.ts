// Shared API helpers for Supa OS / Builder / Governance / Expansion routes.
//
// These wrap the lower-level `http/middleware` + `api/problem` helpers with
// higher-level conveniences that the new routes need:
//
//   1. `withHandler`        — try/catch + requestId + CORS + JSON parse guard
//   2. `requireUser`        — like requireAdminSession but for product users
//   3. `parseJsonBody`      — safe JSON parse with size limit + zod validation
//   4. `paginate`           — parse `?page=` + `?pageSize=` into skip/take
//   5. `okResponse`         — standard success envelope {ok:true, data}
//   6. `adminOnly`          — wraps a handler with requireAdminSession
//   7. `signedRouteHandler` — wraps with both auth + zod schema
//
// These keep route files thin: each route file is just (schema → handler).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { problem, problemFromError } from "@/lib/api/problem";
import { corsHeaders, errorResponse, requestId, ApiError } from "@/lib/http/middleware";

// ───────────────────────────────────────────────
// 1. withHandler — try/catch + CORS + requestId
// ───────────────────────────────────────────────

type HandlerFn = (req: NextRequest, ctx: RouteCtx) => Promise<NextResponse> | NextResponse;

export interface RouteCtx {
  requestId: string;
  url: URL;
  // Injected by adminOnly/userOnly wrappers.
  admin?: { adminId: string; role: string; sessionId: string };
  user?: { userId: string };
}

/**
 * Wrap a route handler with the standard try/catch + CORS + requestId pattern.
 * Use this for any route that doesn't need admin auth — pass `adminOnly` or
 * `userOnly` instead when you need auth.
 */
export function withHandler(handler: HandlerFn) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const rid = requestId(req);
    const url = new URL(req.url);
    try {
      const res = await handler(req, { requestId: rid, url });
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
        res.headers.set(k, v);
      }
      res.headers.set("X-Request-Id", rid);
      return res;
    } catch (err) {
      const res = err instanceof ApiError
        ? problem(err.status, err.message, err.extra ? JSON.stringify(err.extra) : undefined)
        : problemFromError(err, req);
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
        res.headers.set(k, v);
      }
      res.headers.set("X-Request-Id", rid);
      return res;
    }
  };
}

// ───────────────────────────────────────────────
// 2. Auth wrappers
// ───────────────────────────────────────────────

/**
 * Wrap a handler with admin session requirement. Pass the minimum role.
 * Routes that mutate governance / kill switches / marketplaces should pass
 * "owner" or "senior"; read-only routes can use "read_only".
 */
export function adminOnly(minRole: "read_only" | "senior" | "owner" = "senior", handler: HandlerFn) {
  return withHandler(async (req, ctx) => {
    // Lazy import so unit tests can stub the admin module without loading
    // argon2 / supabase on every test run.
    const { requireAdminSession } = await import("@/lib/admin/middleware");
    const admin = await requireAdminSession(req, minRole);
    return handler(req, { ...ctx, admin: { adminId: admin.adminId, role: admin.role, sessionId: admin.sessionId } });
  });
}

/**
 * Wrap a handler with product-user auth (Supabase JWT).
 */
export function userOnly(handler: HandlerFn) {
  return withHandler(async (req, ctx) => {
    const { authenticate } = await import("@/lib/http/middleware");
    const userId = await authenticate(req);
    return handler(req, { ...ctx, user: { userId } });
  });
}

// ───────────────────────────────────────────────
// 3. parseJsonBody — safe JSON + zod validation
// ───────────────────────────────────────────────

/**
 * Parse and validate the request body against a zod schema.
 * Throws ApiError(400, "invalid_json") if the body isn't valid JSON,
 * or ApiError(400, "validation_failed") if zod rejects it.
 */
export async function parseJsonBody<T>(req: NextRequest, schema: z.ZodSchema<T>, maxBytes = 1_048_576): Promise<T> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiError("payload_too_large", 413, { maxBytes });
  }
  let body: unknown;
  try {
    if (!req.body) throw new Error("missing body");
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the intended 413 response */ }
        throw new ApiError("payload_too_large", 413, { maxBytes });
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("invalid_json", 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("validation_failed", 400, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

// ───────────────────────────────────────────────
// 4. paginate — parse ?page= + ?pageSize=
// ───────────────────────────────────────────────

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function paginate(url: URL, defaults: { pageSize?: number; maxPageSize?: number } = {}): Pagination {
  const maxPageSize = defaults.maxPageSize ?? 100;
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    maxPageSize,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? String(defaults.pageSize ?? 20), 10) || 20),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// ───────────────────────────────────────────────
// 5. okResponse — success envelope
// ───────────────────────────────────────────────

export function okResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

// ───────────────────────────────────────────────
// 6. pathParam — read a [param] from the route segment
// ───────────────────────────────────────────────

/**
 * Read a path parameter from a Next.js dynamic route.
 * Throws ApiError(404, "not_found") if the param is missing — this should
 * never happen (Next.js wouldn't route to the handler), but is defensive.
 */
export function pathParam(req: NextRequest, name: string): string {
  const value = req.nextUrl.searchParams.get(`__${name}`) ??
    (req as unknown as { params?: Record<string, string | undefined> }).params?.[name];
  if (!value) {
    throw new ApiError("not_found", 404, { param: name });
  }
  return value;
}

// ───────────────────────────────────────────────
// 7. Common zod schemas — reused across routes
// ───────────────────────────────────────────────

export const commonSchemas = {
  uuid: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  pagination: z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  }),
  empty: z.object({}).strict(),
};

// ───────────────────────────────────────────────
// 8. withRateLimit — applies the rate limit tier for a route
// ───────────────────────────────────────────────

/**
 * Apply the rate limit tier for a route. Returns a 429 problem response
 * if the limit is exceeded; otherwise returns null (caller should proceed).
 *
 * The identifier is the admin/user id for authenticated routes, or a client
 * network identifier for public discovery routes. Local development may run
 * without Redis; production fails closed with 503 if the rate limiter is not
 * configured or cannot be reached. Configure UPSTASH_REDIS_REST_URL + TOKEN.
 *
 * @example
 *   const rl = await withRateLimit(req, ctx.admin!.adminId);
 *   if (rl) return rl; // 429 response
 *   // ... proceed with handler ...
 */
export async function withRateLimit(
  req: NextRequest,
  identifier: string,
): Promise<NextResponse | null> {
  // Fail-open if Redis isn't configured — don't break the API when rate
  // limiting infra is missing. The trade-off: an unconfigured deployment
  // has no rate limiting, which is acceptable for dev/test but NOT for
  // production.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (process.env.NODE_ENV === "production") {
      console.error("[ratelimit] Redis is required in production; refusing an unprotected request.");
      return problem(503, "RATE_LIMITER_UNAVAILABLE", "Rate limiting is temporarily unavailable", { retryAfterSec: 30 });
    }
    return null;
  }
  try {
    const { applyLimitForRoute } = await import("@/lib/ratelimit");
    const result = await applyLimitForRoute(new URL(req.url).pathname, identifier);
    if (!result.ok) {
      return problem("RATE_LIMITED", {
        details: { retryAfterSec: result.retryAfterSec, remaining: result.remaining },
      });
    }
    return null;
  } catch (err) {
    // A production Redis outage must not silently disable abuse protection.
    console.error("[ratelimit] failed to apply rate limit:", err);
    if (process.env.NODE_ENV === "production") {
      return problem(503, "RATE_LIMITER_UNAVAILABLE", "Rate limiting is temporarily unavailable", { retryAfterSec: 30 });
    }
    return null;
  }
}

// Re-export the lower-level helpers for convenience.
export { problem, problemFromError, errorResponse, corsHeaders, requestId };
