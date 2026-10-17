// POST /api/freelancer/approve
//
// Sends a proposal to Slack or Telegram for human-in-the-loop approval.
// The human gets [Approve & Send] / [Edit] / [Skip] buttons.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { buildApprovalMessage, type ApprovalChannel } from "@/lib/freelancer/approval-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  proposalId: z.string().min(1),
  jobId: z.string().min(1),
  jobTitle: z.string().min(3),
  platform: z.enum(["upwork", "fiverr", "direct", "other"]),
  proposal: z.object({
    coverLetter: z.string().optional(),
    estimatedBudget: z.string().optional(),
    estimatedTimeline: z.string().optional(),
  }).passthrough(),
  evaluation: z.object({
    matchScore: z.number().min(0).max(100),
    decision: z.enum(["submit", "skip"]),
  }).passthrough(),
  channel: z.enum(["slack", "telegram"]),
  callbackUrl: z.string().url(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const message = buildApprovalMessage({
    proposalId: body.proposalId,
    jobId: body.jobId,
    jobTitle: body.jobTitle,
    platform: body.platform,
    proposal: body.proposal as never,
    evaluation: body.evaluation as never,
    channel: body.channel as ApprovalChannel,
    callbackUrl: body.callbackUrl,
  });
  return okResponse({
    message,
    proposalId: body.proposalId,
    sentTo: body.channel,
    sentBy: ctx.admin!.adminId,
    sentAt: new Date().toISOString(),
  });
});
