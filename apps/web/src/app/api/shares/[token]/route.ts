import { NextRequest } from "next/server";
import { problem, ok } from "@/lib/api/problem";
import { ip } from "@/lib/utils/ip";
import {
  resolve,
  ShareNotImplementedError,
  denialHttpStatus,
  type Viewer,
} from "@/lib/shares";

/**
 * Public share resolution route.
 *
 *   GET  /api/shares/[token]                — no-password / email-gated resolution
 *   POST /api/shares/[token] { password }   — password-gated resolution
 *
 * The token is a base64url SHA-256-length string (43 chars). The raw token
 * is never stored — only its SHA-256 hash (see by-token.ts).
 *
 * Resolution flow (see lib/shares/resolve.ts):
 *   1. Lookup by token_hash.
 *   2. revoked / expired / wrong-email / exhausted → 404 SHARE_LINK_NOT_FOUND.
 *      (NO ORACLE — the viewer can't tell whether the link ever existed.)
 *   3. password_hash set + no/wrong password → 401 UNAUTHENTICATED.
 *      > 10 failed attempts in 15 min → 429 RATE_LIMITED.
 *   4. Atomic view_count increment (race-safe).
 *   5. perm=view → presign inline GET. perm=download → presign attachment GET.
 *
 * Token format: base64url, 43 chars (= SHA-256 bit-length / 6 bits per char).
 * Reject early before hitting the DB (don't waste a query on garbage).
 */

export const runtime = "nodejs"; // argon2 + drizzle need Node APIs.
export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface RouteParams {
  params: Promise<{ token: string }>;
}

/**
 * GET — no-password resolution (or email-gated).
 *
 * Query params:
 *   - email (optional) — required if the link is email-gated. The viewer
 *     must prove ownership out-of-band (the route trusts the claim here;
 *     production wraps this in a signed cookie set by the email-verification
 *     flow).
 *
 * If the link has a password_hash, GET returns 401 with `reason: "password"`
 * — the client should POST with the password.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return problem("INVALID_TOKEN");
  }

  const url = new URL(req.url);
  const email = url.searchParams.get("email") ?? undefined;

  // Conditional spread — `exactOptionalPropertyTypes` forbids passing
  // `undefined` explicitly to an optional `email?: string`. Only set the
  // field when we actually have a value.
  const viewer: Viewer = { ip: ip(req), ...(email ? { email } : {}) };

  const result = await safeResolve(token, viewer);
  return toResponse(result);
}

/**
 * POST — password-gated resolution.
 *
 * Body: { "email"?: string, "password"?: string }
 *
 * If the link has no password_hash, POST is unnecessary (GET would have
 * worked) — but we still process it the same way (idempotent).
 *
 * Password is sent in the body (NOT the URL query — URLs are logged by
 * proxies + browsers). Use HTTPS in production.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return problem("INVALID_TOKEN");
  }

  let body: { email?: string; password?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as { email?: string; password?: string };
  } catch {
    return problem("INVALID_JSON");
  }

  // Conditional spread — see GET handler for the exactOptionalPropertyTypes note.
  const viewer: Viewer = {
    ip: ip(req),
    ...(body.email ? { email: body.email } : {}),
    ...(body.password ? { password: body.password } : {}),
  };

  const result = await safeResolve(token, viewer);
  return toResponse(result);
}

/**
 * Wrap resolve() — catch the NotImplemented (edit-perm) + unexpected errors
 * → map to a 501 / 500 problem. Don't leak internals.
 */
async function safeResolve(token: string, viewer: Viewer) {
  try {
    return await resolve(token, viewer);
  } catch (err) {
    if (err instanceof ShareNotImplementedError) {
      // edit-perm links require the Phase 10 ACL table.
      return { ok: false as const, reason: "not_implemented" as const, message: err.message };
    }
    // Unexpected — log + return a generic 500. Never leak the stack.
    // (The pino logger isn't imported here to keep the route dep-light;
    //  the global error handler will catch + log it.)
    return { ok: false as const, reason: "server_error" as const };
  }
}

/**
 * Map the resolve result to an HTTP response.
 *
 * Admit  → 200 { perm, url, fileId }
 * Deny   → problem(status, code) per denialHttpStatus()
 * 501    → edit-perm not implemented
 * 500    → unexpected error
 */
function toResponse(
  result:
    | { ok: true; perm: "view" | "download"; url: string; fileId: string }
    | { ok: false; reason: "not_found" | "password" | "rate_limited" }
    | { ok: false; reason: "not_implemented"; message?: string }
    | { ok: false; reason: "server_error" },
) {
  if (result.ok) {
    return ok({ perm: result.perm, url: result.url, fileId: result.fileId });
  }

  if (result.reason === "not_implemented") {
    // 501 Not Implemented — the Phase 10 ACL table doesn't exist yet.
    return problem("SERVICE_UNAVAILABLE", {
      status: 501,
      message: result.message ?? "share perm not implemented",
    });
  }
  if (result.reason === "server_error") {
    return problem("INTERNAL_ERROR");
  }

  // Denial — not_found / password / rate_limited.
  const { status, code } = denialHttpStatus(result);
  return problem(code, { status });
}
