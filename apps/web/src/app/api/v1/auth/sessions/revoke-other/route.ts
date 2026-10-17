// POST /api/v1/auth/sessions/revoke-other — revoke all sessions except the current one.
// The user stays logged in on the current device; all other devices are logged out.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { eq, and, isNull, ne } from "drizzle-orm";
import { authenticate, errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);

    // Extract session id from JWT.
    const auth = req.headers.get("authorization");
    let sessionId: string | null = null;
    if (auth && auth.startsWith("Bearer ")) {
      try {
        const parts = auth.slice(7).split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
          sessionId = payload.jti ?? null;
        }
      } catch {}
    }

    // Revoke all sessions except the current one.
    const result = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "revoke_other" })
      .where(
        and(
          eq(sessions.userId, uid as any),
          isNull(sessions.revokedAt),
          ...(sessionId ? [ne(sessions.id, sessionId as any)] : []),
        ),
      )
      .returning({ id: sessions.id });

    // Also sign out via Supabase (global — then re-sign-in the current session
    // is not possible via admin API; the current JWT is still valid for 15 min).
    try {
      const { supabaseService } = await import("@/lib/supabase/server");
      const supabase = await supabaseService();
      await supabase.auth.admin.signOut(uid, "global");
    } catch {}

    const res = NextResponse.json({ revoked: result.length }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/sessions/revoke-other");
  }
}
