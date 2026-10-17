import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, billingGate, jsonLimiter, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { revokeDevice } from "@/lib/e2ee/rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    jsonLimiter(req);
    const uid = await authenticate(req);
    await billingGate(wsId, "POST");
    const body = await req.json();
    const result = await revokeDevice(wsId, uid, body.deviceId);
    const res = NextResponse.json(result, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/e2ee/revoke-device`);
  }
}
