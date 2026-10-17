// GET /api/governance/appeals/[id]
//
// Returns the current state of an appeal (which workflow step it's at).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { APPEAL_WORKFLOW } from "@/lib/governance/appeals";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  // Phase 1: stub — return the workflow + step indicator.
  return okResponse({
    appealId: id,
    workflow: APPEAL_WORKFLOW,
    currentStep: APPEAL_WORKFLOW[0],
    history: [],
    note: "Phase 1 stub — Phase 2 will load from governance_appeals table.",
  });
});
