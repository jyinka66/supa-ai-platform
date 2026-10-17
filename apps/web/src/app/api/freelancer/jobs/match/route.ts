// POST /api/freelancer/jobs/match
//
// Semantic job matching — takes a list of jobs + the freelancer's portfolio
// and returns ranked matches with 0-100% scores.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { semanticMatchJobs, type PortfolioEmbedding, type ClientQualityFilter } from "@/lib/freelancer/semantic-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  jobs: z.array(z.object({
    jobId: z.string(),
    title: z.string(),
    description: z.string(),
    budget: z.object({ amount: z.number(), currency: z.string() }),
    clientRating: z.number().optional(),
    clientVerifiedPayment: z.boolean().optional(),
    clientLocation: z.string().optional(),
    platform: z.enum(["upwork", "fiverr", "direct", "other"]),
  })).min(1),
  portfolio: z.array(z.object({
    portfolioId: z.string(),
    sourceText: z.string(),
    title: z.string(),
    tags: z.array(z.string()).default([]),
  })).min(1),
  filters: z.object({
    minClientRating: z.number().optional(),
    requireVerifiedPayment: z.boolean().optional(),
    minBudget: z.number().optional(),
    maxBudget: z.number().optional(),
    currencies: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
  }).optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const results = semanticMatchJobs(
    body.jobs,
    body.portfolio as PortfolioEmbedding[],
    body.filters as ClientQualityFilter | undefined,
  );
  return okResponse({
    matchedJobs: results,
    totalJobs: body.jobs.length,
    matched: results.length,
    filters: body.filters ?? {},
  });
});
