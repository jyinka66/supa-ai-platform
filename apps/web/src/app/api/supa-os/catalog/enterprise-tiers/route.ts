// GET /api/supa-os/catalog/enterprise-tiers
//
// Returns the enterprise tier catalog (Team, Business, Enterprise, Air-gapped)
// plus deployment models (SaaS, Dedicated, VPC, On-prem) — used by the
// enterprise onboarding wizard.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { ENTERPRISE_TIERS, DEPLOYMENT_MODELS } from "@/lib/supa-os/enterprise-tier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    tiers: ENTERPRISE_TIERS,
    deploymentModels: DEPLOYMENT_MODELS,
    total: ENTERPRISE_TIERS.length,
  });
});
