import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listTools, registerTool, type ToolCategory } from "@/lib/platform/tool-registry";
import { listItems, publishItem, type MarketplaceKind } from "@/lib/platform/marketplace";
import { listPolicies } from "@/lib/platform/policy-engine";
import { runSelfHealing } from "@/lib/platform/self-healing";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req);

    const [tools, marketplaceItems, policies] = await Promise.all([
      listTools(),
      listItems({ limit: 20 }),
      listPolicies(),
    ]);

    const res = NextResponse.json({
      tools: { count: tools.length, items: tools.slice(0, 20) },
      marketplace: { count: marketplaceItems.length, items: marketplaceItems.slice(0, 20) },
      policies: { count: policies.length, items: policies.slice(0, 20) },
    }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/platform/status");
  }
}
