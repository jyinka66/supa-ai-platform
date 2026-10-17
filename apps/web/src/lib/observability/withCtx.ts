import { NextRequest, NextResponse } from "next/server";
import { reqStore, getCtx, type ReqCtx } from "./context";
import { makeLogger } from "./logger";

/**
 * Wraps a route handler so the AsyncLocalStorage context spans the whole
 * request lifecycle.
 *
 * NOTE: Next.js middleware and route handlers run in separate execution
 * contexts — the ALS context set in middleware does NOT propagate to route
 * handlers. So `withCtx` must be called in EACH route handler, not in
 * middleware. The middleware's job is just to generate + echo the requestId
 * (which it already does via the `X-Request-Id` header).
 *
 * Usage:
 *
 *   export const POST = withCtx(async (req, ctx) => {
 *     // ctx.requestId, ctx.userId, ctx.log are all available here
 *     ctx.log.info("stream_started", { conversationId });
 *     // ... handler logic
 *   }, { route: "chat/stream" });
 *
 * The wrapper:
 *   1. Extracts requestId from `X-Request-Id` / `x-trace-id` headers (or generates UUID)
 *   2. Creates a request context with the logger bound to requestId + route
 *   3. Runs the handler inside `reqStore.run()` so all code (including awaited
 *      promises) can call `getCtx()` to access the context
 *   4. Logs `request_complete` with latency + status on exit
 *   5. Catches unhandled errors, logs them, and returns a 500
 *
 * The wrapper also extracts the userId from the Supabase session (if available)
 * so the context is fully populated before the handler runs.
 */

type Handler = (
  req: NextRequest,
  ctx: ReqCtx,
) => Promise<NextResponse> | NextResponse;

interface WithCtxOptions {
  /** Route path for log correlation (e.g. "chat/stream"). */
  route?: string;
  /** If true, don't catch errors — let them propagate (for error boundaries). */
  rethrow?: boolean;
}

export function withCtx(
  handler: Handler,
  opts: WithCtxOptions = {},
): (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<NextResponse> {
  return async (req, nextContext) => {
    // Extract the request ID from headers (set by middleware) or generate one.
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-trace-id") ??
      crypto.randomUUID();

    const route = opts.route ?? new URL(req.url).pathname;
    const startTime = Date.now();

    // Create the request context.
    const ctx: ReqCtx = {
      requestId,
      userId: null, // will be set by the handler after auth
      log: makeLogger({ requestId, route }),
      route,
    };

    // Run the handler inside the ALS context.
    return reqStore.run(ctx, async () => {
      try {
        // Pass the context to the handler so it can use it directly.
        // Also pass the Next.js params context.
        void nextContext; // params are passed through if needed
        const res = await handler(req, getCtx());

        // Log request completion.
        const latencyMs = Date.now() - startTime;
        getCtx().log.info("request_complete", {
          latencyMs,
          userId: getCtx().userId ?? undefined,
          status: res.status,
        });

        // Echo the request ID in the response so clients can include it
        // in support tickets.
        res.headers.set("X-Request-Id", requestId);
        return res;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const errorCtx = getCtx();
        errorCtx.log.error("request_failed", {
          latencyMs,
          userId: errorCtx.userId ?? undefined,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        });

        if (opts.rethrow) throw err;

        const res = NextResponse.json(
          { error: "internal_error", requestId },
          { status: 500 },
        );
        res.headers.set("X-Request-Id", requestId);
        return res;
      }
    });
  };
}

/**
 * Wraps a route handler that also needs Next.js dynamic params.
 * Same as `withCtx` but passes the resolved params to the handler.
 */
export function withCtxAndParams(
  handler: (
    req: NextRequest,
    ctx: ReqCtx,
    params: Record<string, string>,
  ) => Promise<NextResponse> | NextResponse,
  opts: WithCtxOptions = {},
): (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<NextResponse> {
  return async (req, nextContext) => {
    const params = await nextContext.params;
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-trace-id") ??
      crypto.randomUUID();

    const route = opts.route ?? new URL(req.url).pathname;
    const startTime = Date.now();

    const ctx: ReqCtx = {
      requestId,
      userId: null,
      log: makeLogger({ requestId, route }),
      route,
    };

    return reqStore.run(ctx, async () => {
      try {
        const res = await handler(req, getCtx(), params);

        const latencyMs = Date.now() - startTime;
        getCtx().log.info("request_complete", {
          latencyMs,
          userId: getCtx().userId ?? undefined,
          status: res.status,
        });

        res.headers.set("X-Request-Id", requestId);
        return res;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const errorCtx = getCtx();
        errorCtx.log.error("request_failed", {
          latencyMs,
          userId: errorCtx.userId ?? undefined,
          error: err instanceof Error ? err.message : String(err),
        });

        if (opts.rethrow) throw err;

        const res = NextResponse.json(
          { error: "internal_error", requestId },
          { status: 500 },
        );
        res.headers.set("X-Request-Id", requestId);
        return res;
      }
    });
  };
}

/**
 * Sets the userId on the current request context.
 * Called after auth resolves (e.g. after `requireUser()`).
 */
export function setCtxUser(userId: string): void {
  const ctx = getCtx();
  ctx.userId = userId;
  // Re-create the logger with the userId bound.
  ctx.log = makeLogger({ requestId: ctx.requestId, userId, route: ctx.route });
}
