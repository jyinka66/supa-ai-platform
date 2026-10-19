/**
 * @supa/freelance-ai/market
 * ----------------------------------------------------------------
 * Market intelligence — forward-looking demand signals. The profile's
 * topSkillsByEarnings is derived from PAST facts; this module looks
 * FORWARD: "demand for React + TypeScript is up 40% this quarter
 * in your region."
 *
 * The agent uses this to proactively suggest which listings to apply
 * to (option 6 auto-biding reads this signal).
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import {
  Verb,
  buildProvenance,
  type DraftId,
  type DraftStore,
  type LlmClient,
} from "./verbs.js";
import { Discipline } from "@supa/freelance-core/job";

async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

// ───────────────────────────────────────────────
// Market intelligence verb
// ───────────────────────────────────────────────

export const MARKET_VERB: Verb = {
  id: "market.intelligence",
  reads: ["market_listings", "freelancer_profile"],
  modelId: "gemini-1.5-flash",
  promptVersion: "market.intel.v1",
  writes: "draft_only",
  qualityChannel: "ai.market.intelligence",
};

// ───────────────────────────────────────────────
// Market data — what the AI reads
// ───────────────────────────────────────────────

export const MarketData = z.object({
  // Listing volume per discipline in the last 30 days.
  disciplineDemand: z.array(z.object({
    discipline: Discipline,
    listingCount30d: z.number().int().nonnegative(),
    // Change vs the prior 30 days (positive = growing demand).
    changePercent: z.number(),
  })),
  // Skill demand (top N skills by listing count).
  skillDemand: z.array(z.object({
    skill: z.string(),
    listingCount30d: z.number().int().nonnegative(),
    changePercent: z.number(),
  })).max(50),
  // Rate trends per discipline (median rate change).
  rateTrends: z.array(z.object({
    discipline: Discipline,
    medianRateMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    changePercent: z.number(),
  })),
  // The freelancer's disciplines + skills (to personalize the signal).
  freelancerDisciplines: z.array(Discipline),
  freelancerSkills: z.array(z.string()),
});
export type MarketData = z.infer<typeof MarketData>;

// ───────────────────────────────────────────────
// Output — the intelligence brief
// ───────────────────────────────────────────────

export const MarketIntel = z.object({
  // Top 3 demand opportunities for this freelancer.
  opportunities: z.array(z.object({
    discipline: Discipline,
    skill: z.string().optional(),
    demandIndex: z.number(),       // 0..100, higher = more demand
    changePercent: z.number(),    // growth/decline
    medianRateMinor: z.number().int().optional(),
    currency: z.string().length(3).optional(),
    recommendation: z.string().max(500),
  })).max(5),
  // Declining areas (skills/disciplines losing demand).
  decliningAreas: z.array(z.object({
    area: z.string(),
    changePercent: z.number(),
    recommendation: z.string().max(500),
  })).max(5),
  // The overall market summary (3-5 sentences, plain language).
  summary: z.string().max(2_000),
  // Confidence in the analysis.
  confidence: z.number().min(0).max(1),
});
export type MarketIntel = z.infer<typeof MarketIntel>;

// ───────────────────────────────────────────────
// runMarketIntel — generate the intelligence brief
// ───────────────────────────────────────────────

export async function runMarketIntel(
  wsId: string,
  data: MarketData,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; intel: MarketIntel }> {
  const verb = MARKET_VERB;

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    disciplineDemand: data.disciplineDemand,
    skillDemand: data.skillDemand,
    rateTrends: data.rateTrends,
    freelancerDisciplines: data.freelancerDisciplines,
    freelancerSkills: data.freelancerSkills,
  });

  let intel: MarketIntel;
  try {
    intel = MarketIntel.parse(JSON.parse(rawOutput));
  } catch {
    intel = MarketIntel.parse({
      opportunities: [],
      decliningAreas: [],
      summary: "AI market analysis failed to parse. See raw data.",
      confidence: 0,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(intel),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.market.intel",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        opportunityCount: intel.opportunities.length,
        decliningCount: intel.decliningAreas.length,
        confidence: intel.confidence,
      },
    });
  });

  return { draftId: draft.id, intel };
}

// ───────────────────────────────────────────────
// Opportunity matching — which listings should the freelancer apply to?
// ───────────────────────────────────────────────

export interface ListingOpportunity {
  listingId: string;
  title: string;
  discipline: string;
  matchScore: number;       // 0..100 (from matchScore in @supa/supa-board/match)
  demandIndex: number;       // 0..100 (from market intel)
  suggestedRate: { amountMinor: number; currency: string } | null;
  reason: string;
}

/**
 * Match market opportunities against active listings. The auto-biding
 * agent (option 6) reads this to decide which listings to submit
 * proposals to.
 *
 * The match uses the matchScore() from @supa/supa-board (skills +
 * discipline + reliability + rate fit) + the demandIndex from this
 * module's market intel. High match + high demand = prioritize.
 */
export function matchOpportunities(
  listings: ReadonlyArray<{
    id: string;
    title: string;
    discipline: string;
    skills: readonly string[];
  }>,
  intel: MarketIntel,
  freelancerSkills: readonly string[],
): readonly ListingOpportunity[] {
  const opportunities: ListingOpportunity[] = [];

  for (const listing of listings) {
    // Skill overlap (simplified matchScore).
    const overlap = listing.skills.filter((s) => freelancerSkills.includes(s));
    const matchScore = listing.skills.length > 0
      ? Math.round((overlap.length / listing.skills.length) * 100)
      : 0;

    if (matchScore === 0) continue; // no overlap = skip

    // Find the demand index for this discipline.
    const disciplineDemand = intel.opportunities.find((o) => o.discipline === listing.discipline);
    const demandIndex = disciplineDemand?.demandIndex ?? 0;

    // Only include if match + demand are both non-trivial.
    if (matchScore < 30 || demandIndex < 20) continue;

    opportunities.push({
      listingId: listing.id,
      title: listing.title,
      discipline: listing.discipline,
      matchScore,
      demandIndex,
      suggestedRate: disciplineDemand?.medianRateMinor !== undefined
        ? { amountMinor: disciplineDemand.medianRateMinor, currency: disciplineDemand.currency ?? "NGN" }
        : null,
      reason: `${String(overlap.length)}/${String(listing.skills.length)} skills match, demand index ${String(demandIndex)}/100`,
    });
  }

  // Sort by combined score (match + demand).
  return opportunities.sort((a, b) =>
    (b.matchScore + b.demandIndex) - (a.matchScore + a.demandIndex),
  );
}
