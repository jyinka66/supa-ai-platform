import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listSlos, listAlertingSlos } from "@/lib/reliability/slo";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/slos
 *
 * SLO dashboard (owner-only). Shows all SLO definitions + their latest
 * snapshot (SLI actual vs target, error budget consumed/remaining, alert
 * status). For the reliability dashboard.
 *
 * Response 200:
 *   {
 *     "slos": [
 *       {
 *         "service": "api",
 *         "sloName": "availability",
 *         "target": 0.999,
 *         "sliValue": 0.9991,
 *         "errorBudgetConsumed": 0.1,
 *         "errorBudgetRemaining": 0.9,
 *         "alerting": false,
 *         "owner": "team-platform"
 *       }
 *     ],
 *     "alertingCount": 0
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const [slos, alerting] = await Promise.all([
      listSlos(),
      listAlertingSlos(),
    ]);

    const res = NextResponse.json(
      {
        slos: slos.map((s) => ({
          id: s.id,
          service: s.service,
          sloName: s.sloName,
          description: s.description,
          target: s.target,
          targetUnit: s.targetUnit,
          windowDays: s.windowDays,
          alertThreshold: s.alertThreshold,
          owner: s.owner,
          latestSnapshot: s.latestSnapshot
            ? {
                snapshotAt: s.latestSnapshot.snapshotAt.toISOString(),
                sliValue: s.latestSnapshot.sliValue,
                sliUnit: s.latestSnapshot.sliUnit,
                errorBudgetRemaining: s.latestSnapshot.errorBudgetRemaining,
                errorBudgetConsumed: s.latestSnapshot.errorBudgetConsumed,
                sampleCount: s.latestSnapshot.sampleCount,
                metadata: s.latestSnapshot.metadata,
              }
            : null,
          alerting: s.alerting,
        })),
        alertingCount: alerting.length,
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/slos");
  }
}
