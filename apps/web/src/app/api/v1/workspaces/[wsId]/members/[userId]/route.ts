import { NextRequest } from "next/server";
import { authenticate, requestId, billingGate, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { listDevices } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ wsId: string; userId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "GET");
    // List members (stub — a real impl queries memberships for this ws).
    const res = new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "", userId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/members`);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ wsId: string; userId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId, userId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "PATCH");
    const body = await req.json();
    const { setRoleSecure } = await import("@/lib/members/service");
    await setRoleSecure(wsId, uid, userId, body.role);
    const res = new Response(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "", userId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/members/${(await params).userId}`);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ wsId: string; userId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId, userId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "DELETE");
    const { removeMemberSecure } = await import("@/lib/members/service");
    await removeMemberSecure(wsId, uid, userId);
    const res = new Response(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "", userId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/members/${(await params).userId}`);
  }
}
