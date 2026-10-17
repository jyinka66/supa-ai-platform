// GET /api/governance/transparency/auditor
//
// Returns auditor-grade evidence (full audit chain) for compliance reviews.
// Supports filtering by framework (SOC 2, ISO 27001, PCI DSS) and risk level.

import { adminOnly, okResponse, paginate } from "@/lib/api/route-helpers";
import { getAuditorEvidence } from "@/lib/governance/transparency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("senior", async (req, ctx) => {
  const url = new URL(req.url);
  const pagination = paginate(url, { pageSize: 100 });

  const evidence = await getAuditorEvidence({
    framework: url.searchParams.get("framework") ?? undefined,
    riskLevel: url.searchParams.get("riskLevel") ?? undefined,
    limit: pagination.take,
  });

  return okResponse({
    evidence,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: evidence.length,
  });
});
