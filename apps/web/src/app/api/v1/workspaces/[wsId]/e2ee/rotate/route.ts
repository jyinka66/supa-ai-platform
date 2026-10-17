import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, billingGate, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { rotateRootKey } from "@/lib/e2ee/rotation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "POST");
    const result = await rotateRootKey(wsId, uid);
    const res = NextResponse.json(result, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/e2ee/rotate`);
  }
}
