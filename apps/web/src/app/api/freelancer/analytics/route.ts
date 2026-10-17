// POST /api/freelancer/analytics
//
// Computes bid analytics from a list of bid records — conversion rates,
// win/loss ratios, average contract size, top-performing proposal styles.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { computeBidAnalytics } from "@/lib/freelancer/bid-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  bids: z.array(z.object({
    id: z.string(),
    jobId: z.string(),
    jobTitle: z.string(),
    platform: z.enum(["upwork", "fiverr", "direct", "other"]),
    submittedAt: z.string(),
    outcome: z.enum(["won", "lost", "pending", "withdrawn", "expired"]),
    resolvedAt: z.string().nullable(),
    contractValue: z.number().optional(),
    currency: z.string(),
    proposalTone: z.enum(["consultative", "direct", "bold", "educational"]),
    matchScore: z.number(),
    autoBid: z.boolean(),
  })).min(1),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const analytics = computeBidAnalytics(body.bids);
  return okResponse({ analytics });
});
