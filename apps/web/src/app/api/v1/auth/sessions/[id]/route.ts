// DELETE /api/v1/auth/sessions/:id — revoke a single session by id.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { authenticate, errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rid = requestId(req);
  try {
    const { id: sessionId } = await params;
    const uid = await authenticate(req);

    const result = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "user_revoked" })
      .where(
        and(
          eq(sessions.id, sessionId as any),
          eq(sessions.userId, uid as any),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    if (result.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { id: sessionId } = await params.catch(() => ({ id: "" }));
    return errorResponse(err, `/v1/auth/sessions/${sessionId}`);
  }
}
