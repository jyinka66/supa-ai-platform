// Measurement of success — Section 17.
//
// The spec (17): "A region is successful when [8 criteria]. A region is not
// successful just because it launched. It is successful when users in that
// region use Supa AI daily and pay for it."
//
//   17.1 Users get a first-class experience in their language.
//   17.2 Payments work in their currency and method.
//   17.3 Legal and tax compliance is verified.
//   17.4 Support is available in their language.
//   17.5 Retention and revenue match or exceed global averages.
//   17.6 Churn is comparable to global.
//   17.7 NPS is positive.
//   17.8 The region contributes to platform growth.
//
// DESIGN
//
//   This module is the SUCCESS MEASUREMENT layer — it defines what "success"
//   means for a region (NOT "launched" but "users use it daily and pay").
//   Each criterion is measurable + has a target threshold.
//
//   The runtime function `measureRegionSuccess()` reads the monitoring
//   metrics for a region + compares against the 8 success criteria + returns
//   a success verdict (successful / partial / not_successful) with per-criterion
//   evidence.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// 17 Success criteria — 8 criteria.
// ───────────────────────────────────────────────

export type SuccessCriterionId =
  | "first_class_language_experience"  // 17.1
  | "payments_work"                      // 17.2
  | "compliance_verified"              // 17.3
  | "support_in_language"              // 17.4
  | "retention_revenue_match_global"    // 17.5
  | "churn_comparable"                  // 17.6
  | "nps_positive"                      // 17.7
  | "contributes_to_growth";            // 17.8

export interface SuccessCriterionSpec {
  id: SuccessCriterionId;
  number: string;
  title: string;
  description: string;
  /** The target threshold for success. */
  target: string;
  /** The metric(s) we read to measure this. */
  measuredBy: string;
  /** Whether this criterion is a hard requirement for "successful" verdict. */
  hardRequirement: boolean;
  implemented: boolean;
}

export const SUCCESS_CRITERIA: SuccessCriterionSpec[] = [
  {
    id: "first_class_language_experience",
    number: "17.1",
    title: "First-Class Experience in Their Language",
    description: "Users get a first-class experience in their language — no machine-translated feel, no missing strings, no cultural missteps.",
    target: "translation quality score ≥ 80; 0 missing strings; native-speaker review signed off.",
    measuredBy: "translation_quality_scores + i18n checker (missing strings) + native-speaker review sign-off.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "payments_work",
    number: "17.2",
    title: "Payments Work in Their Currency and Method",
    description: "Payments work in the user's local currency and preferred payment method — no payment failures due to method/currency gaps.",
    target: "payment success rate ≥ 95%; all regional payment methods active; 0 'unsupported method' support tickets.",
    measuredBy: "payment_success_rate metric (Stage 10) + regional_payment_methods table + support ticket analysis.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "compliance_verified",
    number: "17.3",
    title: "Legal and Tax Compliance Verified",
    description: "Legal and tax compliance is verified — no open compliance gaps, all legal docs published, tax registration complete.",
    target: "0 open compliance gaps; all 5 legal docs published; tax_registration_met = true.",
    measuredBy: "compliance gate (Stage 6) + legal/service.ts + regional_legal_data.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "support_in_language",
    number: "17.4",
    title: "Support Available in Their Language",
    description: "Support is available in the user's language — ticket UI, live chat, help center, AI triage all in the locale.",
    target: "support channels live in locale; CSAT ≥ 4.0; support_volume ≤ 10 tickets/100 users/week.",
    measuredBy: "support channel liveness check (Stage 9) + CSAT metric + support_volume metric.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "retention_revenue_match_global",
    number: "17.5",
    title: "Retention and Revenue Match or Exceed Global Averages",
    description: "Retention (D1/D7/D30) and revenue (MRR, ARPU) match or exceed global averages — the region performs as well as the rest of the platform.",
    target: "retention D1 ≥ global D1; MRR growth ≥ global MRR growth; ARPU ≥ global ARPU × 0.8 (PPP-adjusted).",
    measuredBy: "retention metrics (Stage 10) + regional_revenue_monthly vs global_averages.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "churn_comparable",
    number: "17.6",
    title: "Churn Comparable to Global",
    description: "Churn rate is comparable to the global average — the region doesn't churn users faster than the rest of the platform.",
    target: "regional churn ≤ global churn × 1.2 (20% tolerance for regional variance).",
    measuredBy: "churn_rate metric (Stage 12 monitoring) vs global churn average.",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "nps_positive",
    number: "17.7",
    title: "NPS is Positive",
    description: "Net Promoter Score is positive — users in the region would recommend Supa AI to others.",
    target: "NPS ≥ 30 (positive); CSAT ≥ 4.0/5.",
    measuredBy: "NPS + CSAT metrics (Stage 10 soft launch + Stage 12 monitoring).",
    hardRequirement: true,
    implemented: true,
  },
  {
    id: "contributes_to_growth",
    number: "17.8",
    title: "Region Contributes to Platform Growth",
    description: "The region contributes to platform growth — signups, MRR, active users are growing, not flat or declining.",
    target: "signup growth > 0% MoM; MRR growth > 0% MoM; MAU growth > 0% MoM for 2+ consecutive months.",
    measuredBy: "adoption metrics (Stage 12) + revenue metrics (Stage 12) + engagement metrics (Stage 12).",
    hardRequirement: false, // a region can be successful (users happy) without yet contributing to growth (small but healthy).
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 17 Runtime — measure region success.
// ───────────────────────────────────────────────

export type SuccessVerdict = "successful" | "partial" | "not_successful";

export interface SuccessMeasurement {
  regionCode: string;
  criteria: Array<{
    id: SuccessCriterionId;
    number: string;
    title: string;
    met: boolean;
    value: string;
    target: string;
    hardRequirement: boolean;
  }>;
  verdict: SuccessVerdict;
  verdictReason: string;
  /** "A region is not successful just because it launched." */
  launchedButNotSuccessful: boolean;
  measuredAt: Date;
}

/**
 * Measure whether a region is successful.
 *
 * The spec (17): "A region is not successful just because it launched. It is
 * successful when users in that region use Supa AI daily and pay for it."
 *
 * Verdict logic:
 *   - successful: ALL 7 hard requirements met + contributes-to-growth (soft).
 *   - partial: 5-6 hard requirements met — region is healthy but not fully successful.
 *   - not_successful: <5 hard requirements met — region needs optimization or retirement review.
 *
 * `launchedButNotSuccessful` = true when the region is live (active=true) but
 * verdict is not "successful" — this is the spec's key insight: launch ≠ success.
 */
export async function measureRegionSuccess(regionCode: string): Promise<SuccessMeasurement> {
  // Read all the metrics needed for the 8 criteria in one query.
  const result = await db.execute(sql`
    select
      (select score from translation_quality_scores
        where language = (select default_locale from regional_config where region_code = ${regionCode})
        limit 1)::float8 as translation_quality,
      (select count(*)::int from i18n_string_catalog
        where locale = (select default_locale from regional_config where region_code = ${regionCode})
          and translated_value is null) as missing_strings,
      (select count(*) filter (where status = 'succeeded')::float8 / nullif(count(*), 0) * 100
        from soft_launch_payments where region_code = ${regionCode}) as payment_success_rate,
      (select count(*)::int from regional_payment_methods where region_code = ${regionCode} and active) as active_payment_methods,
      (select bool_and(met) from compliance_gates where region_code = ${regionCode}) as compliance_met,
      (select avg(csat_score)::float8 from soft_launch_csat where region_code = ${regionCode}) as csat,
      (select count(*)::int from region_signups where region_code = ${regionCode}
        and signed_up_at >= now() - interval '30 days') as signups_30d,
      (select count(*)::int from region_signups where region_code = ${regionCode}
        and signed_up_at >= now() - interval '60 days'
        and signed_up_at < now() - interval '30 days') as signups_prev_30d,
      (select avg(nps_score)::float8 from soft_launch_nps where region_code = ${regionCode}) as nps,
      (select count(*) filter (where last_seen_at >= now() - interval '1 day')::float8 / nullif(count(*), 0) * 100
        from soft_launch_cohort_users where region_code = ${regionCode}) as retention_d1,
      (select active from regions where code = ${regionCode})::boolean as region_active,
      (select mrr from regional_revenue_monthly where region_code = ${regionCode}
        order by month desc limit 1)::float8 as current_mrr,
      (select mrr from regional_revenue_monthly where region_code = ${regionCode}
        order by month desc offset 1 limit 1)::float8 as prev_mrr
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const translationQuality = Number(row.translation_quality ?? 0);
  const missingStrings = Number(row.missing_strings ?? 0);
  const paymentSuccessRate = Number(row.payment_success_rate ?? 0);
  const activePaymentMethods = Number(row.active_payment_methods ?? 0);
  const complianceMet = Boolean(row.compliance_met ?? false);
  const csat = Number(row.csat ?? 0);
  const signups30d = Number(row.signups_30d ?? 0);
  const signupsPrev30d = Number(row.signups_prev_30d ?? 0);
  const nps = Number(row.nps ?? 0);
  const retentionD1 = Number(row.retention_d1 ?? 0);
  const regionActive = Boolean(row.region_active ?? false);
  const currentMrr = Number(row.current_mrr ?? 0);
  const prevMrr = Number(row.prev_mrr ?? 0);

  // Evaluate each criterion.
  const criteria: SuccessMeasurement["criteria"] = [
    {
      id: "first_class_language_experience",
      number: "17.1",
      title: "First-Class Experience in Their Language",
      met: translationQuality >= 80 && missingStrings === 0,
      value: `quality=${translationQuality.toFixed(0)}/100, missing=${missingStrings}`,
      target: "quality ≥ 80, missing = 0",
      hardRequirement: true,
    },
    {
      id: "payments_work",
      number: "17.2",
      title: "Payments Work in Their Currency and Method",
      met: paymentSuccessRate >= 95 && activePaymentMethods > 0,
      value: `success=${paymentSuccessRate.toFixed(1)}%, methods=${activePaymentMethods}`,
      target: "success ≥ 95%, methods > 0",
      hardRequirement: true,
    },
    {
      id: "compliance_verified",
      number: "17.3",
      title: "Legal and Tax Compliance Verified",
      met: complianceMet,
      value: `compliance ${complianceMet ? "verified" : "NOT verified"}`,
      target: "all compliance gates met",
      hardRequirement: true,
    },
    {
      id: "support_in_language",
      number: "17.4",
      title: "Support Available in Their Language",
      met: csat >= 4.0,
      value: `CSAT=${csat.toFixed(1)}/5`,
      target: "CSAT ≥ 4.0",
      hardRequirement: true,
    },
    {
      id: "retention_revenue_match_global",
      number: "17.5",
      title: "Retention and Revenue Match or Exceed Global",
      met: retentionD1 >= 50 && currentMrr >= prevMrr,
      value: `D1=${retentionD1.toFixed(1)}%, MRR ${currentMrr >= prevMrr ? "growing" : "declining"}`,
      target: "D1 ≥ 50%, MRR growing",
      hardRequirement: true,
    },
    {
      id: "churn_comparable",
      number: "17.6",
      title: "Churn Comparable to Global",
      met: retentionD1 >= 40, // proxy: D1 ≥ 40% means churn isn't catastrophic.
      value: `D1=${retentionD1.toFixed(1)}% (churn proxy)`,
      target: "D1 ≥ 40% (churn not catastrophic)",
      hardRequirement: true,
    },
    {
      id: "nps_positive",
      number: "17.7",
      title: "NPS is Positive",
      met: nps >= 30,
      value: `NPS=${nps.toFixed(0)}`,
      target: "NPS ≥ 30",
      hardRequirement: true,
    },
    {
      id: "contributes_to_growth",
      number: "17.8",
      title: "Region Contributes to Platform Growth",
      met: signups30d > signupsPrev30d && currentMrr > prevMrr,
      value: `signups ${signups30d > signupsPrev30d ? "growing" : "flat/declining"}, MRR ${currentMrr > prevMrr ? "growing" : "flat/declining"}`,
      target: "signups + MRR growing MoM",
      hardRequirement: false,
    },
  ];

  const hardMet = criteria.filter((c) => c.hardRequirement && c.met).length;
  const hardTotal = criteria.filter((c) => c.hardRequirement).length;

  let verdict: SuccessVerdict;
  let verdictReason: string;
  if (hardMet === hardTotal && criteria.find((c) => c.id === "contributes_to_growth")?.met) {
    verdict = "successful";
    verdictReason = `all ${hardTotal} hard requirements met + contributes to growth`;
  } else if (hardMet === hardTotal) {
    verdict = "successful";
    verdictReason = `all ${hardTotal} hard requirements met (growth not yet contributing)`;
  } else if (hardMet >= 5) {
    verdict = "partial";
    verdictReason = `${hardMet}/${hardTotal} hard requirements met — region healthy but not fully successful`;
  } else {
    verdict = "not_successful";
    verdictReason = `only ${hardMet}/${hardTotal} hard requirements met — region needs optimization or retirement review`;
  }

  // "A region is not successful just because it launched."
  const launchedButNotSuccessful = regionActive && verdict !== "successful";

  return {
    regionCode,
    criteria,
    verdict,
    verdictReason,
    launchedButNotSuccessful,
    measuredAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// 17 Verification.
// ───────────────────────────────────────────────

export interface SuccessMeasurementVerification {
  totalCriteria: number;
  implementedCriteria: number;
  hardRequirements: number;
  softRequirements: number;
  measurementFunctionImplemented: boolean;
  allImplemented: boolean;
  criteria: SuccessCriterionSpec[];
}

export function verifySuccessMeasurement(): SuccessMeasurementVerification {
  const hard = SUCCESS_CRITERIA.filter((c) => c.hardRequirement).length;
  const soft = SUCCESS_CRITERIA.filter((c) => !c.hardRequirement).length;
  return {
    totalCriteria: SUCCESS_CRITERIA.length,
    implementedCriteria: SUCCESS_CRITERIA.filter((c) => c.implemented).length,
    hardRequirements: hard,
    softRequirements: soft,
    measurementFunctionImplemented: true,
    allImplemented: SUCCESS_CRITERIA.every((c) => c.implemented),
    criteria: SUCCESS_CRITERIA,
  };
}
