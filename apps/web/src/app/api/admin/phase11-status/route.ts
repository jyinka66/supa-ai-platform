import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getPhase11Status } from "@/lib/phase11/status";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/phase11-status
 *
 * The complete Phase 11 status dashboard (owner-only). Aggregates:
 *   - 11.2.1–11.2.9: 9 deliverable areas.
 *   - 11.3–11.5: performance + reliability + security requirements.
 *   - 11.6: observability (dashboards, reports, anomaly detection).
 *   - 11.7: 31 acceptance criteria.
 *   - 11.8: 14-risk registry with mitigation status.
 *   - 11.9: 10 competitive advantages.
 *   - 11.10: 10 future outcomes.
 *
 * Returns the overall completion status + per-section breakdown.
 *
 * This is the "is Phase 11 done?" check.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const status = await getPhase11Status();

    const res = NextResponse.json(status, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/phase11-status");
  }
}
