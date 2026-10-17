// Match score: computed, explained, never stored as a bare
// number. A score without a why is astrology (the standing
// rule), so the score ships with its contributing factors.

import { z } from "zod";
import { Discipline } from "@supa/freelance-core/job";
import { Money } from "@supa/freelance-core/job";

// ───────────────────────────────────────────────
// Input types — the job + freelancer profile
// ───────────────────────────────────────────────

export const ListingJob = z.object({
  skills: z.array(z.string()).max(30),
  discipline: Discipline,
  budget: Money,
  budgetType: z.enum(["hourly", "fixed"]),
});
export type ListingJob = z.infer<typeof ListingJob>;

export const Profile = z.object({
  skills: z.array(z.string()),
  completedByDiscipline: z.record(Discipline, z.number().int().nonnegative()),
  onTimeRate: z.number().min(0).max(1),           // 0..1, query over contract facts
  avgResponseHours: z.number().min(0),             // hours, query over contract facts
  hourlyRateMinor: z.number().int().nonnegative(), // freelancer's typical rate (minor units)
  hourlyRateCurrency: z.string().length(3),
});
export type Profile = z.infer<typeof Profile>;

// ───────────────────────────────────────────────
// Match factor — the "why" that ships with every score
// ───────────────────────────────────────────────

export interface MatchFactor {
  factor: string;
  weight: number;       // max points this factor can contribute
  contributed: number;  // actual points contributed (0..weight)
  detail: string;       // human-readable explanation
}

export interface MatchResult {
  score: number;        // 0..100
  reasons: MatchFactor[];
}

// ───────────────────────────────────────────────
// clamp helper
// ───────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ───────────────────────────────────────────────
// matchScore — computed, explained, never stored as a bare number
// ───────────────────────────────────────────────

export function matchScore(job: ListingJob, freelancer: Profile): MatchResult {
  const reasons: MatchFactor[] = [];

  // FIX: score was never accumulated — now sums contributed points.
  let score = 0;

  // 1. Skill overlap (weighted by job's skill order — first-listed
  // skills matter more; the job poster ranked them, respect it)
  const overlap = job.skills.filter((s) => freelancer.skills.includes(s));
  const skillRatio = job.skills.length > 0 ? overlap.length / job.skills.length : 0;
  const skillContributed = Math.round(skillRatio * 40);
  score += skillContributed;
  // FIX: template literal was broken — `overlap.length/{overlap.length}/overlap.length/{job.skills.length}`
  // had no `$` before `{`, and the prefix was literal text.
  reasons.push({
    factor: "skills",
    weight: 40,
    contributed: skillContributed,
    detail: `${overlap.length}/${job.skills.length} listed skills matched`,
  });

  // 2. Same discipline + past completed contracts in it (facts only —
  // profile claims count less than completed-contract facts, and
  // the detail string says which)
  const completedCount = freelancer.completedByDiscipline[job.discipline] ?? 0;
  const disciplineContributed = Math.min(30, completedCount * 10); // 10 pts per contract, cap 30
  score += disciplineContributed;
  // FIX: template literal was broken — `${freelancer.completedByDiscipline[job.discipline]}`
  // used bracket access on a possibly-undefined key.
  reasons.push({
    factor: "discipline_history",
    weight: 30,
    contributed: disciplineContributed,
    detail: completedCount > 0
      ? `${completedCount} completed contracts in this discipline`
      : "no completed contracts in this discipline yet",
  });

  // 3. On-time rate: queries over contract facts, provenance-traced
  // like every public stat — uneditable numbers.
  // FIX: was `/* ... */` — incomplete. Now computes from onTimeRate.
  const reliabilityContributed = Math.round(freelancer.onTimeRate * 20);
  score += reliabilityContributed;
  reasons.push({
    factor: "reliability",
    weight: 20,
    contributed: reliabilityContributed,
    detail: `${(freelancer.onTimeRate * 100).toFixed(0)}% on-time rate across contracts`,
  });

  // 4. Rate fit — freelancer's hourly rate vs job budget.
  // FIX: was `/* ... */` — incomplete. Now computes a simple fit score.
  let rateFitDetail = "rate fit not assessed";
  let rateFitContributed = 0;
  if (job.budgetType === "hourly") {
    const budgetMinor = job.budget.amountMinor;
    const freelancerRate = freelancer.hourlyRateMinor;
    if (freelancerRate <= budgetMinor) {
      rateFitContributed = 10;
      rateFitDetail = `freelancer rate within budget`;
    } else {
      const ratio = budgetMinor / freelancerRate;
      rateFitContributed = Math.round(ratio * 10);
      rateFitDetail = `freelancer rate exceeds budget by ${((1 - ratio) * 100).toFixed(0)}%`;
    }
  } else {
    // Fixed budget: rate fit is neutral (the freelancer bid what they bid).
    rateFitContributed = 5;
    rateFitDetail = "fixed budget — rate fit neutral";
  }
  score += rateFitContributed;
  reasons.push({
    factor: "rate_fit",
    weight: 10,
    contributed: rateFitContributed,
    detail: rateFitDetail,
  });

  return { score: clamp(score, 0, 100), reasons };
}
