// GET /api/governance/phase-integration
//
// Returns the phase integration spec — how governance integrates with each
// lifecycle phase (build, deploy, publish, marketplace, expansion).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyPhaseIntegration, PHASE_INTEGRATIONS } from "@/lib/governance/phase-integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    integrations: PHASE_INTEGRATIONS,
    verification: verifyPhaseIntegration(),
  });
});
