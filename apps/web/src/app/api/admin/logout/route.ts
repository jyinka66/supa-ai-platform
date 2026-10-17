import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { revokeAdminSession } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/logout
 *
 * Revoke the current admin session + clear the supa_admin cookie.
 *
 * Auth: admin session required.
 *
 * Returns 204 on success. The cookie is cleared (Max-Age=0).
 *
 * Note: this only revokes the CURRENT session. To revoke all sessions, the
 * admin uses the sessions list + revokes each (or a "revoke all" endpoint —
 * not yet wired, would call revokeAllAdminSessions).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const ctx = await requireAdminSession(req);
    await revokeAdminSession(ctx.sessionId, "logout");

    const res = new NextResponse(null, { status: 204 });
    // Clear the supa_admin cookie.
    res.headers.set(
      "Set-Cookie",
      "supa_admin=; Path=/api/admin; HttpOnly; Max-Age=0; SameSite=Strict",
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/logout");
  }
}
