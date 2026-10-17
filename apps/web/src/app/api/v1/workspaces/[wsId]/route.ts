import { NextRequest } from "next/server";
import { authenticate, requestId, billingGate, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { getWorkspaceSecure } from "@/lib/workspaces/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "GET");
    const ws = await getWorkspaceSecure(uid, wsId);
    const res = new Response(JSON.stringify(ws), { status: 200, headers: { "Content-Type": "application/json" } });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}`);
  }
}

// PATCH /v1/workspaces/:wsId
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "PATCH");
    const body = await req.json();
    const { updateWorkspaceSecure } = await import("@/lib/workspaces/service");
    await updateWorkspaceSecure(uid, wsId, { name: body.name });
    const res = new Response(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}`);
  }
}

// DELETE /v1/workspaces/:wsId — soft delete
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ wsId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "DELETE");
    const { requestDeletion } = await import("@/lib/workspaces/service");
    await requestDeletion(wsId, uid);
    const res = new Response(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId } = await params.catch(() => ({ wsId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}`);
  }
}
