// GET /api/governance/appeals/types
//
// Returns the appeal types catalog + the 5-step workflow.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { APPEAL_TYPES, APPEAL_WORKFLOW } from "@/lib/governance/appeals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    types: APPEAL_TYPES,
    workflow: APPEAL_WORKFLOW,
    totalTypes: APPEAL_TYPES.length,
    totalSteps: APPEAL_WORKFLOW.length,
  });
});
