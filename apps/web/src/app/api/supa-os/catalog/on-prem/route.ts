// GET /api/supa-os/catalog/on-prem
//
// Returns the on-prem deployment catalog: 9 private cloud targets + 5 container
// platforms + 9 data sovereignty regimes — used by the air-gapped enterprise
// onboarding flow.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { PRIVATE_CLOUD_TARGETS, CONTAINER_DEPLOYMENTS } from "@/lib/supa-os/on-prem-deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    privateCloudTargets: PRIVATE_CLOUD_TARGETS,
    containerPlatforms: CONTAINER_DEPLOYMENTS,
    total: PRIVATE_CLOUD_TARGETS.length + CONTAINER_DEPLOYMENTS.length,
  });
});
