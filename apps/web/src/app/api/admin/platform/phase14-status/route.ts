import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getPhase14Status } from "@/lib/platform/platform-acceptance-criteria";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/platform/phase14-status
 *
 * The complete Phase 14 status dashboard (owner-only). Aggregates:
 *   - 14.2.1–14.2.19: 19 deliverable areas.
 *   - 14.3: 11 performance requirements.
 *   - 14.4: 11 reliability requirements.
 *   - 14.5: 16 security & privacy checks.
 *   - 14.6: 6 observability checks.
 *   - 14.7: 22 acceptance criteria.
 *
 * Returns the overall completion status + per-section breakdown.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const status = getPhase14Status();
    const res = NextResponse.json(status, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/platform/phase14-status");
  }
}
