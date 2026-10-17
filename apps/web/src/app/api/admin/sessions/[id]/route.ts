import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@supa/db";
import { adminSessions } from "@supa/db/schema";
import { requireAdminSession } from "@/lib/admin/middleware";
import { revokeAdminSession } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * DELETE /api/admin/sessions/:id
 *
 * Revoke a specific admin session. The caller can only revoke their OWN
 * sessions (defense-in-depth — the session list only returns their own
 * sessions, but we verify ownership before revoking).
 *
 * Returns 204 on success (or if the session was already revoked — idempotent).
 * Returns 404 if the session doesn't exist OR belongs to another admin (no
 * oracle — can't tell which).
 *
 * Auth: admin session required.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rid = requestId(req);
  const { id: sessionId } = await params;
  try {
    const ctx = await requireAdminSession(req);

    // Verify the session belongs to the caller (defense-in-depth).
    const rows = await db
      .select({ id: adminSessions.id })
      .from(adminSessions)
      .where(
        and(
          eq(adminSessions.id, sessionId as any),
          eq(adminSessions.adminId, ctx.adminId as any),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      // Doesn't exist OR belongs to another admin — uniform 404 (no oracle).
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    await revokeAdminSession(sessionId, "revoked_by_self");

    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/api/admin/sessions/${sessionId}`);
  }
}
