import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { markReviewed } from "@/lib/admin/invite";
import { AdminAuthError } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/users/:id/review
 *
 * Mark an admin as quarterly-reviewed (resets quarterly_reviewed_at to now).
 * Owner-only. Used by the admin management UI when an owner completes the
 * 90-day review of another admin's access.
 *
 * The review is a human gate — it doesn't revoke or change access, it just
 * documents that an owner reviewed the admin's continued need for access.
 * The nightly sweep-admin-sessions cron alerts on admins not reviewed in 90d.
 *
 * Response 200: { "ok": true, "reviewedAt": "..." }
 * Response 404: target admin doesn't exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rid = requestId(req);
  const { id: targetId } = await params;
  try {
    const ctx = await requireAdminSession(req, "owner");
    await markReviewed(targetId, ctx.adminId);

    const res = NextResponse.json(
      { ok: true, reviewedAt: new Date().toISOString() },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/users/${targetId}/review`);
  }
}
