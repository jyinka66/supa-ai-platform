// GET /api/governance/metrics
//
// Returns the governance dashboards: decision metrics (total, latency,
// distribution), policy evaluation metrics, reputation tier distribution,
// and transparency log counts.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getGovernanceDashboard, getPolicyDashboard, getReputationDashboard } from "@/lib/governance/governance-dashboards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const windowMinutes = parseInt(url.searchParams.get("windowMinutes") ?? "60", 10);

  const [governance, policy, reputation] = await Promise.all([
    getGovernanceDashboard({ windowMinutes }),
    getPolicyDashboard(),
    getReputationDashboard({ windowMinutes }),
  ]);

  return okResponse({
    windowMinutes,
    governance,
    policy,
    reputation,
    generatedAt: new Date().toISOString(),
  });
});
