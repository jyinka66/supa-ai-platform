import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, billingGate, jsonLimiter, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { updateRole, deleteRole } from "@/lib/authz/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ wsId: string; roleId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId, roleId } = await params;
    jsonLimiter(req);
    const uid = await authenticate(req);
    await billingGate(wsId, "PATCH");
    const body = await req.json();
    await updateRole(wsId, roleId, body.permissions ?? []);
    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId, roleId } = await params.catch(() => ({ wsId: "", roleId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/roles/${roleId}`);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ wsId: string; roleId: string }> }) {
  const rid = requestId(req);
  try {
    const { wsId, roleId } = await params;
    const uid = await authenticate(req);
    await billingGate(wsId, "DELETE");
    await deleteRole(wsId, roleId);
    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { wsId, roleId } = await params.catch(() => ({ wsId: "", roleId: "" }));
    return errorResponse(err, `/v1/workspaces/${wsId}/roles/${roleId}`);
  }
}
