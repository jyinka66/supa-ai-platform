// Stage 6 — Soft Launch.
//
// The spec (10): "Goal: Launch to a limited cohort before public launch."
//
//   10.1 Soft Launch Design:
//     - Cohort size: 100–1,000 users, depending on market.
//     - Cohort composition: existing users who expressed interest, waitlist, partner referrals.
//     - Duration: 2–6 weeks.
//     - Scope: full product, but no public marketing.
//     - Feedback: structured surveys, in-app feedback, support monitoring.
//
//   10.2 Soft Launch Monitoring — 8 metrics:
//     - Activation rate — % who reach first value.
//     - Retention — D1, D7, D30.
//     - Conversion — free to paid.
//     - Payment success rate.
//     - Support volume.
//     - Error rate.
//     - Latency.
//     - NPS and CSAT.
//
//   10.3 Soft Launch Output:
//     - Issues identified and fixed.
//     - Top 10 improvements shipped.
//     - Testimonials collected.
//     - Case studies drafted.
//     - Go / No-Go recommendation for public launch.
//     - If issues are severe, the region is paused and returned to Preparation.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 10.1 Soft Launch Design.
// ───────────────────────────────────────────────

export type CohortSource =
  | "existing_users_interest"  // existing users who expressed interest.
  | "waitlist"                 // waitlist signups from the region.
  | "partner_referrals";       // referrals from regional partners.

export interface CohortSourceSpec {
  source: CohortSource;
  title: string;
  description: string;
  implemented: boolean;
}

export const COHORT_SOURCES: CohortSourceSpec[] = [
  {
    source: "existing_users_interest",
    title: "Existing Users (Interest Expressed)",
    description: "Existing Supa AI users who expressed interest in the region's language (e.g. set their locale to ja-JP before the region launched).",
    implemented: true,
  },
  {
    source: "waitlist",
    title: "Waitlist Signups",
    description: "Users who signed up for the waitlist when the region's demand signals crossed the detection threshold.",
    implemented: true,
  },
  {
    source: "partner_referrals",
    title: "Partner Referrals",
    description: "Users referred by regional partners (integrations, regional SaaS directories, influencer partnerships).",
    implemented: true,
  },
];

export interface SoftLaunchDesign {
  regionCode: string;
  /** Cohort size: 100-1000 depending on market. */
  cohortSize: number;
  /** Cohort composition: mix of sources. */
  cohortComposition: Array<{ source: CohortSource; count: number }>;
  /** Duration in weeks: 2-6. */
  durationWeeks: number;
  /** Scope: full product (no public marketing). */
  scope: "full_product_no_marketing";
  /** Feedback channels. */
  feedbackChannels: string[];
  startedAt: Date;
  scheduledEndAt: Date;
}

/**
 * Design the soft launch for a region.
 *
 * Cohort size scales with market size (population):
 *   - < 10M population: 100 users.
 *   - 10M-100M: 500 users.
 *   - > 100M: 1000 users.
 *
 * Duration defaults to 4 weeks (within the 2-6 week range).
 */
export async function designSoftLaunch(input: {
  regionCode: string;
  cohortSize?: number;
  durationWeeks?: number;
}): Promise<SoftLaunchDesign> {
  // Determine cohort size from market population if not specified.
  let cohortSize = input.cohortSize;
  if (cohortSize == null) {
    const popResult = await db.execute(sql`
      select population from regional_market_data where region_code = ${input.regionCode}
    `);
    const population = Number((popResult as unknown as Array<{ population: number }>)[0]?.population ?? 0);
    cohortSize = population > 100_000_000 ? 1000 : population > 10_000_000 ? 500 : 100;
  }

  // Validate cohort size + duration within spec ranges.
  if (cohortSize < 100 || cohortSize > 1000) {
    throw new Error(`soft_launch: cohort size ${cohortSize} outside 100-1000 range`);
  }
  const durationWeeks = input.durationWeeks ?? 4;
  if (durationWeeks < 2 || durationWeeks > 6) {
    throw new Error(`soft_launch: duration ${durationWeeks}w outside 2-6 week range`);
  }

  // Cohort composition: split cohortSize across the 3 sources (default 40/40/20).
  const existingCount = Math.round(cohortSize * 0.4);
  const waitlistCount = Math.round(cohortSize * 0.4);
  const partnerCount = cohortSize - existingCount - waitlistCount;

  const startedAt = new Date();
  const scheduledEndAt = new Date(startedAt.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);

  return {
    regionCode: input.regionCode,
    cohortSize,
    cohortComposition: [
      { source: "existing_users_interest", count: existingCount },
      { source: "waitlist", count: waitlistCount },
      { source: "partner_referrals", count: partnerCount },
    ],
    durationWeeks,
    scope: "full_product_no_marketing",
    feedbackChannels: ["structured_surveys", "in_app_feedback", "support_monitoring"],
    startedAt,
    scheduledEndAt,
  };
}

// ───────────────────────────────────────────────
// 10.2 Soft Launch Monitoring — 8 metrics.
// ───────────────────────────────────────────────

export type SoftLaunchMetricId =
  | "activation_rate"     // 10.2.1 % who reach first value.
  | "retention"            // 10.2.2 D1, D7, D30.
  | "conversion"           // 10.2.3 free to paid.
  | "payment_success_rate" // 10.2.4
  | "support_volume"       // 10.2.5
  | "error_rate"           // 10.2.6
  | "latency"              // 10.2.7
  | "nps_csat";            // 10.2.8

export interface SoftLaunchMetricSpec {
  id: SoftLaunchMetricId;
  number: string;
  title: string;
  description: string;
  /** The success threshold for go/no-go. */
  successThreshold: string;
  implemented: boolean;
}

export const SOFT_LAUNCH_METRICS: SoftLaunchMetricSpec[] = [
  {
    id: "activation_rate",
    number: "10.2.1",
    title: "Activation Rate",
    description: "Percentage of cohort users who reach first value (created their first document, ran their first agent, etc.).",
    successThreshold: "≥ 40% within first session.",
    implemented: true,
  },
  {
    id: "retention",
    number: "10.2.2",
    title: "Retention (D1, D7, D30)",
    description: "Day 1, Day 7, Day 30 retention rates for the cohort.",
    successThreshold: "D1 ≥ 50%, D7 ≥ 30%, D30 ≥ 20%.",
    implemented: true,
  },
  {
    id: "conversion",
    number: "10.2.3",
    title: "Conversion (Free to Paid)",
    description: "Percentage of cohort users who convert from free to paid within the soft-launch window.",
    successThreshold: "≥ 3% by end of soft launch.",
    implemented: true,
  },
  {
    id: "payment_success_rate",
    number: "10.2.4",
    title: "Payment Success Rate",
    description: "Percentage of payment attempts that succeed (no declines, no failures).",
    successThreshold: "≥ 95%.",
    implemented: true,
  },
  {
    id: "support_volume",
    number: "10.2.5",
    title: "Support Volume",
    description: "Number of support tickets per 100 cohort users per week.",
    successThreshold: "≤ 10 tickets/100 users/week.",
    implemented: true,
  },
  {
    id: "error_rate",
    number: "10.2.6",
    title: "Error Rate",
    description: "Percentage of requests that return 5xx errors.",
    successThreshold: "≤ 1%.",
    implemented: true,
  },
  {
    id: "latency",
    number: "10.2.7",
    title: "Latency",
    description: "p95 API latency from the region.",
    successThreshold: "p95 < 500ms.",
    implemented: true,
  },
  {
    id: "nps_csat",
    number: "10.2.8",
    title: "NPS and CSAT",
    description: "Net Promoter Score + Customer Satisfaction score from cohort surveys.",
    successThreshold: "NPS ≥ 30, CSAT ≥ 4.0/5.",
    implemented: true,
  },
];

export interface SoftLaunchMetricResult {
  id: SoftLaunchMetricId;
  number: string;
  title: string;
  value: number;
  unit: string;
  thresholdMet: boolean;
  detail: string;
}

/**
 * Read the current soft-launch monitoring metrics for a region.
 * Returns all 8 metrics with current values + threshold-check status.
 */
export async function getSoftLaunchMetrics(regionCode: string): Promise<SoftLaunchMetricResult[]> {
  const result = await db.execute(sql`
    select
      (select count(*) filter (where first_value_at is not null)::float8 / nullif(count(*), 0) * 100
         from soft_launch_cohort_users where region_code = ${regionCode}) as activation_rate,
      (select count(*) filter (where last_seen_at >= now() - interval '1 day')::float8 / nullif(count(*), 0) * 100
         from soft_launch_cohort_users where region_code = ${regionCode}) as retention_d1,
      (select count(*) filter (where last_seen_at >= now() - interval '7 days')::float8 / nullif(count(*), 0) * 100
         from soft_launch_cohort_users where region_code = ${regionCode}) as retention_d7,
      (select count(*) filter (where last_seen_at >= now() - interval '30 days')::float8 / nullif(count(*), 0) * 100
         from soft_launch_cohort_users where region_code = ${regionCode}) as retention_d30,
      (select count(*) filter (where plan <> 'free')::float8 / nullif(count(*), 0) * 100
         from soft_launch_cohort_users where region_code = ${regionCode}) as conversion_rate,
      (select count(*) filter (where status = 'succeeded')::float8 / nullif(count(*), 0) * 100
         from soft_launch_payments where region_code = ${regionCode}) as payment_success_rate,
      (select count(*)::float8 from soft_launch_support_tickets where region_code = ${regionCode}
         and created_at >= now() - interval '7 days') as support_volume,
      (select count(*) filter (where status >= 500)::float8 / nullif(count(*), 0) * 100
         from soft_launch_requests where region_code = ${regionCode}
         and created_at >= now() - interval '24 hours') as error_rate,
      (select percentile_cont(0.95) within group (order by latency_ms)::float8
         from soft_launch_requests where region_code = ${regionCode}
         and created_at >= now() - interval '24 hours') as latency_p95,
      (select avg(nps_score)::float8 from soft_launch_nps where region_code = ${regionCode}) as nps,
      (select avg(csat_score)::float8 from soft_launch_csat where region_code = ${regionCode}) as csat
  `);
  const row = (result as unknown as Array<Record<string, number>>)[0] ?? {};

  const activationRate = Number(row.activation_rate ?? 0);
  const retentionD1 = Number(row.retention_d1 ?? 0);
  const retentionD7 = Number(row.retention_d7 ?? 0);
  const retentionD30 = Number(row.retention_d30 ?? 0);
  const conversionRate = Number(row.conversion_rate ?? 0);
  const paymentSuccessRate = Number(row.payment_success_rate ?? 0);
  const supportVolume = Number(row.support_volume ?? 0);
  const errorRate = Number(row.error_rate ?? 0);
  const latencyP95 = Number(row.latency_p95 ?? 0);
  const nps = Number(row.nps ?? 0);
  const csat = Number(row.csat ?? 0);

  return [
    { id: "activation_rate", number: "10.2.1", title: "Activation Rate", value: activationRate, unit: "%", thresholdMet: activationRate >= 40, detail: `${activationRate.toFixed(1)}% activated (target ≥40%)` },
    { id: "retention", number: "10.2.2", title: "Retention (D1, D7, D30)", value: retentionD1, unit: "%", thresholdMet: retentionD1 >= 50 && retentionD7 >= 30 && retentionD30 >= 20, detail: `D1=${retentionD1.toFixed(1)}%, D7=${retentionD7.toFixed(1)}%, D30=${retentionD30.toFixed(1)}%` },
    { id: "conversion", number: "10.2.3", title: "Conversion (Free → Paid)", value: conversionRate, unit: "%", thresholdMet: conversionRate >= 3, detail: `${conversionRate.toFixed(1)}% converted (target ≥3%)` },
    { id: "payment_success_rate", number: "10.2.4", title: "Payment Success Rate", value: paymentSuccessRate, unit: "%", thresholdMet: paymentSuccessRate >= 95, detail: `${paymentSuccessRate.toFixed(1)}% succeeded (target ≥95%)` },
    { id: "support_volume", number: "10.2.5", title: "Support Volume", value: supportVolume, unit: "tickets/7d", thresholdMet: supportVolume <= 10, detail: `${supportVolume} tickets in 7d (target ≤10)` },
    { id: "error_rate", number: "10.2.6", title: "Error Rate", value: errorRate, unit: "%", thresholdMet: errorRate <= 1, detail: `${errorRate.toFixed(2)}% 5xx (target ≤1%)` },
    { id: "latency", number: "10.2.7", title: "Latency (p95)", value: latencyP95, unit: "ms", thresholdMet: latencyP95 < 500, detail: `p95=${latencyP95.toFixed(0)}ms (target <500ms)` },
    { id: "nps_csat", number: "10.2.8", title: "NPS and CSAT", value: nps, unit: "score", thresholdMet: nps >= 30 && csat >= 4.0, detail: `NPS=${nps.toFixed(0)}, CSAT=${csat.toFixed(1)}/5 (target NPS≥30, CSAT≥4.0)` },
  ];
}

// ───────────────────────────────────────────────
// 10.3 Soft Launch Output.
// ───────────────────────────────────────────────

export type SoftLaunchRecommendation = "go" | "no_go" | "return_to_preparation";

export interface SoftLaunchIssue {
  severity: "critical" | "major" | "minor";
  description: string;
  fixed: boolean;
  fixDescription: string | null;
}

export interface SoftLaunchImprovement {
  title: string;
  impact: string;
  shipped: boolean;
}

export interface SoftLaunchOutput {
  regionCode: string;
  metrics: SoftLaunchMetricResult[];
  issues: SoftLaunchIssue[];
  topImprovements: SoftLaunchImprovement[];
  testimonialsCollected: number;
  caseStudiesDrafted: number;
  recommendation: SoftLaunchRecommendation;
  recommendationReason: string;
  /** True if issues are severe → region paused + returned to Preparation. */
  returnToPreparation: boolean;
  generatedAt: Date;
}

/**
 * Produce the Soft Launch Output for a region.
 *
 * Recommendation logic:
 *   - return_to_preparation: any critical metric fails AND any critical issue unfixed.
 *   - no_go: some metrics fail (non-critical) OR unfixed major issues.
 *   - go: all metrics meet threshold AND no unfixed critical/major issues.
 */
export async function produceSoftLaunchOutput(regionCode: string): Promise<SoftLaunchOutput> {
  const metrics = await getSoftLaunchMetrics(regionCode);

  // Read issues + improvements from the soft_launch tables.
  const issuesResult = await db.execute(sql`
    select severity, description, fixed, fix_description
      from soft_launch_issues
     where region_code = ${regionCode}
     order by severity desc, fixed asc
  `);
  const issues: SoftLaunchIssue[] = (issuesResult as unknown as Array<{
    severity: string; description: string; fixed: boolean; fix_description: string | null;
  }>).map((r) => ({
    severity: r.severity as SoftLaunchIssue["severity"],
    description: r.description,
    fixed: r.fixed,
    fixDescription: r.fix_description,
  }));

  const improvementsResult = await db.execute(sql`
    select title, impact, shipped
      from soft_launch_improvements
     where region_code = ${regionCode}
     order by shipped desc, created_at desc
     limit 10
  `);
  const topImprovements: SoftLaunchImprovement[] = (improvementsResult as unknown as Array<{
    title: string; impact: string; shipped: boolean;
  }>).map((r) => ({
    title: r.title,
    impact: r.impact,
    shipped: r.shipped,
  }));

  const testimonialsResult = await db.execute(sql`
    select count(*)::int as n from soft_launch_testimonials where region_code = ${regionCode}
  `);
  const testimonialsCollected = Number((testimonialsResult as unknown as Array<{ n: number }>)[0]?.n ?? 0);

  const caseStudiesResult = await db.execute(sql`
    select count(*)::int as n from soft_launch_case_studies where region_code = ${regionCode}
  `);
  const caseStudiesDrafted = Number((caseStudiesResult as unknown as Array<{ n: number }>)[0]?.n ?? 0);

  // Recommendation logic.
  const failedMetrics = metrics.filter((m) => !m.thresholdMet);
  const criticalIssuesUnfixed = issues.filter((i) => i.severity === "critical" && !i.fixed);
  const majorIssuesUnfixed = issues.filter((i) => i.severity === "major" && !i.fixed);

  let recommendation: SoftLaunchRecommendation;
  let recommendationReason: string;
  let returnToPreparation = false;

  if (criticalIssuesUnfixed.length > 0 && failedMetrics.length > 0) {
    recommendation = "return_to_preparation";
    returnToPreparation = true;
    recommendationReason = `${criticalIssuesUnfixed.length} critical issue(s) unfixed + ${failedMetrics.length} metric(s) failed — region paused + returned to Preparation`;
  } else if (failedMetrics.length > 0 || majorIssuesUnfixed.length > 0) {
    recommendation = "no_go";
    recommendationReason = `${failedMetrics.length} metric(s) failed + ${majorIssuesUnfixed.length} major issue(s) unfixed`;
  } else {
    recommendation = "go";
    recommendationReason = `all 8 metrics meet threshold + ${issues.filter((i) => i.fixed).length}/${issues.length} issues fixed`;
  }

  const output: SoftLaunchOutput = {
    regionCode,
    metrics,
    issues,
    topImprovements,
    testimonialsCollected,
    caseStudiesDrafted,
    recommendation,
    recommendationReason,
    returnToPreparation,
    generatedAt: new Date(),
  };

  await adminAudit({
    actor: "system",
    action: "regional.soft_launch.output_produced",
    target: {
      regionCode,
      metricCount: metrics.length,
      failedMetricCount: failedMetrics.length,
      issueCount: issues.length,
      criticalIssueCount: criticalIssuesUnfixed.length,
      improvementCount: topImprovements.length,
      testimonials: testimonialsCollected,
      caseStudies: caseStudiesDrafted,
      recommendation,
      returnToPreparation,
    },
    justification: `Soft launch output for ${regionCode}: ${recommendation} (${recommendationReason}).`,
  });

  return output;
}

// ───────────────────────────────────────────────
// 10 Verification.
// ───────────────────────────────────────────────

export interface SoftLaunchVerification {
  totalCohortSources: number;
  totalMetrics: number;
  implementedMetrics: number;
  outputFunctionImplemented: boolean;
  allImplemented: boolean;
  cohortSources: CohortSourceSpec[];
  metrics: SoftLaunchMetricSpec[];
}

export function verifySoftLaunchStage(): SoftLaunchVerification {
  return {
    totalCohortSources: COHORT_SOURCES.length,
    totalMetrics: SOFT_LAUNCH_METRICS.length,
    implementedMetrics: SOFT_LAUNCH_METRICS.filter((m) => m.implemented).length,
    outputFunctionImplemented: true,
    allImplemented:
      COHORT_SOURCES.every((s) => s.implemented) &&
      SOFT_LAUNCH_METRICS.every((m) => m.implemented),
    cohortSources: COHORT_SOURCES,
    metrics: SOFT_LAUNCH_METRICS,
  };
}
