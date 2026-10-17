// POST /api/governance/enterprise/provisioning
//
// Governs enterprise deployment provisioning — checks license, deployment
// model compliance, and upgrade eligibility.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { governProvisioning, checkEnterpriseCompliance } from "@/lib/governance/enterprise-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  deploymentType: z.enum(["cloud", "vpc", "on_prem", "dedicated"]),
  capacityTier: z.enum(["small", "medium", "large", "xl"]),
  region: z.string().min(2).max(50),
  customDomain: z.string().max(200).optional(),
  templateExists: z.boolean(),
  requiresCustomDomain: z.boolean().optional().default(false),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const result = governProvisioning({
    deploymentType: body.deploymentType,
    capacityTier: body.capacityTier,
    region: body.region,
    customDomain: body.customDomain,
    templateExists: body.templateExists,
    requiresCustomDomain: body.requiresCustomDomain ?? false,
  });
  // Also compute the compliance gates with default values for the demo.
  const complianceGates = checkEnterpriseCompliance({
    jurisdiction: body.region,
    isHealthcare: false,
    dpaSigned: true,
    baaSigned: false,
    customTermsSigned: false,
    securityReviewPassed: true,
    dataResidencyConfirmed: true,
  });

  return okResponse({
    request: body,
    governance: result,
    complianceGates,
    governedBy: ctx.admin!.adminId,
    governedAt: new Date().toISOString(),
  });
});
