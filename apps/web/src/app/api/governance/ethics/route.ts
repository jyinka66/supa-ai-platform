// GET /api/governance/ethics
//
// Returns the ethical principles + bias audit catalog.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { ETHICAL_PRINCIPLES, BIAS_AUDITS } from "@/lib/governance/ethics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    principles: ETHICAL_PRINCIPLES,
    biasAudits: BIAS_AUDITS,
    totalPrinciples: ETHICAL_PRINCIPLES.length,
    totalBiasAudits: BIAS_AUDITS.length,
  });
});
