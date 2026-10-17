import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getCostBreakdown, getCostPerUser } from "@/lib/cost/tracker";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/costs
 *
 * Cost dashboard (owner-only). Shows the cost breakdown by feature /
 * workspace / user for a time range. For the monthly cost review.
 *
 * Query params:
 *   ?from=<ISO 8601>  — start of the range (default: 30 days ago).
 *   ?to=<ISO 8601>    — end of the range (default: now).
 *   ?wsId=<uuid>      — filter to a specific workspace (optional).
 *
 * Response 200:
 *   {
 *     "totalCostUsd": 1234.56,
 *     "byFeature": [{ "feature": "ai.chat", "totalCostUsd": 800, ... }],
 *     "byWorkspace": [{ "wsId": "...", "totalCostUsd": 500 }],
 *     "byUser": [{ "userId": "...", "totalCostUsd": 200 }],
 *     "costPerUser": 0.42,
 *     "range": { "from": "...", "to": "..." }
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const wsId = url.searchParams.get("wsId") ?? undefined;

    const toTs = toParam ? new Date(toParam) : new Date();
    const fromTs = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 86400000);

    if (isNaN(fromTs.getTime())) {
      return NextResponse.json({ error: "invalid_from" }, { status: 400 });
    }
    if (isNaN(toTs.getTime())) {
      return NextResponse.json({ error: "invalid_to" }, { status: 400 });
    }

    const [breakdown, costPerUser] = await Promise.all([
      getCostBreakdown(fromTs, toTs, wsId),
      getCostPerUser(fromTs, toTs),
    ]);

    const res = NextResponse.json(
      {
        ...breakdown,
        costPerUser,
        range: { from: fromTs.toISOString(), to: toTs.toISOString() },
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/costs");
  }
}
