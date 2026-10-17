// GET /api/expansion/playbook
//
// Returns the regional expansion playbook: 6 region components + 7 expansion
// principles.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { REGION_COMPONENTS, EXPANSION_PRINCIPLES } from "@/lib/expansion/regional-expansion-playbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    components: REGION_COMPONENTS,
    principles: EXPANSION_PRINCIPLES,
    totalComponents: REGION_COMPONENTS.length,
    totalPrinciples: EXPANSION_PRINCIPLES.length,
  });
});
