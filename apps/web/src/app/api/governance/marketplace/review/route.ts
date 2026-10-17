// POST /api/governance/marketplace/review
//
// Reviews a marketplace submission (agent / connector / template / prompt).
// Returns whether the submission is auto-approved, requires human review, or
// is rejected.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  reviewSubmission,
  isHighRiskSubmission,
  HIGH_RISK_TYPES,
  type SubmissionKind,
} from "@/lib/governance/marketplace-publishing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  kind: z.enum(["agent", "connector", "template", "prompt"]) as z.ZodType<SubmissionKind>,
  slug: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/),
  title: z.string().min(3).max(200),
  description: z.string().min(20).max(5000),
  manifest: z.record(z.string(), z.unknown()),
  submitterId: z.string().min(1).max(100),
  submitterReputation: z.number().min(0).max(100).optional(),
  submitterVerified: z.boolean().optional(),
  existingSlugs: z.array(z.string()).optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const highRisk = isHighRiskSubmission(body.kind, body.manifest);
  const review = await reviewSubmission({
    kind: body.kind,
    slug: body.slug,
    title: body.title,
    description: body.description,
    manifest: body.manifest,
    authorReputation: body.submitterReputation ?? 50,
    authorVerified: body.submitterVerified ?? false,
    existingSlugs: body.existingSlugs,
  });

  return okResponse({
    request: body,
    highRisk,
    review,
    highRiskTypes: HIGH_RISK_TYPES,
    reviewedBy: ctx.admin!.adminId,
    reviewedAt: new Date().toISOString(),
  });
});
