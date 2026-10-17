import { NextRequest } from "next/server";
import { authenticate, requestId, billingGate, jsonLimiter, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { inviteSecure } from "@/lib/members/service";
import { checkSeatLimit } from "@/lib/members/seats";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    jsonLimiter(req);
    const uid = await authenticate(req);
    await billingGate(wsId, "POST");
    await checkSeatLimit(wsId);
    const body = await req.json();
    const result = await inviteSecure(wsId, uid, { email: body.email, role: body.role });
    const res = new Response(JSON.stringify(result), { status: 201, headers: { "Content-Type": "application/json" } });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/invitations`);
  }
}
