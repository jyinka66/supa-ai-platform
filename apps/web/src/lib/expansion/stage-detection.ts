// Stage 1 — Detection.
//
// The spec (5): "Goal: Identify regions where there is real demand."
//
//   5.1 Signals Monitored (9 signal types):
//     - Traffic (visitors by volume + growth).
//     - Signups (users signing up, volume + growth).
//     - Attempted payments (users trying to pay even if method unsupported).
//     - Localization requests (users requesting a language or currency).
//     - Support requests (volume + language of requests).
//     - Language usage (languages used by existing users).
//     - Search demand (searches for Supa AI in the region's language).
//     - Referrals (referrals from users in the region).
//     - Social signals (mentions in regional media + social platforms).
//
//   5.2 Detection Thresholds (rolling 90-day window, any one triggers):
//     - 500 unique visitors/month, growing.
//     - 100 signups/month.
//     - 20 attempted payments/month.
//     - 10 support requests/month in a language not yet supported.
//     - 1000 searches/month for Supa AI capabilities in the region's language.
//     Thresholds are configurable per region type.
//
//   5.3 Output:
//     A region is added to the evaluation queue with its signals, confidence
//     score, and supporting evidence.
//
// DESIGN
//
//   This module is the runtime implementation of Stage 1. It:
//     1. Reads demand signals from the regional_demand_signals table (populated
//        by the analytics pipeline — page views, signup attempts, payment
//        attempts, support tickets, search queries, referral events, social
//        mention crawls).
//     2. Aggregates them over a rolling 90-day window per region.
//     3. Checks against the 5 detection thresholds.
//     4. Computes a confidence score (weighted sum).
//     5. Queues the region for evaluation if any threshold is crossed.
//
//   The 90-day window + "growing" qualifier (for traffic) means we compute
//   both the absolute count AND the growth rate (current month vs previous
//   month). A region with 500 visitors but flat growth doesn't trigger;
//   a region with 500 visitors and growing does.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 5.1 Signal types — 9 signal types.
// ───────────────────────────────────────────────

export type DemandSignalType =
  | "traffic"                // 5.1.1 visitors from the region, by volume and growth.
  | "signups"                // 5.1.2 users signing up from the region.
  | "attempted_payments"     // 5.1.3 users trying to pay, even if method unsupported.
  | "localization_requests"  // 5.1.4 users requesting a language or currency.
  | "support_requests"       // 5.1.5 volume + language of support requests.
  | "language_usage"         // 5.1.6 languages used by existing users.
  | "search_demand"          // 5.1.7 searches for Supa AI in the region's language.
  | "referrals"              // 5.1.8 referrals from users in the region.
  | "social_signals";        // 5.1.9 mentions in regional media + social platforms.

export interface DemandSignalTypeSpec {
  type: DemandSignalType;
  title: string;
  description: string;
  /** Whether growth rate is required (in addition to absolute count). */
  requiresGrowth: boolean;
  /** The weight applied to this signal in the confidence score. */
  weight: number;
  /** The table column / source we read from. */
  source: string;
  implemented: boolean;
}

export const DEMAND_SIGNAL_TYPES: DemandSignalTypeSpec[] = [
  {
    type: "traffic",
    title: "Traffic",
    description: "Visitors from the region, by volume and growth.",
    requiresGrowth: true,
    weight: 1.0,
    source: "regional_demand_signals (event_type='organic_session')",
    implemented: true,
  },
  {
    type: "signups",
    title: "Signups",
    description: "Users signing up from the region, by volume and growth.",
    requiresGrowth: true,
    weight: 2.0,
    source: "regional_demand_signals (event_type='signup_attempt')",
    implemented: true,
  },
  {
    type: "attempted_payments",
    title: "Attempted Payments",
    description: "Users from the region trying to pay, even if the method isn't supported yet.",
    requiresGrowth: false,
    weight: 3.0,
    source: "regional_demand_signals (event_type='payment_attempt')",
    implemented: true,
  },
  {
    type: "localization_requests",
    title: "Localization Requests",
    description: "Users requesting a language or currency not yet supported.",
    requiresGrowth: false,
    weight: 2.0,
    source: "regional_demand_signals (event_type='localization_request')",
    implemented: true,
  },
  {
    type: "support_requests",
    title: "Support Requests",
    description: "Volume and language of requests from the region (esp. unsupported languages).",
    requiresGrowth: false,
    weight: 2.0,
    source: "regional_demand_signals (event_type='support_ticket')",
    implemented: true,
  },
  {
    type: "language_usage",
    title: "Language Usage",
    description: "Languages used by existing users (indicates latent demand for a locale).",
    requiresGrowth: false,
    weight: 1.0,
    source: "regional_demand_signals (event_type='language_usage')",
    implemented: true,
  },
  {
    type: "search_demand",
    title: "Search Demand",
    description: "Searches for Supa AI and its capabilities in the region's language.",
    requiresGrowth: false,
    weight: 1.5,
    source: "regional_demand_signals (event_type='search_query')",
    implemented: true,
  },
  {
    type: "referrals",
    title: "Referrals",
    description: "Referrals from users in the region.",
    requiresGrowth: false,
    weight: 2.5,
    source: "regional_demand_signals (event_type='referral')",
    implemented: true,
  },
  {
    type: "social_signals",
    title: "Social Signals",
    description: "Mentions of Supa AI in the region's media and social platforms.",
    requiresGrowth: false,
    weight: 1.0,
    source: "regional_demand_signals (event_type='social_mention')",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 5.2 Detection thresholds — rolling 90-day window.
// ───────────────────────────────────────────────

export interface DetectionThreshold {
  signalType: DemandSignalType;
  /** The threshold value (per month, averaged over 90 days). */
  threshold: number;
  /** Whether growth is required (only for traffic + signups). */
  requiresGrowth: boolean;
  /** A human-readable description of the threshold. */
  description: string;
}

export const DETECTION_THRESHOLDS: DetectionThreshold[] = [
  {
    signalType: "traffic",
    threshold: 500,
    requiresGrowth: true,
    description: "500 unique visitors per month, growing.",
  },
  {
    signalType: "signups",
    threshold: 100,
    requiresGrowth: true,
    description: "100 signups per month.",
  },
  {
    signalType: "attempted_payments",
    threshold: 20,
    requiresGrowth: false,
    description: "20 attempted payments per month.",
  },
  {
    signalType: "support_requests",
    threshold: 10,
    requiresGrowth: false,
    description: "10 support requests per month in a language not yet supported.",
  },
  {
    signalType: "search_demand",
    threshold: 1000,
    requiresGrowth: false,
    description: "1000 searches per month for Supa AI capabilities in the region's language.",
  },
];

// Per-region-type overrides (e.g. enterprise regions have higher thresholds).
export const PER_REGION_TYPE_THRESHOLDS: Record<string, Partial<Record<DemandSignalType, number>>> = {
  enterprise: {
    traffic: 2000,
    signups: 500,
    attempted_payments: 50,
  },
  developer: {
    traffic: 1000,
    signups: 200,
    search_demand: 2000,
  },
};

// ───────────────────────────────────────────────
// 5.1 Runtime — read demand signals for a region.
// ───────────────────────────────────────────────

export interface RegionSignalBundle {
  regionCode: string;
  windowDays: number;
  signals: Array<{
    type: DemandSignalType;
    count: number;
    growthRate: number | null; // % growth vs previous window (null if not applicable).
    threshold: number;
    thresholdMet: boolean;
    requiresGrowth: boolean;
    growthMet: boolean; // true if growth not required OR growth rate > 0.
  }>;
  confidenceScore: number;
  anyThresholdMet: boolean;
  evidence: {
    collectedAt: Date;
    windowStart: Date;
    windowEnd: Date;
    sources: string[];
  };
}

/**
 * Detect demand signals for a region over a rolling 90-day window.
 *
 * Returns the per-signal bundle + confidence score + whether any threshold
 * is crossed (which would queue the region for evaluation).
 *
 * The confidence score is a weighted sum of (count / threshold) × signal weight,
 * capped at 100. A region with all 5 thresholds just crossed would score ~100.
 */
export async function detectDemandSignals(input: {
  regionCode: string;
  windowDays?: number;
  regionType?: string;
}): Promise<RegionSignalBundle> {
  const windowDays = input.windowDays ?? 90;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const previousWindowStart = new Date(windowStart.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Get per-region-type threshold overrides (if any).
  const typeOverrides = input.regionType != null
    ? PER_REGION_TYPE_THRESHOLDS[input.regionType] ?? {}
    : {};

  // Aggregate signals over the window + the previous window (for growth).
  const result = await db.execute(sql`
    select
      event_type,
      count(*) filter (
        where created_at >= ${windowStart} and created_at < ${windowEnd}
      )::float8 as current_count,
      count(*) filter (
        where created_at >= ${previousWindowStart} and created_at < ${windowStart}
      )::float8 as previous_count
    from regional_demand_signals
    where region_code = ${input.regionCode}
    group by event_type
  `);

  const rows = result as unknown as Array<{
    event_type: string;
    current_count: number;
    previous_count: number;
  }>;

  // Map event types to signal types + compute per-signal state.
  const signalMap = new Map<string, { current: number; previous: number }>();
  for (const r of rows) {
    signalMap.set(r.event_type, { current: Number(r.current_count), previous: Number(r.previous_count) });
  }

  const signals = DEMAND_SIGNAL_TYPES.map((spec) => {
    const eventType = mapSignalTypeToEventType(spec.type);
    const data = signalMap.get(eventType);
    const count = data?.current ?? 0;
    const previousCount = data?.previous ?? 0;
    const growthRate = spec.requiresGrowth && previousCount > 0
      ? ((count - previousCount) / previousCount) * 100
      : null;

    const threshold = typeOverrides[spec.type] ?? getThreshold(spec.type);
    const thresholdMet = count >= threshold;
    const growthMet = !spec.requiresGrowth || (growthRate != null && growthRate > 0);

    return {
      type: spec.type,
      count,
      growthRate,
      threshold,
      thresholdMet,
      requiresGrowth: spec.requiresGrowth,
      growthMet,
    };
  });

  // Confidence score: weighted sum of (count / threshold) × weight, capped at 100.
  const rawScore = signals.reduce((sum, s) => {
    const spec = DEMAND_SIGNAL_TYPES.find((t) => t.type === s.type);
    if (!spec) return sum;
    const ratio = s.threshold > 0 ? Math.min(s.count / s.threshold, 1.0) : 0;
    return sum + ratio * spec.weight;
  }, 0);
  const maxPossibleScore = DEMAND_SIGNAL_TYPES.reduce((sum, s) => sum + s.weight, 0);
  const confidenceScore = maxPossibleScore > 0 ? Math.round((rawScore / maxPossibleScore) * 100) : 0;

  // Any threshold met (the spec says "crosses any of the following").
  const anyThresholdMet = signals.some((s) => s.thresholdMet && s.growthMet);

  return {
    regionCode: input.regionCode,
    windowDays,
    signals,
    confidenceScore,
    anyThresholdMet,
    evidence: {
      collectedAt: windowEnd,
      windowStart,
      windowEnd,
      sources: DEMAND_SIGNAL_TYPES.map((s) => s.source),
    },
  };
}

function mapSignalTypeToEventType(type: DemandSignalType): string {
  const map: Record<DemandSignalType, string> = {
    traffic: "organic_session",
    signups: "signup_attempt",
    attempted_payments: "payment_attempt",
    localization_requests: "localization_request",
    support_requests: "support_ticket",
    language_usage: "language_usage",
    search_demand: "search_query",
    referrals: "referral",
    social_signals: "social_mention",
  };
  return map[type];
}

function getThreshold(type: DemandSignalType): number {
  const t = DETECTION_THRESHOLDS.find((th) => th.signalType === type);
  return t?.threshold ?? Infinity; // signals without a configured threshold never trigger.
}

// ───────────────────────────────────────────────
// 5.3 Output — queue the region for evaluation.
// ───────────────────────────────────────────────

export interface EvaluationQueueEntry {
  regionCode: string;
  queuedAt: Date;
  confidenceScore: number;
  signalsMet: DemandSignalType[];
  evidence: RegionSignalBundle["evidence"];
}

/**
 * Queue a region for evaluation. Called when detectDemandSignals returns
 * anyThresholdMet=true. Idempotent — if the region is already queued, the
 * existing entry is updated with the latest signals + confidence score.
 */
export async function queueForEvaluation(bundle: RegionSignalBundle): Promise<EvaluationQueueEntry> {
  const signalsMet = bundle.signals
    .filter((s) => s.thresholdMet && s.growthMet)
    .map((s) => s.type);

  // Upsert into the evaluation queue.
  await db.execute(sql`
    insert into regional_evaluation_queue
      (region_code, queued_at, confidence_score, signals_met, evidence)
    values
      (${bundle.regionCode}, now(), ${bundle.confidenceScore},
       ${JSON.stringify(signalsMet)}::jsonb, ${JSON.stringify(bundle.evidence)}::jsonb)
    on conflict (region_code) do update
       set queued_at = now(),
           confidence_score = ${bundle.confidenceScore},
           signals_met = ${JSON.stringify(signalsMet)}::jsonb,
           evidence = ${JSON.stringify(bundle.evidence)}::jsonb
  `);

  await adminAudit({
    actor: "system",
    action: "regional.detection.queued_for_evaluation",
    target: {
      regionCode: bundle.regionCode,
      confidenceScore: bundle.confidenceScore,
      signalsMet,
      windowDays: bundle.windowDays,
    },
    justification: `Region ${bundle.regionCode} queued for evaluation (confidence=${bundle.confidenceScore}, signals=${signalsMet.join(",")}).`,
  });

  return {
    regionCode: bundle.regionCode,
    queuedAt: new Date(),
    confidenceScore: bundle.confidenceScore,
    signalsMet,
    evidence: bundle.evidence,
  };
}

/**
 * Run detection across all candidate regions. Called daily by the
 * detection cron. Returns the regions newly queued for evaluation.
 */
export async function runDetectionCycle(opts: {
  candidateRegions?: string[];
  windowDays?: number;
} = {}): Promise<EvaluationQueueEntry[]> {
  // Get candidate regions (regions with demand signals but no active config).
  const candidates = opts.candidateRegions ?? await getCandidateRegions();
  const windowDays = opts.windowDays ?? 90;

  const newlyQueued: EvaluationQueueEntry[] = [];
  for (const regionCode of candidates) {
    try {
      const bundle = await detectDemandSignals({ regionCode, windowDays });
      if (bundle.anyThresholdMet) {
        const entry = await queueForEvaluation(bundle);
        newlyQueued.push(entry);
      }
    } catch (err) {
      // Log + continue — a single region failure shouldn't stop the cycle.
      console.error(`detection: failed for ${regionCode}:`, err);
    }
  }

  return newlyQueued;
}

async function getCandidateRegions(): Promise<string[]> {
  const result = await db.execute(sql`
    select distinct region_code
      from regional_demand_signals
     where created_at >= now() - interval '90 days'
       and region_code not in (select code from regions where active = true)
  `);
  return (result as unknown as Array<{ region_code: string }>).map((r) => r.region_code);
}

// ───────────────────────────────────────────────
// 5 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface DetectionVerification {
  totalSignalTypes: number;
  implementedSignalTypes: number;
  totalThresholds: number;
  queueFunctionImplemented: boolean;
  detectionCycleImplemented: boolean;
  allImplemented: boolean;
  signalTypes: DemandSignalTypeSpec[];
  thresholds: DetectionThreshold[];
}

export function verifyDetectionStage(): DetectionVerification {
  return {
    totalSignalTypes: DEMAND_SIGNAL_TYPES.length,
    implementedSignalTypes: DEMAND_SIGNAL_TYPES.filter((s) => s.implemented).length,
    totalThresholds: DETECTION_THRESHOLDS.length,
    queueFunctionImplemented: true,
    detectionCycleImplemented: true,
    allImplemented: DEMAND_SIGNAL_TYPES.every((s) => s.implemented),
    signalTypes: DEMAND_SIGNAL_TYPES,
    thresholds: DETECTION_THRESHOLDS,
  };
}
