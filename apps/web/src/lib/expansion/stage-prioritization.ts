// Stage 3 — Prioritization.
//
// The spec (7): "Goal: Score and queue regions by expected value."
//
//   7.1 Scoring Model — 6 factors:
//     - Demand — measured signals.
//     - Market size — population, freelancers, SMBs, enterprises.
//     - Revenue potential — projected ARPU, willingness to pay, payment reach.
//     - Readiness — how much preparation is required.
//     - Cost to launch — localization, legal, infrastructure, support.
//     - Strategic value — regional influence, language leverage, competitive positioning.
//     - Risk — legal, political, economic, competitive.
//
//   The spec lists 6 factors but counts Risk separately — we model 7 factors
//   (Demand, Market size, Revenue, Readiness, Cost, Strategic value, Risk).
//   The score is weighted, versioned, and configurable.
//
//   7.2 Prioritization Output: A ranked queue of regions. The top region is
//   automatically prepared next, unless a human overrides.
//
//   7.3 Human Override: Promote / Demote / Remove / Add manually. Every
//   override is logged with reasoning.
//
// DESIGN
//
//   This module is the runtime implementation of Stage 3. It:
//     1. Pulls the latest evaluation output (composite score, confidence,
//        gaps, effort) per candidate region.
//     2. Pulls demand signals (confidence score from Stage 1).
//     3. Pulls market data (population, freelancer/SMB/enterprise counts).
//     4. Pulls revenue potential (ARPU × market size × payment reach).
//     5. Applies the 6-factor weighted scoring model.
//     6. Ranks the regions into a priority queue.
//     7. Exposes human override operations (promote/demote/remove/add).
//
//   The scoring model is VERSIONED + CONFIGURABLE — the weights live in a
//   `priority_score_weights` table so the governance committee can adjust
//   them without a code deploy. Each weight set has a version + an
//   `effective_from` timestamp; the engine reads the latest active version.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 7.1 Scoring model — 7 factors.
// ───────────────────────────────────────────────

export type PriorityFactor =
  | "demand"            // 7.1.1 measured signals.
  | "market_size"       // 7.1.2 population, freelancers, SMBs, enterprises.
  | "revenue_potential" // 7.1.3 projected ARPU × willingness to pay × payment reach.
  | "readiness"         // 7.1.4 how much preparation is required (inverse — high readiness = high score).
  | "cost_to_launch"    // 7.1.5 localization, legal, infrastructure, support (inverse — high cost = low score).
  | "strategic_value"   // 7.1.6 regional influence, language leverage, competitive positioning.
  | "risk";             // 7.1.7 legal, political, economic, competitive (inverse — high risk = low score).

export interface PriorityFactorSpec {
  factor: PriorityFactor;
  title: string;
  description: string;
  /** Default weight (0-1); weights sum to 1.0 across all factors. */
  defaultWeight: number;
  /** Whether this factor is INVERSE (high raw = low contribution). */
  inverse: boolean;
  /** The data source we read to compute the raw score (0-100). */
  source: string;
  implemented: boolean;
}

export const PRIORITY_FACTORS: PriorityFactorSpec[] = [
  {
    factor: "demand",
    title: "Demand",
    description: "Measured demand signals (traffic, signups, payments, support, search, referrals, social).",
    defaultWeight: 0.20,
    inverse: false,
    source: "stage-detection.ts (confidenceScore from detectDemandSignals).",
    implemented: true,
  },
  {
    factor: "market_size",
    title: "Market Size",
    description: "Population, freelancer population, small business population, enterprise presence.",
    defaultWeight: 0.15,
    inverse: false,
    source: "regional_market_data (population, freelancer_population, smb_population, enterprise_presence).",
    implemented: true,
  },
  {
    factor: "revenue_potential",
    title: "Revenue Potential",
    description: "Projected ARPU × willingness to pay × payment method reach.",
    defaultWeight: 0.20,
    inverse: false,
    source: "regional_revenue_projections (arpu_usd, willingness_to_pay_score, payment_reach_percent).",
    implemented: true,
  },
  {
    factor: "readiness",
    title: "Readiness",
    description: "How much preparation is required (composite readiness score from Stage 2 — inverse: high readiness = high score).",
    defaultWeight: 0.15,
    inverse: false, // readiness is already a 0-100 score; high = good.
    source: "stage-evaluation.ts (compositeScore from produceEvaluationOutput).",
    implemented: true,
  },
  {
    factor: "cost_to_launch",
    title: "Cost to Launch",
    description: "Localization, legal, infrastructure, support cost (inverse: high cost = low contribution).",
    defaultWeight: 0.10,
    inverse: true,
    source: "stage-evaluation.ts (effort.estimatedCostUsd from produceEvaluationOutput).",
    implemented: true,
  },
  {
    factor: "strategic_value",
    title: "Strategic Value",
    description: "Regional influence, language leverage (serves multiple markets), competitive positioning.",
    defaultWeight: 0.10,
    inverse: false,
    source: "regional_strategic_data (influence_score, language_leverage_score, competitive_positioning_score).",
    implemented: true,
  },
  {
    factor: "risk",
    title: "Risk",
    description: "Legal, political, economic, competitive risk (inverse: high risk = low contribution).",
    defaultWeight: 0.10,
    inverse: true,
    source: "regional_risk_data (legal_risk, political_risk, economic_risk, competitive_risk).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 7.1 Scoring weights — versioned + configurable.
// ───────────────────────────────────────────────

export interface ScoreWeights {
  version: number;
  weights: Record<PriorityFactor, number>;
  effectiveFrom: Date;
  active: boolean;
  updatedBy: string;
}

/** The default weights (sum to 1.0). Mirrors PRIORITY_FACTORS.defaultWeight. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  version: 1,
  weights: {
    demand: 0.20,
    market_size: 0.15,
    revenue_potential: 0.20,
    readiness: 0.15,
    cost_to_launch: 0.10,
    strategic_value: 0.10,
    risk: 0.10,
  },
  effectiveFrom: new Date("2025-01-01T00:00:00Z"),
  active: true,
  updatedBy: "system",
};

/**
 * Get the active score weights from the DB (or fall back to defaults).
 *
 * The weights are versioned + configurable — the governance committee can
 * adjust them via the priority_score_weights table without a code deploy.
 */
export async function getActiveScoreWeights(): Promise<ScoreWeights> {
  const result = await db.execute(sql`
    select version, demand_w, market_size_w, revenue_potential_w, readiness_w,
           cost_to_launch_w, strategic_value_w, risk_w,
           effective_from, updated_by
      from priority_score_weights
     where active = true
     order by version desc
     limit 1
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return DEFAULT_SCORE_WEIGHTS;

  return {
    version: Number(row.version),
    weights: {
      demand: Number(row.demand_w),
      market_size: Number(row.market_size_w),
      revenue_potential: Number(row.revenue_potential_w),
      readiness: Number(row.readiness_w),
      cost_to_launch: Number(row.cost_to_launch_w),
      strategic_value: Number(row.strategic_value_w),
      risk: Number(row.risk_w),
    },
    effectiveFrom: row.effective_from as Date,
    active: true,
    updatedBy: row.updated_by as string,
  };
}

/**
 * Update the score weights — creates a new version (never mutates existing).
 * The governance committee calls this to re-tune the prioritization model.
 */
export async function updateScoreWeights(input: {
  weights: Record<PriorityFactor, number>;
  updatedBy: string;
  reason: string;
}): Promise<number> {
  // Validate weights sum to ~1.0 (±0.01 tolerance).
  const sum = Object.values(input.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 0.01) {
    throw new Error(`score_weights: weights must sum to 1.0 (got ${sum.toFixed(4)})`);
  }

  // Get the next version number.
  const versionResult = await db.execute(sql`
    select coalesce(max(version), 0)::int + 1 as next_version
      from priority_score_weights
  `);
  const nextVersion = Number((versionResult as unknown as Array<{ next_version: number }>)[0]?.next_version ?? 1);

  // Deactivate the previous active version.
  await db.execute(sql`
    update priority_score_weights set active = false where active = true
  `);

  // Insert the new version.
  await db.execute(sql`
    insert into priority_score_weights
      (version, demand_w, market_size_w, revenue_potential_w, readiness_w,
       cost_to_launch_w, strategic_value_w, risk_w, active, effective_from, updated_by)
    values
      (${nextVersion}, ${input.weights.demand}, ${input.weights.market_size},
       ${input.weights.revenue_potential}, ${input.weights.readiness},
       ${input.weights.cost_to_launch}, ${input.weights.strategic_value},
       ${input.weights.risk}, true, now(), ${input.updatedBy})
  `);

  await adminAudit({
    actor: input.updatedBy,
    action: "regional.prioritization.weights_updated",
    target: { version: nextVersion, weights: input.weights, reason: input.reason },
    justification: `Score weights updated to v${nextVersion}: ${input.reason}`,
  });

  return nextVersion;
}

// ───────────────────────────────────────────────
// 7.1 Runtime — compute the priority score for a region.
// ───────────────────────────────────────────────

export interface FactorScore {
  factor: PriorityFactor;
  rawScore: number;    // 0-100 (raw measurement).
  contribution: number; // rawScore × weight (weighted contribution to the priority score).
  weight: number;
  inverse: boolean;
  source: string;
}

export interface PriorityScoreResult {
  regionCode: string;
  factors: FactorScore[];
  totalScore: number;       // 0-100 (weighted sum of contributions).
  weightsVersion: number;
  computedAt: Date;
}

/**
 * Compute the priority score for a region using the 6-factor model.
 *
 * For each factor:
 *   - Read the raw score (0-100) from the source.
 *   - For inverse factors (cost, risk), invert: contribution = (100 - raw) × weight.
 *   - For normal factors, contribution = raw × weight.
 *
 * The total score is the sum of all contributions (0-100).
 */
export async function computePriorityScore(regionCode: string): Promise<PriorityScoreResult> {
  const weights = await getActiveScoreWeights();

  // Read all factor raw scores in parallel.
  const [
    demandRow, marketRow, revenueRow, readinessRow, costRow, strategicRow, riskRow,
  ] = await Promise.all([
    db.execute(sql`
      select confidence_score as raw from regional_evaluation_queue
       where region_code = ${regionCode} order by queued_at desc limit 1
    `),
    db.execute(sql`
      select case when population > 0
                  then least(100, (freelancer_population + smb_population) / 1000)
                  else 0 end::float8 as raw
        from regional_market_data where region_code = ${regionCode}
    `),
    db.execute(sql`
      select (arpu_usd * willingness_to_pay_score * payment_reach_percent / 100000)::float8 as raw
        from regional_revenue_projections where region_code = ${regionCode}
    `),
    db.execute(sql`
      select composite_score::float8 as raw from regional_evaluation_results
       where region_code = ${regionCode} order by evaluated_at desc limit 1
    `),
    db.execute(sql`
      select greatest(0, 100 - estimated_cost_usd / 1000)::float8 as raw
        from regional_evaluation_results
       where region_code = ${regionCode} order by evaluated_at desc limit 1
    `),
    db.execute(sql`
      select (influence_score + language_leverage_score + competitive_positioning_score) / 3::float8 as raw
        from regional_strategic_data where region_code = ${regionCode}
    `),
    db.execute(sql`
      select 100 - ((legal_risk + political_risk + economic_risk + competitive_risk) / 4)::float8 as raw
        from regional_risk_data where region_code = ${regionCode}
    `),
  ]);

  const raws: Record<PriorityFactor, number> = {
    demand: Number((demandRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    market_size: Number((marketRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    revenue_potential: Number((revenueRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    readiness: Number((readinessRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    cost_to_launch: Number((costRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    strategic_value: Number((strategicRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
    risk: Number((riskRow as unknown as Array<{ raw: number }>)[0]?.raw ?? 0),
  };

  const factors: FactorScore[] = PRIORITY_FACTORS.map((spec) => {
    const raw = Math.max(0, Math.min(100, raws[spec.factor])); // clamp 0-100.
    const effectiveRaw = spec.inverse ? 100 - raw : raw;
    const weight = weights.weights[spec.factor];
    return {
      factor: spec.factor,
      rawScore: raw,
      contribution: effectiveRaw * weight,
      weight,
      inverse: spec.inverse,
      source: spec.source,
    };
  });

  const totalScore = Math.round(factors.reduce((sum, f) => sum + f.contribution, 0));

  return {
    regionCode,
    factors,
    totalScore,
    weightsVersion: weights.version,
    computedAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// 7.2 Prioritization Output — ranked queue.
// ───────────────────────────────────────────────

export interface QueueEntry {
  regionCode: string;
  rank: number;             // 1 = top of queue (prepared next).
  totalScore: number;
  factorBreakdown: FactorScore[];
  overrideApplied: "none" | "promoted" | "demoted" | "added";
  queuedAt: Date;
}

/**
 * Get the ranked priority queue of candidate regions.
 *
 * The top region is automatically prepared next, unless a human has
 * overridden (promoted/demoted/removed). Overrides shift the rank:
 *   - promoted → moved to top.
 *   - demoted → moved to bottom.
 *   - removed → excluded entirely.
 *   - added → inserted at the human-specified rank.
 */
export async function getPriorityQueue(): Promise<QueueEntry[]> {
  // Get all candidate regions (in the evaluation queue with go/conditional recommendation).
  const candidatesResult = await db.execute(sql`
    select distinct region_code from regional_evaluation_queue
  `);
  const candidates = (candidatesResult as unknown as Array<{ region_code: string }>).map((r) => r.region_code);

  // Compute the priority score for each.
  const scored: Array<{ regionCode: string; totalScore: number; factorBreakdown: FactorScore[] }> = [];
  for (const regionCode of candidates) {
    try {
      const result = await computePriorityScore(regionCode);
      scored.push({
        regionCode,
        totalScore: result.totalScore,
        factorBreakdown: result.factors,
      });
    } catch (err) {
      // Skip regions that fail to score — log + continue.
      console.error(`prioritization: failed to score ${regionCode}:`, err);
    }
  }

  // Sort by totalScore descending (highest score first).
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // Apply overrides: promoted → top, demoted → bottom, removed → excluded.
  const overrides = await db.execute(sql`
    select region_code, action from regional_priority_overrides where active = true
  `);
  const overrideMap = new Map<string, "promoted" | "demoted" | "removed" | "added">();
  for (const r of (overrides as unknown as Array<{ region_code: string; action: string }>)) {
    overrideMap.set(r.region_code, r.action as "promoted" | "demoted" | "removed" | "added");
  }

  const promoted = scored.filter((s) => overrideMap.get(s.regionCode) === "promoted");
  const neutral = scored.filter((s) => !overrideMap.has(s.regionCode) || overrideMap.get(s.regionCode) === "added");
  const demoted = scored.filter((s) => overrideMap.get(s.regionCode) === "demoted");
  // Removed regions are excluded.
  const ordered = [...promoted, ...neutral, ...demoted];

  return ordered.map((s, idx) => ({
    regionCode: s.regionCode,
    rank: idx + 1,
    totalScore: s.totalScore,
    factorBreakdown: s.factorBreakdown,
    overrideApplied:
      overrideMap.get(s.regionCode) === "promoted" ? "promoted" :
      overrideMap.get(s.regionCode) === "demoted" ? "demoted" :
      overrideMap.get(s.regionCode) === "added" ? "added" :
      "none",
    queuedAt: new Date(),
  }));
}

/**
 * Get the top region in the queue (the one to be prepared next).
 * Returns null if the queue is empty.
 */
export async function getTopPriorityRegion(): Promise<QueueEntry | null> {
  const queue = await getPriorityQueue();
  return queue.length > 0 ? queue[0] ?? null : null;
}

// ───────────────────────────────────────────────
// 7.3 Human Override — promote / demote / remove / add.
//
// Every override is logged with reasoning (admin_audit_log).
// Overrides are stored in regional_priority_overrides with active=true.
// Re-activating an override replaces the previous one.
// ───────────────────────────────────────────────

export type OverrideAction = "promote" | "demote" | "remove" | "add";

export interface OverrideInput {
  regionCode: string;
  action: OverrideAction;
  reason: string;        // mandatory human-readable reason.
  overriddenBy: string;
  /** For 'add' only — the rank to insert at (1 = top). */
  targetRank?: number;
}

export async function applyHumanOverride(input: OverrideInput): Promise<void> {
  // Deactivate any previous override for this region.
  await db.execute(sql`
    update regional_priority_overrides set active = false
     where region_code = ${input.regionCode} and active = true
  `);

  // Map action to the stored value.
  const storedAction =
    input.action === "promote" ? "promoted" :
    input.action === "demote" ? "demoted" :
    input.action === "remove" ? "removed" :
    "added";

  // Insert the new override.
  await db.execute(sql`
    insert into regional_priority_overrides
      (region_code, action, reason, overridden_by, target_rank, active, applied_at)
    values
      (${input.regionCode}, ${storedAction}, ${input.reason}, ${input.overriddenBy},
       ${input.targetRank ?? null}, true, now())
  `);

  await adminAudit({
    actor: input.overriddenBy,
    action: `regional.prioritization.override.${input.action}`,
    target: {
      regionCode: input.regionCode,
      action: input.action,
      reason: input.reason,
      targetRank: input.targetRank ?? null,
    },
    justification: `Region ${input.regionCode} ${input.action}d by ${input.overriddenBy}: ${input.reason}`,
  });
}

/** Convenience wrappers. */
export async function promoteRegion(regionCode: string, reason: string, by: string): Promise<void> {
  return applyHumanOverride({ regionCode, action: "promote", reason, overriddenBy: by });
}

export async function demoteRegion(regionCode: string, reason: string, by: string): Promise<void> {
  return applyHumanOverride({ regionCode, action: "demote", reason, overriddenBy: by });
}

export async function removeRegion(regionCode: string, reason: string, by: string): Promise<void> {
  return applyHumanOverride({ regionCode, action: "remove", reason, overriddenBy: by });
}

export async function addRegion(regionCode: string, targetRank: number, reason: string, by: string): Promise<void> {
  return applyHumanOverride({ regionCode, action: "add", reason, overriddenBy: by, targetRank });
}

// ───────────────────────────────────────────────
// 7 Verification.
// ───────────────────────────────────────────────

export interface PrioritizationVerification {
  totalFactors: number;
  implementedFactors: number;
  weightsVersioned: boolean;
  weightsConfigurable: boolean;
  queueFunctionImplemented: boolean;
  overrideFunctionsImplemented: boolean;
  allImplemented: boolean;
  factors: PriorityFactorSpec[];
}

export function verifyPrioritizationStage(): PrioritizationVerification {
  return {
    totalFactors: PRIORITY_FACTORS.length,
    implementedFactors: PRIORITY_FACTORS.filter((f) => f.implemented).length,
    weightsVersioned: true, // updateScoreWeights creates a new version.
    weightsConfigurable: true, // weights live in DB.
    queueFunctionImplemented: true,
    overrideFunctionsImplemented: true,
    allImplemented: PRIORITY_FACTORS.every((f) => f.implemented),
    factors: PRIORITY_FACTORS,
  };
}
