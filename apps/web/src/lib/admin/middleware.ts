// Admin auth middleware — requireAdminSession.
//
// SEPARATE from product auth (authenticate() from http/middleware). Admin
// sessions use a separate cookie (supa_admin), a separate token (argon2id,
// 8h cap), and a separate session table (admin_sessions). A product session
// compromise grants ZERO admin surface — the admin cookie is never set by
// product endpoints, and the admin token is never derivable from a product
// JWT.
//
// Flow:
//   1. Read the admin token from the `supa_admin` cookie (or `Authorization:
//      Bearer <token>` for API clients).
//   2. Extract the request IP (via the trusted-proxy ip() helper).
//   3. verifyAdminSession(token, ip) — argon2id verify + expiry + idle + IP
//      match + admin not revoked. Slides the idle timeout.
//   4. Return the admin context (adminId, role, sessionId).
//   5. On any failure → 401 (no oracle — the caller can't tell whether the
//      session exists, is expired, or the IP mismatched).
//
// The admin context is attached to the request for downstream handlers.

import type { NextRequest } from "next/server";
import { verifyAdminSession, requireAdmin, AdminAuthError, type AdminRole } from "./auth";
import { ip } from "@/lib/utils/ip";
import { problem } from "@/lib/api/problem";
import { NextResponse } from "next/server";

export interface AdminContext {
  adminId: string;
  role: AdminRole;
  sessionId: string;
  ip: string;
}

export const ADMIN_COOKIE_NAME = "supa_admin";
const ADMIN_BEARER_PREFIX = "Bearer ";

/**
 * Require an admin session on a request. Returns the admin context, or
 * throws AdminAuthError(401) if no valid session.
 *
 * @param minRole — the minimum role required (default "read_only"). Routes
 *        that perform destructive actions (invite, revoke, delete) should
 *        pass "senior" or "owner".
 *
 * Token sources (in priority order):
 *   1. `Authorization: Bearer <token>` header (for API clients — curl, scripts).
 *   2. `supa_admin` cookie (for the admin web UI — set on login).
 *
 * The IP is always taken from the request (x-forwarded-for via the trusted
 * proxy). The session is IP-bound — a token stolen + replayed from a
 * different IP is rejected (and the session is revoked on the mismatch).
 */
export async function requireAdminSession(
  req: NextRequest,
  minRole: AdminRole = "read_only",
): Promise<AdminContext> {
  const rawToken = extractAdminToken(req);
  if (!rawToken) {
    throw new AdminAuthError("no_admin_session", 401);
  }

  const requestIp = ip(req);
  const session = await requireAdmin(rawToken, requestIp, minRole);
  return {
    adminId: session.adminId,
    role: session.role,
    sessionId: session.id,
    ip: requestIp,
  };
}

/**
 * Extract the admin token from the request. Checks the Authorization header
 * first (API clients), then the cookie (web UI).
 */
function extractAdminToken(req: NextRequest): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith(ADMIN_BEARER_PREFIX)) {
    const token = authHeader.slice(ADMIN_BEARER_PREFIX.length).trim();
    if (token) return token;
  }

  // 2. Cookie: supa_admin=<token>
  const cookie = req.headers.get("cookie");
  if (cookie) {
    const match = cookie.match(new RegExp(`${ADMIN_COOKIE_NAME}=([^;]+)`));
    if (match?.[1]) return match[1];
  }

  return null;
}

/**
 * Wrap an admin route handler. Catches AdminAuthError → 401 problem response.
 * Other errors propagate (the route's own try/catch handles them).
 */
export function withAdmin<T>(
  handler: (ctx: AdminContext, req: NextRequest) => Promise<T>,
): (req: NextRequest) => Promise<T | NextResponse> {
  return async (req: NextRequest) => {
    try {
      const ctx = await requireAdminSession(req);
      return await handler(ctx, req);
    } catch (err) {
      if (err instanceof AdminAuthError) {
        return problem("UNAUTHENTICATED", {
          status: err.status,
          message: "Admin session required.",
        });
      }
      throw err;
    }
  };
}
