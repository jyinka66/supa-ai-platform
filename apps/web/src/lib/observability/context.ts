import { AsyncLocalStorage } from "node:async_hooks";
import { makeLogger, type RequestLogger } from "./logger";

/**
 * Request context — propagated via AsyncLocalStorage so we don't have to
 * pass `requestId` through every function signature.
 *
 * The router, provider adapters, budget checks, and audit helper all pull
 * from this context via `getCtx()`.
 *
 * Usage in a route handler:
 *
 *   export async function POST(req: NextRequest) {
 *     return runWithContext({ requestId, userId: user.id }, async () => {
 *       // Inside this callback, getCtx() returns the context.
 *       // The router, adapters, and audit() all read from it.
 *       return handleRequest(req);
 *     });
 *   }
 *
 * Outside a request context, `getCtx()` returns a safe fallback
 * (requestId: 'no-ctx', userId: null) so stray calls (e.g. in cron jobs)
 * never crash.
 */

export interface ReqCtx {
  /** Edge-generated request ID — threads through to message_meta. */
  requestId: string;
  /** Authenticated user ID, or null for anonymous/system actions. */
  userId: string | null;
  /** Logger bound to this context's requestId + userId. */
  log: RequestLogger;
  /** Optional: the workspace context for RLS-aware queries. */
  workspaceId?: string | null;
  /** Optional: route path for log correlation. */
  route?: string;
}

export const reqStore = new AsyncLocalStorage<ReqCtx>();

// Pre-create the fallback logger so we don't create a new one on every
// getCtx() call outside a request context.
const fallbackLog = makeLogger({ requestId: "no-ctx" });

const fallbackCtx: ReqCtx = {
  requestId: "no-ctx",
  userId: null,
  log: fallbackLog,
};

/**
 * Returns the current request context, or a safe fallback if called
 * outside a request (e.g. in a cron job, module-init, or test).
 *
 * The fallback never crashes — it returns requestId='no-ctx' so logs are
 * still emitted (just without correlation to a specific request).
 */
export function getCtx(): ReqCtx {
  return reqStore.getStore() ?? fallbackCtx;
}

/**
 * Runs an async callback within a request context.
 *
 * All code inside the callback (including awaited promises) will see
 * the context via `getCtx()`. The context is automatically cleaned up
 * when the callback completes (even on error).
 *
 * @example
 *   return runWithContext(
 *     { requestId, userId: user.id, route: "chat/stream" },
 *     async () => {
 *       const router = new ModelRouter();
 *       // router internally calls getCtx() to log with the request ID
 *       return router.route(req);
 *     },
 *   );
 */
export async function runWithContext<T>(
  ctx: Omit<ReqCtx, "log">,
  fn: () => Promise<T>,
): Promise<T> {
  const log = makeLogger({
    requestId: ctx.requestId,
    userId: ctx.userId ?? undefined,
    route: ctx.route,
  });
  const fullCtx: ReqCtx = { ...ctx, log };
  return reqStore.run(fullCtx, fn);
}

/**
 * Synchronous variant — for code that doesn't await.
 * Prefer `runWithContext` for async code; this is for rare sync paths.
 */
export function runWithContextSync<T>(
  ctx: Omit<ReqCtx, "log">,
  fn: () => T,
): T {
  const log = makeLogger({
    requestId: ctx.requestId,
    userId: ctx.userId ?? undefined,
    route: ctx.route,
  });
  const fullCtx: ReqCtx = { ...ctx, log };
  return reqStore.run(fullCtx, fn);
}

/**
 * Updates the current context with extra fields (e.g. after the user is
 * authenticated, or after the workspace is resolved).
 *
 * Returns the merged context — does NOT propagate to callers (use
 * `runWithContext` for that). This is mainly for logging within the
 * current scope.
 */
export function augmentCtx(extra: Partial<ReqCtx>): void {
  const current = reqStore.getStore();
  if (!current) return;
  // AsyncLocalStorage doesn't support in-place mutation, but we can
  // re-enter with the merged context. Callers should use runWithContext
  // instead if they need the augmentation to propagate.
  Object.assign(current, extra);
  if (extra.userId !== undefined || extra.route !== undefined) {
    current.log = makeLogger({
      requestId: current.requestId,
      userId: current.userId ?? undefined,
      route: current.route,
    });
  }
}
