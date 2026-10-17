// GET /api/v1/auth/sessions — list the user's active sessions (device list).
// DELETE /api/v1/auth/sessions — revoke all sessions (log out everywhere).

import { NextRequest, NextResponse } from "next/server";
import { listDevices, revokeAllSessions } from "@/lib/auth/session";
import { errorResponse, requestId, corsHeaders, authenticate } from "@/lib/http/middleware";
import { clearRefreshCookie } from "@/lib/auth/cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — list active sessions (self-service device list).
export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);
    const devices = await listDevices(uid);

    const res = NextResponse.json({ data: devices }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/sessions");
  }
}

// DELETE — revoke all sessions (log out everywhere).
export async function DELETE(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);

    // Revoke all app-level sessions.
    const count = await revokeAllSessions(uid);

    // Also sign out via Supabase (revokes Supabase JWTs globally).
    try {
      const { supabaseService } = await import("@/lib/supabase/server");
      const supabase = await supabaseService();
      await supabase.auth.admin.signOut(uid, "global");
    } catch {
      // Best-effort.
    }

    const res = NextResponse.json({ revoked: count }, { status: 200 });

    // Clear the refresh token cookie (the current session is revoked too).
    clearRefreshCookie(res);

    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/sessions");
  }
}
