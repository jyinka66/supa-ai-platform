// GET /api/governance/kill-switches
//
// Lists kill switches. By default returns both active and inactive. Pass
// ?activeOnly=true to see only active switches.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { listKillSwitches, KILL_SWITCH_TYPES, KILL_SWITCH_PROPAGATION_SLA_SECONDS } from "@/lib/governance/kill-switches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const activeOnly = url.searchParams.get("activeOnly") === "true";

  const switches = await listKillSwitches({ activeOnly });

  return okResponse({
    switches,
    types: KILL_SWITCH_TYPES,
    propagationSlaSeconds: KILL_SWITCH_PROPAGATION_SLA_SECONDS,
    total: switches.length,
  });
});
