/**
 * @supa/freelance-ai/auto-bid
 * ----------------------------------------------------------------
 * Auto-biding with guardrails — autonomous proposal submission.
 *
 * The agent scans listings overnight, matches them to the freelancer's
 * profile + market demand, generates proposals, and submits them
 * WITH HARD GUARDRAILS:
 *
 *   1. Max N proposals/day (default 3 — never spam the marketplace).
 *   2. Rate floor (never bid below the freelancer's minimum rate).
 *   3. Discipline match (never bid outside verified disciplines).
 *   4. Quality gate (skip if the proposal draft's edit distance
 *      would be above threshold — if the AI can't draft a clean
 *      proposal, don't submit it).
 *   5. Human review batch (the freelancer reviews a daily batch
 *      of submitted proposals, not each one in real time).
 *
 * A bad auto-bid is worse than no bid — it wastes the freelancer's
 * daily quota + damages their profile with low-quality applications.
 * The guardrails exist to make "no bid" the default; a bid is the
 * exception that passes ALL gates.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import {
  type DraftStore,
  type LlmClient,
} from "./verbs.js";
import { runProposal, type ProposalInput, type ProposalDraft } from "./proposal.js";
import { runPricing, type PricingInput, type PricingSuggestion } from "./pricing.js";
import type { ListingOpportunity } from "./market.js";

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
// Guardrails — the hard limits
// ───────────────────────────────────────────────

export const AutoBidGuardrails = z.object({
  maxProposalsPerDay: z.number().int().min(1).max(10).default(3),
  minimumRateMinor: z.number().int().nonnegative(),
  minimumRateCurrency: z.string().length(3),
  verifiedDisciplines: z.array(z.string()).min(1),
  // Skip if the proposal draft's predicted edit distance would be above this.
  maxPredictedEditDistance: z.number().min(0).max(1).default(0.5),
  // Only bid on listings with budget >= this (avoid low-budget listings).
  minimumBudgetMinor: z.number().int().nonnegative().default(0),
  // Don't bid on listings with fewer than N applicants (too new) or
  // more than M applicants (too competitive).
  minApplicants: z.number().int().min(0).default(0),
  maxApplicants: z.number().int().min(0).default(50),
  // Only bid during these hours (the freelancer's active hours).
  activeHourStart: z.number().int().min(0).max(23).default(8),
  activeHourEnd: z.number().int().min(0).max(23).default(22),
});
export type AutoBidGuardrails = z.infer<typeof AutoBidGuardrails>;

export const DEFAULT_GUARDRAILS: AutoBidGuardrails = {
  maxProposalsPerDay: 3,
  minimumRateMinor: 0,
  minimumRateCurrency: "NGN",
  verifiedDisciplines: [],
  maxPredictedEditDistance: 0.5,
  minimumBudgetMinor: 0,
  minApplicants: 0,
  maxApplicants: 50,
  activeHourStart: 8,
  activeHourEnd: 22,
};

// ───────────────────────────────────────────────
// Auto-bid decision — pass or skip (with reason)
// ───────────────────────────────────────────────

export type BidDecision = "submit" | "skip";

export interface BidEvaluation {
  listingId: string;
  decision: BidDecision;
  reasons: string[];
  // The proposal draft (if decision=submit).
  proposal: ProposalDraft | null;
  // The pricing suggestion (if decision=submit).
  pricing: PricingSuggestion | null;
  // The match + demand data.
  matchScore: number;
  demandIndex: number;
}

// ───────────────────────────────────────────────
// Gate checks — each guardrail is a gate
// ───────────────────────────────────────────────

interface GateResult {
  passed: boolean;
  reason: string;
}

function checkDisciplineMatch(
  listing: { discipline: string },
  guardrails: AutoBidGuardrails,
): GateResult {
  if (!guardrails.verifiedDisciplines.includes(listing.discipline)) {
    return {
      passed: false,
      reason: `discipline "${listing.discipline}" not in verified disciplines [${guardrails.verifiedDisciplines.join(", ")}]`,
    };
  }
  return { passed: true, reason: "discipline matches" };
}

function checkBudgetFloor(
  listing: { budget: { amountMinor: number } },
  guardrails: AutoBidGuardrails,
): GateResult {
  if (listing.budget.amountMinor < guardrails.minimumBudgetMinor) {
    return {
      passed: false,
      reason: `budget ${String(listing.budget.amountMinor)} below floor ${String(guardrails.minimumBudgetMinor)}`,
    };
  }
  return { passed: true, reason: "budget above floor" };
}

function checkRateFloor(
  pricing: PricingSuggestion,
  guardrails: AutoBidGuardrails,
): GateResult {
  if (pricing.suggestedRate.amountMinor < guardrails.minimumRateMinor) {
    return {
      passed: false,
      reason: `suggested rate ${String(pricing.suggestedRate.amountMinor)} below minimum ${String(guardrails.minimumRateMinor)}`,
    };
  }
  return { passed: true, reason: "rate above minimum" };
}

function checkApplicantCount(
  applicantCount: number,
  guardrails: AutoBidGuardrails,
): GateResult {
  if (applicantCount < guardrails.minApplicants) {
    return { passed: false, reason: `only ${String(applicantCount)} applicants (min ${String(guardrails.minApplicants)})` };
  }
  if (applicantCount > guardrails.maxApplicants) {
    return { passed: false, reason: `${String(applicantCount)} applicants (max ${String(guardrails.maxApplicants)}) — too competitive` };
  }
  return { passed: true, reason: "applicant count in range" };
}

function checkActiveHours(
  now: Date,
  guardrails: AutoBidGuardrails,
): GateResult {
  const hour = now.getHours();
  if (hour < guardrails.activeHourStart || hour >= guardrails.activeHourEnd) {
    return { passed: false, reason: `current hour ${String(hour)} outside active window [${String(guardrails.activeHourStart)}, ${String(guardrails.activeHourEnd)})` };
  }
  return { passed: true, reason: "within active hours" };
}

function checkDailyCap(
  proposalsSubmittedToday: number,
  guardrails: AutoBidGuardrails,
): GateResult {
  if (proposalsSubmittedToday >= guardrails.maxProposalsPerDay) {
    return { passed: false, reason: `daily cap reached (${String(proposalsSubmittedToday)}/${String(guardrails.maxProposalsPerDay)})` };
  }
  return { passed: true, reason: "within daily cap" };
}

// ───────────────────────────────────────────────
// Auto-bid runner — the autonomous overnight loop
// ───────────────────────────────────────────────

export interface AutoBidInput {
  wsId: string;
  guardrails: AutoBidGuardrails;
  // The listings to evaluate (already filtered by the market intel matchOpportunities).
  opportunities: readonly ListingOpportunity[];
  // The listing details (full briefs for proposal generation).
  listings: ReadonlyMap<string, {
    title: string;
    brief: string;
    discipline: string;
    skills: readonly string[];
    budget: { amountMinor: number; currency: string };
    budgetType: "hourly" | "fixed";
    applicantCount: number;
  }>;
  // The freelancer's profile (for proposal generation).
  freelancerProfile: {
    headline: string;
    bio: string;
    skills: readonly string[];
    completedContracts: number;
    byDiscipline: ReadonlyArray<{ discipline: string; completed: number }>;
  };
  // The freelancer's pricing history (for rate suggestion).
  pricingHistory: {
    typicalRateMinor: number;
    typicalRateCurrency: string;
    winRateAtTypical: number;
    winRateAboveTypical: number | null;
    minimumRateMinor: number;
    completedContracts: number;
  };
  // Market data (for rate context).
  marketData: {
    medianRateMinor: number;
    p25RateMinor: number;
    p75RateMinor: number;
    demandIndex: number;
  };
  // How many proposals have been submitted today already.
  proposalsSubmittedToday: number;
}

export interface AutoBidResult {
  evaluations: readonly BidEvaluation[];
  submittedCount: number;
  skippedCount: number;
  runAt: string;
}

/**
 * Run the auto-biding loop. Scans opportunities, checks guardrails,
 * generates proposals + pricing, and decides submit vs skip for each.
 *
 * The guardrails exist to make "no bid" the default; a bid is the
 * exception that passes ALL gates. A bad auto-bid is worse than no
 * bid — it wastes the freelancer's daily quota + damages their
 * profile with low-quality applications.
 */
export async function runAutoBid(
  input: AutoBidInput,
  llm: LlmClient,
  drafts: DraftStore,
  now: Date = new Date(),
): Promise<AutoBidResult> {
  const evaluations: BidEvaluation[] = [];
  let submittedCount = 0;

  for (const opportunity of input.opportunities) {
    const listing = input.listings.get(opportunity.listingId);
    if (!listing) continue;

    const reasons: string[] = [];
    let allGatesPassed = true;

    // Gate 1: Active hours.
    const hours = checkActiveHours(now, input.guardrails);
    if (!hours.passed) { reasons.push(hours.reason); allGatesPassed = false; }

    // Gate 2: Daily cap.
    const cap = checkDailyCap(input.proposalsSubmittedToday + submittedCount, input.guardrails);
    if (!cap.passed) { reasons.push(cap.reason); allGatesPassed = false; }

    // Gate 3: Discipline match.
    const discipline = checkDisciplineMatch(listing, input.guardrails);
    if (!discipline.passed) { reasons.push(discipline.reason); allGatesPassed = false; }

    // Gate 4: Budget floor.
    const budget = checkBudgetFloor(listing, input.guardrails);
    if (!budget.passed) { reasons.push(budget.reason); allGatesPassed = false; }

    // Gate 5: Applicant count.
    const applicants = checkApplicantCount(listing.applicantCount, input.guardrails);
    if (!applicants.passed) { reasons.push(applicants.reason); allGatesPassed = false; }

    if (!allGatesPassed) {
      evaluations.push({
        listingId: opportunity.listingId,
        decision: "skip",
        reasons,
        proposal: null,
        pricing: null,
        matchScore: opportunity.matchScore,
        demandIndex: opportunity.demandIndex,
      });
      continue;
    }

    // Generate pricing suggestion.
    const pricingInput: PricingInput = {
      wsId: input.wsId,
      listing: {
        budget: { amountMinor: listing.budget.amountMinor, currency: listing.budget.currency },
        budgetType: listing.budgetType,
        discipline: listing.discipline,
        skills: [...listing.skills],
      },
      freelancerHistory: {
        typicalRateMinor: input.pricingHistory.typicalRateMinor,
        typicalRateCurrency: input.pricingHistory.typicalRateCurrency,
        winRateAtTypical: input.pricingHistory.winRateAtTypical,
        winRateAboveTypical: input.pricingHistory.winRateAboveTypical,
        completedContracts: input.pricingHistory.completedContracts,
        minimumRateMinor: input.guardrails.minimumRateMinor,
      },
      marketData: {
        medianRateMinor: input.marketData.medianRateMinor,
        p25RateMinor: input.marketData.p25RateMinor,
        p75RateMinor: input.marketData.p75RateMinor,
        demandIndex: input.marketData.demandIndex,
      },
    };

    let pricing: PricingSuggestion;
    try {
      const pricingResult = await runPricing(pricingInput, llm, drafts);
      pricing = pricingResult.suggestion;
    } catch {
      evaluations.push({
        listingId: opportunity.listingId,
        decision: "skip",
        reasons: ["pricing suggestion failed to generate"],
        proposal: null,
        pricing: null,
        matchScore: opportunity.matchScore,
        demandIndex: opportunity.demandIndex,
      });
      continue;
    }

    // Gate 6: Rate floor.
    const rate = checkRateFloor(pricing, input.guardrails);
    if (!rate.passed) { reasons.push(rate.reason); }

    if (reasons.length > 0) {
      evaluations.push({
        listingId: opportunity.listingId,
        decision: "skip",
        reasons,
        proposal: null,
        pricing,
        matchScore: opportunity.matchScore,
        demandIndex: opportunity.demandIndex,
      });
      continue;
    }

    // Generate proposal draft.
    const proposalInput: ProposalInput = {
      listing: {
        title: listing.title,
        brief: listing.brief,
        discipline: listing.discipline,
        skills: [...listing.skills],
        budget: { value: pricing.suggestedRate, type: listing.budgetType },
      },
      freelancerProfile: {
        headline: input.freelancerProfile.headline,
        bio: input.freelancerProfile.bio,
        skills: [...input.freelancerProfile.skills],
        completedContracts: input.freelancerProfile.completedContracts,
        byDiscipline: [...input.freelancerProfile.byDiscipline],
      },
      proposedRate: { value: pricing.suggestedRate, type: listing.budgetType },
      proposedDays: 30,
    };

    try {
      const proposalResult = await runProposal(input.wsId, proposalInput, llm, drafts);

      // Gate 7: Quality gate — skip if the AI's confidence is too low
      // (a proxy for predicted edit distance; the real impl uses the
      // quality loop's historical edit distance for this verb + prompt).
      if (proposalResult.proposal.matchConfidence < 0.5) {
        evaluations.push({
          listingId: opportunity.listingId,
          decision: "skip",
          reasons: [`proposal match confidence ${String(proposalResult.proposal.matchConfidence)} below 0.5 threshold — AI can't draft a clean proposal`],
          proposal: proposalResult.proposal,
          pricing,
          matchScore: opportunity.matchScore,
          demandIndex: opportunity.demandIndex,
        });
        continue;
      }

      // All gates passed — submit.
      evaluations.push({
        listingId: opportunity.listingId,
        decision: "submit",
        reasons: [
          "all guardrails passed",
          `rate ${String(pricing.suggestedRate.amountMinor)} ${pricing.suggestedRate.currency}`,
          `match ${String(opportunity.matchScore)}/100`,
          `demand ${String(opportunity.demandIndex)}/100`,
        ],
        proposal: proposalResult.proposal,
        pricing,
        matchScore: opportunity.matchScore,
        demandIndex: opportunity.demandIndex,
      });
      submittedCount++;
    } catch {
      evaluations.push({
        listingId: opportunity.listingId,
        decision: "skip",
        reasons: ["proposal generation failed"],
        proposal: null,
        pricing,
        matchScore: opportunity.matchScore,
        demandIndex: opportunity.demandIndex,
      });
    }
  }

  // Record the auto-bid run.
  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: input.wsId,
      kind: "supa.ai.auto_bid.run",
      ref: {
        submittedCount,
        skippedCount: evaluations.length - submittedCount,
        totalEvaluated: evaluations.length,
        guardrails: input.guardrails,
      },
    });
  });

  return {
    evaluations,
    submittedCount,
    skippedCount: evaluations.length - submittedCount,
    runAt: now.toISOString(),
  };
}

// ───────────────────────────────────────────────
// Daily review batch — the human-in-the-loop
// ───────────────────────────────────────────────

export interface DailyReviewBatch {
  date: string;
  wsId: string;
  submittedProposals: readonly {
    listingId: string;
    listingTitle: string;
    proposalCoverLetter: string;
    suggestedRate: { amountMinor: number; currency: string };
    matchScore: number;
    submittedAt: string;
  }[];
  // The freelancer approves, edits, or withdraws each.
  pendingReview: number;
}

/**
 * Build the daily review batch. The freelancer reviews a daily batch
 * of submitted proposals, not each one in real time. The batch shows:
 *   - Which listings were bid on
 *   - The cover letter that was submitted
 *   - The suggested rate
 *   - The match score
 *
 * The freelancer can: approve (leave as-is), edit (rewrite the cover
 * letter — the edit distance feeds the quality loop), or withdraw
 * (pull the application — "withdrawn is a fact, never a delete").
 */
export function buildDailyReviewBatch(
  wsId: string,
  result: AutoBidResult,
  listings: ReadonlyMap<string, { title: string }>,
  date: string = new Date().toISOString().slice(0, 10),
): DailyReviewBatch {
  const submitted = result.evaluations.filter((e) => e.decision === "submit");

  return {
    date,
    wsId,
    submittedProposals: submitted.map((e) => ({
      listingId: e.listingId,
      listingTitle: listings.get(e.listingId)?.title ?? "Unknown",
      proposalCoverLetter: e.proposal?.coverLetter ?? "",
      suggestedRate: e.pricing?.suggestedRate ?? { amountMinor: 0, currency: "NGN" },
      matchScore: e.matchScore,
      submittedAt: result.runAt,
    })),
    pendingReview: submitted.length,
  };
}
