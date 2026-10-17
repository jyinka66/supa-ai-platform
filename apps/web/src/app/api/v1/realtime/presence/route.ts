import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { presenceTracker } from "@/lib/realtime/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);
    const wsId = req.nextUrl.searchParams.get("wsId");
    if (!wsId) return NextResponse.json({ error: "wsId_required" }, { status: 400 });
    const presence = presenceTracker.getLocalPresence(wsId);
    const res = NextResponse.json({ data: presence }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/realtime/presence");
  }
}
