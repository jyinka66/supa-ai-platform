// Reputation and trust — Section 6.
//
// The spec: "Reputation reduces friction for trusted actors and increases
// scrutiny for untrusted ones."
//
// 7 reputation dimensions + 4 trust tiers with effects.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ReputationDimension =
  | "user" | "workspace" | "agent_creator" | "connector_creator"
  | "template_creator" | "partner" | "developer";

export type TrustTier = "trusted" | "new" | "distrusted" | "banned";

export interface ReputationScore {
  dimension: ReputationDimension;
  entityId: string;
  score: number; // 0-100.
  tier: TrustTier;
  factors: Array<{ factor: string; value: string; weight: number }>;
}

export interface TrustTierEffects {
  tier: TrustTier;
  reviewLevel: "lighter" | "standard" | "heavier" | "blocked";
  rateLimits: "extended" | "standard" | "lower" | "restricted";
  publishingSpeed: "fast" | "standard" | "slow" | "blocked";
  budgetLimits: "extended" | "standard" | "reduced" | "none";
  scopes: "full" | "standard" | "restricted" | "none";
  probation: boolean;
  appealPath: boolean;
}

// ───────────────────────────────────────────────
// Trust tier thresholds.
// ───────────────────────────────────────────────

export const TRUST_THRESHOLDS = {
  trusted: 70,     // score ≥ 70 → trusted.
  new: 40,         // score ≥ 40 (but < 70) → new.
  distrusted: 1,   // score ≥ 1 (but < 40) → distrusted.
  banned: 0,       // score = 0 → banned.
} as const;

// ───────────────────────────────────────────────
// Calculate trust tier from score.
// ───────────────────────────────────────────────

export function getTrustTier(score: number): TrustTier {
  if (score >= TRUST_THRESHOLDS.trusted) return "trusted";
  if (score >= TRUST_THRESHOLDS.new) return "new";
  if (score >= TRUST_THRESHOLDS.distrusted) return "distrusted";
  return "banned";
}

// ───────────────────────────────────────────────
// Trust tier effects.
// ───────────────────────────────────────────────

export const TRUST_TIER_EFFECTS: Record<TrustTier, TrustTierEffects> = {
  trusted: {
    tier: "trusted",
    reviewLevel: "lighter",
    rateLimits: "extended",
    publishingSpeed: "fast",
    budgetLimits: "extended",
    scopes: "full",
    probation: false,
    appealPath: false,
  },
  new: {
    tier: "new",
    reviewLevel: "standard",
    rateLimits: "standard",
    publishingSpeed: "standard",
    budgetLimits: "standard",
    scopes: "standard",
    probation: true, // probation period.
    appealPath: false,
  },
  distrusted: {
    tier: "distrusted",
    reviewLevel: "heavier",
    rateLimits: "lower",
    publishingSpeed: "slow",
    budgetLimits: "reduced",
    scopes: "restricted",
    probation: true,
    appealPath: true,
  },
  banned: {
    tier: "banned",
    reviewLevel: "blocked",
    rateLimits: "restricted",
    publishingSpeed: "blocked",
    budgetLimits: "none",
    scopes: "none",
    probation: false,
    appealPath: true, // notified of appeal path.
  },
};

// ───────────────────────────────────────────────
// Calculate reputation score for a dimension.
//
// Each dimension has different factors. The score is a weighted combination.
// ───────────────────────────────────────────────

export function calculateReputation(
  dimension: ReputationDimension,
  entityId: string,
  factors: Record<string, number>,
): ReputationScore {
  const factorWeights: Record<ReputationDimension, Array<{ factor: string; weight: number; max: number }>> = {
    user: [
      { factor: "tenure_months", weight: 0.2, max: 60 },
      { factor: "verified_identity", weight: 0.3, max: 1 },
      { factor: "payment_history", weight: 0.2, max: 1 },
      { factor: "abuse_free_months", weight: 0.3, max: 60 },
    ],
    workspace: [
      { factor: "plan_tier", weight: 0.3, max: 4 }, // free=0, pro=1, business=2, enterprise=3.
      { factor: "tenure_months", weight: 0.2, max: 60 },
      { factor: "verified_business", weight: 0.2, max: 1 },
      { factor: "complaint_free_months", weight: 0.3, max: 60 },
    ],
    agent_creator: [
      { factor: "published_count", weight: 0.2, max: 50 },
      { factor: "avg_rating", weight: 0.3, max: 5 },
      { factor: "takedown_count", weight: 0.2, max: 0 }, // inverted: 0 takedowns = full score.
      { factor: "support_responsiveness", weight: 0.3, max: 1 },
    ],
    connector_creator: [
      { factor: "published_count", weight: 0.2, max: 20 },
      { factor: "test_coverage_pct", weight: 0.3, max: 100 },
      { factor: "usage_count", weight: 0.2, max: 10000 },
      { factor: "uptime_pct", weight: 0.3, max: 100 },
    ],
    template_creator: [
      { factor: "install_count", weight: 0.3, max: 10000 },
      { factor: "avg_rating", weight: 0.3, max: 5 },
      { factor: "quality_score", weight: 0.2, max: 100 },
      { factor: "support_responsiveness", weight: 0.2, max: 1 },
    ],
    partner: [
      { factor: "contract_status", weight: 0.3, max: 1 },
      { factor: "compliance_score", weight: 0.3, max: 100 },
      { factor: "usage_count", weight: 0.2, max: 10000 },
      { factor: "complaint_count", weight: 0.2, max: 0 }, // inverted.
    ],
    developer: [
      { factor: "sandbox_usage_months", weight: 0.3, max: 12 },
      { factor: "upgrade_history", weight: 0.3, max: 1 },
      { factor: "abuse_free_months", weight: 0.4, max: 12 },
    ],
  };

  const weights = factorWeights[dimension];
  const factorResults: Array<{ factor: string; value: string; weight: number }> = [];
  let score = 0;

  for (const w of weights) {
    const rawValue = factors[w.factor] ?? 0;
    // Normalize to 0-100.
    const normalized = w.max > 0 ? Math.min(100, (rawValue / w.max) * 100) : (rawValue === 0 ? 100 : 0);
    score += normalized * w.weight;
    factorResults.push({ factor: w.factor, value: String(rawValue), weight: w.weight });
  }

  // Clamp to 0-100.
  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = getTrustTier(score);

  return { dimension, entityId, score, tier, factors: factorResults };
}

// ───────────────────────────────────────────────
// Get the effects for a trust tier.
// ───────────────────────────────────────────────

export function getTrustTierEffects(tier: TrustTier): TrustTierEffects {
  return TRUST_TIER_EFFECTS[tier];
}

// ───────────────────────────────────────────────
// Check if reputation changes are allowed.
//
// "Reputation is earned, monitored, and can be lost. It is never permanently
// punitive without human review."
// ───────────────────────────────────────────────

export function canAdjustReputation(currentScore: number, proposedScore: number): { allowed: boolean; requiresHumanReview: boolean; reason: string } {
  const drop = currentScore - proposedScore;

  // Small drops (≤ 10 points) are automatic.
  if (drop <= 10) {
    return { allowed: true, requiresHumanReview: false, reason: `Reputation adjusted by ${drop} points (automatic).` };
  }

  // Medium drops (11-30 points) require human review.
  if (drop <= 30) {
    return { allowed: false, requiresHumanReview: true, reason: `Reputation drop of ${drop} points requires human review.` };
  }

  // Large drops (> 30 points) or banning (to 0) always require human review.
  return { allowed: false, requiresHumanReview: true, reason: `Large reputation drop of ${drop} points requires human review. Never permanently punitive without human.` };
}
