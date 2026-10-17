// POST /api/v1/auth/logout — revoke the current session + clear the refresh cookie.
//
// Flow:
//   1. Extract the session id (jti) from the access token (Authorization header).
//   2. Revoke the session (set revoked_at + revoked_reason='logout').
//   3. Clear the refresh token cookie.
//   4. Return 204 No Content.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { clearRefreshCookie } from "@/lib/auth/cookies";
import { errorResponse, requestId, corsHeaders, authenticate } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    // Authenticate to get the user id + session id.
    // The authenticate function returns the uid; we need the session id (jti)
    // from the JWT. For now, we decode the JWT payload to get jti.
    const uid = await authenticate(req);

    // Extract the session id (jti) from the access token.
    const auth = req.headers.get("authorization");
    let sessionId: string | null = null;
    if (auth && auth.startsWith("Bearer ")) {
      const token = auth.slice(7);
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1]!, "base64url").toString("utf8"),
          );
          sessionId = payload.jti ?? null;
        }
      } catch {
        // Malformed JWT — can't extract session id.
      }
    }

    // Revoke the session (if we have the session id).
    if (sessionId) {
      await db
        .update(sessions)
        .set({
          revokedAt: new Date(),
          revokedReason: "logout",
        })
        .where(
          and(
            eq(sessions.id, sessionId as any),
            eq(sessions.userId, uid as any),
            isNull(sessions.revokedAt),
          ),
        );
    }

    // Also sign out via Supabase (revokes Supabase JWTs).
    try {
      const { supabaseService } = await import("@/lib/supabase/server");
      const supabase = await supabaseService();
      await supabase.auth.admin.signOut(uid, "global");
    } catch {
      // Best-effort — if Supabase is unavailable, the session row is still revoked.
    }

    // Build the response.
    const res = new NextResponse(null, { status: 204 });

    // Clear the refresh token cookie.
    clearRefreshCookie(res);

    // CORS + request id.
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);

    return res;
  } catch (err) {
    // Even on error, clear the cookie (logout should always clear the cookie).
    const res = errorResponse(err, "/v1/auth/logout");
    clearRefreshCookie(res);
    return res;
  }
}
