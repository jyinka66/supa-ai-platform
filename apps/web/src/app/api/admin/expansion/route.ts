import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listExpansionTasks } from "@/lib/expansion/pipeline";
import { getRequirementSummary } from "@/lib/phase11/requirements";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") as "language" | "region" | "jurisdiction" | "support_language" | undefined;
    const status = url.searchParams.get("status") as any;

    const [tasks, requirements] = await Promise.all([
      listExpansionTasks({ ...(kind ? { kind } : {}), ...(status ? { status } : {}) }),
      Promise.resolve(getRequirementSummary()),
    ]);

    const res = NextResponse.json({ tasks, requirements }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/expansion");
  }
}
