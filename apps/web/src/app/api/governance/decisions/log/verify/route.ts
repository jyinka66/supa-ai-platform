// POST /api/governance/decisions/log/verify
//
// Verifies the integrity of the decision log chain (each entry's hash links
// to the previous entry's hash — any tampering breaks the chain).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyDecisionLogChain } from "@/lib/governance/governance-decision-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminOnly("senior", async (req, ctx) => {
  const verification = await verifyDecisionLogChain();
  return okResponse({
    verification,
    verifiedBy: ctx.admin!.adminId,
    verifiedAt: new Date().toISOString(),
  });
});
