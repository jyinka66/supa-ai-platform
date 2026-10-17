// GET /api/builder/sessions/[id]/deploy-state
//
// Returns the 6-state deploy state report for a build session:
// code_generated → tests_passed → production_build → deployment_healthy →
// dns_configured → public_url_active.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { getDeployStateReport, DEPLOY_STATES } from "@/lib/builder/deploy-states";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const report = await getDeployStateReport(id);

  return okResponse({
    sessionId: id,
    report,
    states: DEPLOY_STATES,
    totalStates: DEPLOY_STATES.length,
    achievedStates: report.states.filter((s) => s.achieved).length,
  });
});
