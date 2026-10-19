/**
 * @supa/freelance-ai/pricing
 * ----------------------------------------------------------------
 * Pricing intelligence — AI-suggested rates based on market data,
 * the freelancer's history, and the listing's budget. Closes the
 * pricing gap: "your typical rate is ₦50k/hr but this listing
 * budgets ₦80k/hr; consider bidding ₦70k."
 *
 * The suggestion is a DRAFT — the freelancer decides. The AI never
 * sets the rate; it provides the data that makes the decision
 * informed.
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
import { Money } from "@supa/freelance-core/job";

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
// Pricing verb
// ───────────────────────────────────────────────

export const PRICING_VERB: Verb = {
  id: "pricing.suggest",
  reads: ["listing", "freelancer_history", "market_data"],
  modelId: "gemini-1.5-flash",
  promptVersion: "pricing.suggest.v1",
  writes: "draft_only",
  qualityChannel: "ai.pricing.suggest",
};

// ───────────────────────────────────────────────
// Input — what the AI reads
// ───────────────────────────────────────────────

export const PricingInput = z.object({
  wsId: z.string().uuid(),
  listing: z.object({
    budget: Money,
    budgetType: z.enum(["hourly", "fixed"]),
    discipline: z.string(),
    skills: z.array(z.string()),
    estimatedHours: z.number().int().optional(),
  }),
  freelancerHistory: z.object({
    // The freelancer's past rates by discipline (from ledger facts).
    typicalRateMinor: z.number().int().nonnegative(),
    typicalRateCurrency: z.string().length(3),
    // Win rate at different rate levels (from proposal outcomes).
    winRateAtTypical: z.number().min(0).max(1),
    winRateAboveTypical: z.number().min(0).max(1).nullable(), // when bidding higher
    completedContracts: z.number().int().nonnegative(),
    // The freelancer's minimum rate (their floor — never bid below).
    minimumRateMinor: z.number().int().nonnegative(),
  }),
  marketData: z.object({
    // Median rate for this discipline + skill set (from marketplace data).
    medianRateMinor: z.number().int().nonnegative(),
    // 25th + 75th percentile.
    p25RateMinor: z.number().int().nonnegative(),
    p75RateMinor: z.number().int().nonnegative(),
    // Demand signal (listings count in the last 30 days for this discipline).
    demandIndex: z.number().min(0), // 0 = no demand, higher = more demand
  }),
});
export type PricingInput = z.infer<typeof PricingInput>;

// ───────────────────────────────────────────────
// Output — the pricing suggestion
// ───────────────────────────────────────────────

export const PricingSuggestion = z.object({
  suggestedRate: Money,
  rateType: z.enum(["hourly", "fixed"]),
  // The AI's reasoning (shown to the freelancer).
  rationale: z.string().max(2_000),
  // The data that informed the suggestion.
  factors: z.array(z.object({
    factor: z.string(),
    detail: z.string(),
    direction: z.enum(["up", "down", "neutral"]), // did this push the rate up or down?
  })),
  // Confidence in the suggestion (0..1).
  confidence: z.number().min(0).max(1),
  // Whether the suggestion is above the freelancer's typical rate (growth opportunity).
  isGrowthOpportunity: z.boolean(),
  // Whether the suggestion is at/below the freelancer's minimum (shouldn't happen, but checked).
  isBelowMinimum: z.boolean(),
});
export type PricingSuggestion = z.infer<typeof PricingSuggestion>;

// ───────────────────────────────────────────────
// runPricing — generate a rate suggestion
// ───────────────────────────────────────────────

/**
 * Generate a pricing suggestion. The AI reads the listing's budget,
 * the freelancer's history (typical rate, win rate at different
 * levels, completed contracts, minimum rate), and market data
 * (median, percentiles, demand).
 *
 * The suggestion is a DRAFT — the freelancer decides. The AI never
 * sets the rate; it provides the data that makes the decision informed.
 *
 * Hard rule: the suggestion is NEVER below the freelancer's minimum
 * rate. If the market data suggests a lower rate, the AI explains
 * why + suggests declining the listing instead.
 */
export async function runPricing(
  input: PricingInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; suggestion: PricingSuggestion }> {
  const verb = PRICING_VERB;

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    listing: input.listing,
    freelancerHistory: input.freelancerHistory,
    marketData: input.marketData,
  });

  let suggestion: PricingSuggestion;
  try {
    suggestion = PricingSuggestion.parse(JSON.parse(rawOutput));
  } catch {
    // Fallback: suggest the freelancer's typical rate.
    suggestion = PricingSuggestion.parse({
      suggestedRate: {
        amountMinor: input.freelancerHistory.typicalRateMinor,
        currency: input.freelancerHistory.typicalRateCurrency,
      },
      rateType: input.listing.budgetType,
      rationale: "AI pricing suggestion failed to parse — using your typical rate as fallback.",
      factors: [],
      confidence: 0,
      isGrowthOpportunity: false,
      isBelowMinimum: false,
    });
  }

  // Hard rule: never below the freelancer's minimum.
  if (suggestion.suggestedRate.amountMinor < input.freelancerHistory.minimumRateMinor) {
    suggestion = {
      ...suggestion,
      suggestedRate: {
        amountMinor: input.freelancerHistory.minimumRateMinor,
        currency: input.freelancerHistory.typicalRateCurrency,
      },
      isBelowMinimum: false, // we corrected it — but flag the original was below
      rationale: `Original suggestion was below your minimum rate. Adjusted to your floor of ${String(input.freelancerHistory.minimumRateMinor)}. ${suggestion.rationale}`,
    };
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId: input.wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(suggestion),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: input.wsId,
      kind: "supa.ai.pricing.suggest",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        suggestedRate: suggestion.suggestedRate.amountMinor,
        isGrowthOpportunity: suggestion.isGrowthOpportunity,
        confidence: suggestion.confidence,
      },
    });
  });

  return { draftId: draft.id, suggestion };
}
