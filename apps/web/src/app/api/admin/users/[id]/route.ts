import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { removeAdmin } from "@/lib/admin/invite";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * DELETE /api/admin/users/:id
 *
 * Remove an admin (owner-only, no self-removal). Revokes the admin_users
 * row + hard-deletes all their admin_sessions (sessions die instantly).
 *
 * Auth: admin session with minRole="owner".
 *
 * "owners remove owners" — an owner CAN remove another owner. Only
 * SELF-removal is blocked (prevents a lone owner from locking themselves out).
 *
 * Response 204: removed (or already removed — idempotent).
 * Response 403: actor is not an owner, OR actor is trying to remove themselves.
 * Response 404: target admin doesn't exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rid = requestId(req);
  const { id: targetId } = await params;
  try {
    // Owner-only — requireAdminSession throws AdminAuthError(403) if insufficient.
    const ctx = await requireAdminSession(req, "owner");

    await removeAdmin(
      { adminId: ctx.adminId, role: ctx.role, sessionId: ctx.sessionId, ip: ctx.ip },
      targetId,
    );

    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/api/admin/users/${targetId}`);
  }
}
