import { NextRequest } from "next/server";
import { authenticate, requestId, billingGate, jsonLimiter, errorResponse, corsHeaders, ApiError } from "@/lib/http/middleware";
import { transferOwnershipSecure } from "@/lib/members/service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    jsonLimiter(req);
    const uid = await authenticate(req);
    await billingGate(wsId, "POST");
    const body = await req.json();
    const accessToken = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) throw new ApiError("unauthenticated", 401);
    await transferOwnershipSecure(wsId, uid, body.toUserId, accessToken);
    const res = new Response(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/ownership`);
  }
}
