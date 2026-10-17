// GET /api/governance/committee
//
// Returns the committee composition + routing rules. The governance committee
// handles human-approval-required decisions (high-risk actions, irreversible
// changes, appeals).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import {
  COMMITTEE_COMPOSITION,
  ROUTING_RULES,
  verifyCommittee,
} from "@/lib/governance/governance-committee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    composition: COMMITTEE_COMPOSITION,
    routingRules: ROUTING_RULES,
    verification: verifyCommittee(),
    totalMembers: COMMITTEE_COMPOSITION.length,
    totalRoutingRules: ROUTING_RULES.length,
  });
});
