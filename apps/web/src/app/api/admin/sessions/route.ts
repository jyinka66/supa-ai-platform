import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listAdminSessions } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/sessions
 *
 * List the current admin's sessions (device list UI — shows where the admin
 * is logged in + lets them revoke other sessions).
 *
 * Auth: admin session required.
 *
 * Response: { items: AdminSessionRow[] }
 *   Each row: { id, adminId, ip, mfaOk, expiresAt, idleExpiresAt, revokedAt }
 *   Sorted by created_at desc (most recent first).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const ctx = await requireAdminSession(req);
    const items = await listAdminSessions(ctx.adminId);

    const res = NextResponse.json({ items }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/sessions");
  }
}
