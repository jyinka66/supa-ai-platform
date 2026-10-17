// GET /api/governance/principles
//
// Returns the governance principles verification + summary.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyPrinciples, getPrincipleSummary } from "@/lib/governance/principles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    checks: verifyPrinciples(),
    summary: getPrincipleSummary(),
  });
});
