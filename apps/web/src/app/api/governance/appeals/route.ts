// GET /api/governance/appeals
// POST /api/governance/appeals
//
// GET: returns appeal types + workflow steps.
// POST: files a new appeal against a governance decision.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { APPEAL_TYPES, APPEAL_WORKFLOW } from "@/lib/governance/appeals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    appealTypes: APPEAL_TYPES,
    workflow: APPEAL_WORKFLOW,
    totalTypes: APPEAL_TYPES.length,
    totalSteps: APPEAL_WORKFLOW.length,
  });
});

const BodySchema = z.object({
  decisionId: z.string().min(1).max(200),
  appellantId: z.string().min(1).max(100),
  appealType: z.string().min(2).max(50),
  grounds: z.string().min(20).max(5000),
  evidence: z.array(z.object({
    type: z.string(),
    reference: z.string(),
  })).max(20).default([]),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  // Phase 1: stub — just return the workflow + acknowledge.
  return okResponse({
    appeal: {
      id: crypto.randomUUID(),
      decisionId: body.decisionId,
      appellantId: body.appellantId,
      appealType: body.appealType,
      grounds: body.grounds,
      evidence: body.evidence,
      status: "filed",
      filedAt: new Date().toISOString(),
      currentStep: APPEAL_WORKFLOW[0],
    },
    workflow: APPEAL_WORKFLOW,
    filedBy: ctx.admin!.adminId,
    filedAt: new Date().toISOString(),
  });
});
