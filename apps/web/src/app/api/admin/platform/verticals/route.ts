import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listVerticals } from "@/lib/platform/verticals";
import { listDeployments } from "@/lib/platform/enterprise-deployments";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") as any;
    const [verticals, deployments] = await Promise.all([
      listVerticals({ ...(status ? { status } : {}) }),
      listDeployments({ ...(status ? { status } : {}) }),
    ]);
    const res = NextResponse.json({ verticals, deployments }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/platform/verticals");
  }
}
