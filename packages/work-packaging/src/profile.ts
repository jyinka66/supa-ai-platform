// The public profile is a RENDER, not a record. Everything on
// it is a query over facts:
//   • completed contracts count, on-time rate → from contract facts
//   • rating + review count → from the double-blind review table
//   • skills/disciplines → claimed by freelancer, but each claim
//     annotated with evidence count ("14 completed contracts in
//     data") or "no verified work yet" — honesty in both directions
//   • response time → from messaging facts, median over 90 days
//   • top skills by earnings → from ledger facts (sprint 3 data,
//     reused for free — the fact pipeline pays dividends)
//
// Materialized view, refreshed on fact-writes affecting it,
// recomputed from scratch each refresh (no incremental drift —
// the no-drift rule applied to the most visible surface).
//
// The ONE freelancers can edit freely: bio, headline, avatar,
// rate card, availability. Clearly separated in the schema from
// the evidence-backed sections — a profile reader can always
// tell which is which, in every locale.

import { z } from "zod";
import { Money } from "@supa/freelance-core/job";

// FIX: RateCard was referenced but never defined. Added.
export const RateCard = z.object({
  discipline: z.string(),
  rateType: z.enum(["hourly", "fixed"]),
  amount: Money,
  currency: z.string().length(3),
  description: z.string().max(500).optional(),
});
export type RateCard = z.infer<typeof RateCard>;

// ───────────────────────────────────────────────
// Claimed section — freelancer-editable, clearly separated
// ───────────────────────────────────────────────

export const ClaimedProfile = z.object({
  bio: z.string().max(5_000),
  headline: z.string().max(140),
  avatarUrl: z.string().url().nullable(),
  rates: z.array(RateCard).max(10),
  availability: z.enum(["available", "limited", "unavailable"]),
});
export type ClaimedProfile = z.infer<typeof ClaimedProfile>;

// ───────────────────────────────────────────────
// Verified section — evidence-backed, derived from facts
// ───────────────────────────────────────────────

export const DisciplineStat = z.object({
  discipline: z.string(),
  completed: z.number().int().nonnegative(),
  earned: Money,
  // FIX: "no verified work yet" honesty — annotate each claim
  // with evidence count. When completed=0, the UI shows
  // "no verified work yet" in the claimed section.
  evidenceLabel: z.string(),  // e.g. "14 completed contracts" or "no verified work yet"
});
export type DisciplineStat = z.infer<typeof DisciplineStat>;

export const VerifiedProfile = z.object({
  completedContracts: z.number().int().nonnegative(),
  onTimeRate: z.number().min(0).max(1).nullable(),  // null until N≥5 — small samples don't get numbers (honesty rule)
  rating: z.object({
    mean: z.number().min(1).max(5),
    count: z.number().int().positive(),
  }).nullable(),  // null until first revealed review
  byDiscipline: z.array(DisciplineStat),
  // FIX: response time was in the spec but not in the type. Added.
  medianResponseHours: z.number().nullable(),  // null until N≥5 — median over 90 days
  // FIX: top skills by earnings was in the spec but not in the type. Added.
  topSkillsByEarnings: z.array(z.object({
    skill: z.string(),
    earned: Money,
  })).max(10),
});
export type VerifiedProfile = z.infer<typeof VerifiedProfile>;

// ───────────────────────────────────────────────
// PublicProfile — the materialized read model
// ───────────────────────────────────────────────

export const PublicProfile = z.object({
  wsId: z.string().uuid(),
  claimed: ClaimedProfile,
  verified: VerifiedProfile,
  // FIX: added timestamps for the materialized view freshness.
  computedAt: z.string().datetime(),
  // "as of HH:MM" — staleness visibly marked, same as dashboard.
  // An honest stale number beats a lying fresh-feeling one.
  stalenessLabel: z.string(),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

// ───────────────────────────────────────────────
// Minimum sample size for public stats (the honesty rule)
// ───────────────────────────────────────────────

export const MIN_SAMPLE_FOR_STATS = 5;

/**
 * Check if a freelancer has enough completed contracts to show
 * numeric stats (on-time rate, rating, response time).
 *
 * Small samples don't get numbers — showing "100% on-time" from
 * one contract is dishonest. The honesty rule: N≥5 before a
 * number appears; below that, the UI shows "too few contracts
 * to show" in every locale.
 */
export function hasEnoughSamples(completedContracts: number): boolean {
  return completedContracts >= MIN_SAMPLE_FOR_STATS;
}

// ───────────────────────────────────────────────
// buildPublicProfile — recomputed from scratch each refresh
// ───────────────────────────────────────────────

export interface ProfileFacts {
  wsId: string;
  completedContracts: number;
  onTimeDeliveries: number;
  totalDeliveries: number;       // on-time rate = onTimeDeliveries / totalDeliveries
  revealedReviews: ReadonlyArray<{ rating: number }>;
  byDiscipline: ReadonlyArray<{ discipline: string; completed: number; earnedMinor: number; currency: string }>;
  responseTimesHours: number[]; // last 90 days
  topSkillsByEarnings: ReadonlyArray<{ skill: string; earnedMinor: number; currency: string }>;
}

export interface ClaimedInput {
  bio: string;
  headline: string;
  avatarUrl: string | null;
  rates: RateCard[];
  availability: "available" | "limited" | "unavailable";
}

/**
 * Build the public profile by recomputing from facts. This is the
 * materialized-view refresh — called on fact-writes that affect
 * the profile (contract completed, review revealed, payout confirmed).
 *
 * No incremental drift: every refresh recomputes from scratch.
 * The claimed section is the freelancer's own input (editable);
 * the verified section is evidence-backed (derived from facts).
 *
 * A profile reader can always tell which is which — claimed vs
 * verified are clearly separated in the schema, in every locale.
 */
export function buildPublicProfile(
  facts: ProfileFacts,
  claimed: ClaimedInput,
  now: string = new Date().toISOString(),
): PublicProfile {
  const hasSamples = hasEnoughSamples(facts.completedContracts);

  // On-time rate: null until N≥5.
  const onTimeRate = hasSamples && facts.totalDeliveries > 0
    ? facts.onTimeDeliveries / facts.totalDeliveries
    : null;

  // Rating: null until first revealed review.
  const revealedReviews = facts.revealedReviews;
  const rating = revealedReviews.length > 0
    ? {
        mean: revealedReviews.reduce((sum, r) => sum + r.rating, 0) / revealedReviews.length,
        count: revealedReviews.length,
      }
    : null;

  // Response time: median over 90 days, null until N≥5.
  const medianResponseHours = hasSamples && facts.responseTimesHours.length >= MIN_SAMPLE_FOR_STATS
    ? median(facts.responseTimesHours)
    : null;

  // By discipline: each claim annotated with evidence count.
  const byDiscipline: DisciplineStat[] = facts.byDiscipline.map((d) => ({
    discipline: d.discipline,
    completed: d.completed,
    earned: { amountMinor: d.earnedMinor, currency: d.currency },
    evidenceLabel: d.completed > 0
      ? `${d.completed} completed contract${d.completed === 1 ? "" : "s"} in ${d.discipline}`
      : `no verified work yet in ${d.discipline}`,
  }));

  // Top skills by earnings (from ledger facts — sprint 3 data, reused for free).
  const topSkillsByEarnings = facts.topSkillsByEarnings.map((s) => ({
    skill: s.skill,
    earned: { amountMinor: s.earnedMinor, currency: s.currency },
  }));

  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  return PublicProfile.parse({
    wsId: facts.wsId,
    claimed: {
      bio: claimed.bio,
      headline: claimed.headline,
      avatarUrl: claimed.avatarUrl,
      rates: claimed.rates,
      availability: claimed.availability,
    },
    verified: {
      completedContracts: facts.completedContracts,
      ...(onTimeRate !== null ? { onTimeRate } : { onTimeRate: null }),
      rating,
      byDiscipline,
      ...(medianResponseHours !== null ? { medianResponseHours } : { medianResponseHours: null }),
      topSkillsByEarnings,
    },
    computedAt: now,
    stalenessLabel: `as of ${hh}:${mm}`,
  });
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
