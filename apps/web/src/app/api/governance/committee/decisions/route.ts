// POST /api/governance/committee/decisions
//
// Submits a committee decision (approve / reject / defer / table) for a given
// decision type. Records votes + reasoning.
//
// Body:
//   type: "appeal" | "exception" | "policy_override" | "executive_override"
//   subject: string
//   description: string
//   outcome: "approved" | "rejected" | "deferred" | "tabled"
//   reasoning: string
//   membersPresent: CommitteeMember[] (slate of voting members)
//   votes: { approve, reject, defer, table }
//   dissent?: string

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  createCommitteeDecision,
  checkCommitteeRouting,
  COMMITTEE_COMPOSITION,
  type CommitteeDecisionType,
  type CommitteeOutcome,
  type CommitteeMember,
} from "@/lib/governance/governance-committee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  type: z.enum(["appeal", "exception", "policy_override", "executive_override"]) as z.ZodType<CommitteeDecisionType>,
  subject: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  outcome: z.enum(["approved", "rejected", "deferred", "tabled"]) as z.ZodType<CommitteeOutcome>,
  reasoning: z.string().min(10).max(5000),
  membersPresent: z.array(z.object({
    role: z.string(),
    name: z.string(),
  }).passthrough()) as unknown as z.ZodType<CommitteeMember[]>,
  votes: z.object({
    approve: z.number().int().min(0),
    reject: z.number().int().min(0),
    defer: z.number().int().min(0),
    table: z.number().int().min(0),
  }),
  dissent: z.string().max(5000).optional(),
});

export const POST = adminOnly("owner", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  // Check routing rules first — does this slate of members have authority?
  const routing = checkCommitteeRouting({
    type: body.type,
    membersPresent: body.membersPresent,
  });
  if (!routing.canProceed) {
    return okResponse({
      ok: false,
      error: "ROUTING_FAILED",
      routing,
    }, 400);
  }

  const decision = createCommitteeDecision({
    type: body.type,
    subject: body.subject,
    description: body.description,
    outcome: body.outcome,
    reasoning: body.reasoning,
    membersPresent: body.membersPresent,
    votes: body.votes,
    dissent: body.dissent,
  });

  return okResponse({
    decision,
    routing,
    submittedBy: ctx.admin!.adminId,
    submittedAt: new Date().toISOString(),
    fullSlate: COMMITTEE_COMPOSITION,
  });
});
