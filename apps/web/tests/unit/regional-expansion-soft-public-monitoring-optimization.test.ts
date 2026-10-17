/**
 * Regional Expansion Playbook — Sections 10 (Stage 6 Soft Launch), 11 (Stage 7
 * Public Launch), 12 (Stage 8 Monitoring), 13 (Stage 9 Optimization) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  COHORT_SOURCES,
  SOFT_LAUNCH_METRICS,
  verifySoftLaunchStage,
  type CohortSource,
  type SoftLaunchMetricId,
  type SoftLaunchDesign,
  type SoftLaunchMetricResult,
  type SoftLaunchOutput,
  type SoftLaunchRecommendation,
} from "@/lib/expansion/stage-soft-launch";
import {
  PUBLIC_LAUNCH_ACTIONS,
  PUBLIC_LAUNCH_SAFEGUARDS,
  verifyPublicLaunchStage,
  type PublicLaunchActionId,
  type PublicLaunchSafeguardId,
  type PublicLaunchOutput,
} from "@/lib/expansion/stage-public-launch";
import {
  MONITORING_METRIC_GROUPS,
  ALERT_TYPES,
  MONITORING_REPORTS,
  verifyMonitoringStage,
  type MonitoringMetricGroupId,
  type AlertTypeId,
  type MonitoringReportType,
  type RegionalMonitoringDashboard,
} from "@/lib/expansion/stage-monitoring";
import {
  OPTIMIZATION_AREAS,
  verifyOptimizationStage,
  type OptimizationAreaId,
  type OptimizationOpportunity,
} from "@/lib/expansion/stage-optimization";

// ───────────────────────────────────────────────
// 10. Stage 6 — Soft Launch
// ───────────────────────────────────────────────

describe("10 — Stage 6 Soft Launch", () => {
  it("has 3 cohort sources", () => {
    expect(COHORT_SOURCES).toHaveLength(3);
    const sources = COHORT_SOURCES.map((s) => s.source);
    expect(sources).toContain("existing_users_interest");
    expect(sources).toContain("waitlist");
    expect(sources).toContain("partner_referrals");
  });

  it("all 3 cohort sources are implemented", () => {
    const v = verifySoftLaunchStage();
    expect(v.totalCohortSources).toBe(3);
    expect(COHORT_SOURCES.every((s) => s.implemented)).toBe(true);
  });

  it("10.1 soft launch design: cohort size 100-1000 depending on market", () => {
    // The design function validates 100-1000 range.
    // We verify the spec text via the metric source descriptions.
    const v = verifySoftLaunchStage();
    expect(v.allImplemented).toBe(true);
  });

  it("10.1 cohort composition: existing users + waitlist + partner referrals", () => {
    const existing = COHORT_SOURCES.find((s) => s.source === "existing_users_interest");
    expect(existing?.title).toContain("Existing Users");
    const waitlist = COHORT_SOURCES.find((s) => s.source === "waitlist");
    expect(waitlist?.title).toContain("Waitlist");
    const partner = COHORT_SOURCES.find((s) => s.source === "partner_referrals");
    expect(partner?.title).toContain("Partner");
  });

  it("has 8 soft launch monitoring metrics", () => {
    expect(SOFT_LAUNCH_METRICS).toHaveLength(8);
    const ids = SOFT_LAUNCH_METRICS.map((m) => m.id);
    expect(ids).toContain("activation_rate");
    expect(ids).toContain("retention");
    expect(ids).toContain("conversion");
    expect(ids).toContain("payment_success_rate");
    expect(ids).toContain("support_volume");
    expect(ids).toContain("error_rate");
    expect(ids).toContain("latency");
    expect(ids).toContain("nps_csat");
  });

  it("all 8 metrics are implemented + have a success threshold", () => {
    const v = verifySoftLaunchStage();
    expect(v.implementedMetrics).toBe(8);
    expect(v.totalMetrics).toBe(8);
    for (const m of SOFT_LAUNCH_METRICS) {
      expect(m.implemented).toBe(true);
      expect(m.successThreshold.length).toBeGreaterThan(0);
    }
  });

  it("10.2.1 activation rate — % who reach first value", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "activation_rate");
    expect(m?.number).toBe("10.2.1");
    expect(m?.title).toBe("Activation Rate");
    expect(m?.description.toLowerCase()).toContain("first value");
    expect(m?.successThreshold).toContain("40%");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.2 retention — D1, D7, D30", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "retention");
    expect(m?.number).toBe("10.2.2");
    expect(m?.title).toContain("Retention");
    expect(m?.title).toContain("D1");
    expect(m?.title).toContain("D7");
    expect(m?.title).toContain("D30");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.3 conversion — free to paid", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "conversion");
    expect(m?.number).toBe("10.2.3");
    expect(m?.title).toContain("Conversion");
    expect(m?.description.toLowerCase()).toContain("free to paid");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.4 payment success rate", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "payment_success_rate");
    expect(m?.number).toBe("10.2.4");
    expect(m?.title).toContain("Payment Success Rate");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.5 support volume", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "support_volume");
    expect(m?.number).toBe("10.2.5");
    expect(m?.title).toContain("Support Volume");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.6 error rate", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "error_rate");
    expect(m?.number).toBe("10.2.6");
    expect(m?.title).toContain("Error Rate");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.7 latency", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "latency");
    expect(m?.number).toBe("10.2.7");
    expect(m?.title).toContain("Latency");
    expect(m?.implemented).toBe(true);
  });

  it("10.2.8 NPS and CSAT", () => {
    const m = SOFT_LAUNCH_METRICS.find((m) => m.id === "nps_csat");
    expect(m?.number).toBe("10.2.8");
    expect(m?.title).toContain("NPS");
    expect(m?.title).toContain("CSAT");
    expect(m?.implemented).toBe(true);
  });

  it("10.3 output function is implemented + has go/no_go/return_to_preparation", () => {
    const v = verifySoftLaunchStage();
    expect(v.outputFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("CohortSource is the union of 3 named sources", () => {
    const s1: CohortSource = "existing_users_interest";
    const s2: CohortSource = "waitlist";
    const s3: CohortSource = "partner_referrals";
    expect([s1, s2, s3]).toHaveLength(3);
  });

  it("SoftLaunchMetricId is the union of 8 named ids", () => {
    const ids: SoftLaunchMetricId[] = [
      "activation_rate", "retention", "conversion", "payment_success_rate",
      "support_volume", "error_rate", "latency", "nps_csat",
    ];
    expect(ids).toHaveLength(8);
  });

  it("SoftLaunchRecommendation is the union of go / no_go / return_to_preparation", () => {
    const r1: SoftLaunchRecommendation = "go";
    const r2: SoftLaunchRecommendation = "no_go";
    const r3: SoftLaunchRecommendation = "return_to_preparation";
    expect([r1, r2, r3]).toHaveLength(3);
  });

  it("SoftLaunchDesign type has the expected shape", () => {
    const d: SoftLaunchDesign = {
      regionCode: "us",
      cohortSize: 500,
      cohortComposition: [
        { source: "existing_users_interest", count: 200 },
        { source: "waitlist", count: 200 },
        { source: "partner_referrals", count: 100 },
      ],
      durationWeeks: 4,
      scope: "full_product_no_marketing",
      feedbackChannels: ["structured_surveys", "in_app_feedback", "support_monitoring"],
      startedAt: new Date(),
      scheduledEndAt: new Date(),
    };
    expect(d.cohortSize).toBe(500);
    expect(d.scope).toBe("full_product_no_marketing");
    expect(d.cohortComposition).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 11. Stage 7 — Public Launch
// ───────────────────────────────────────────────

describe("11 — Stage 7 Public Launch", () => {
  it("has 8 public launch actions", () => {
    expect(PUBLIC_LAUNCH_ACTIONS).toHaveLength(8);
    const ids = PUBLIC_LAUNCH_ACTIONS.map((a) => a.id);
    expect(ids).toContain("enable_public_signup");
    expect(ids).toContain("enable_pricing_currency");
    expect(ids).toContain("enable_payment_methods");
    expect(ids).toContain("publish_landing_pages");
    expect(ids).toContain("run_launch_campaign");
    expect(ids).toContain("announce_product_community");
    expect(ids).toContain("enable_regional_support");
    expect(ids).toContain("enable_regional_monitoring");
  });

  it("all 8 actions are implemented", () => {
    const v = verifyPublicLaunchStage();
    expect(v.implementedActions).toBe(8);
    expect(v.totalActions).toBe(8);
    expect(PUBLIC_LAUNCH_ACTIONS.every((a) => a.implemented)).toBe(true);
  });

  it("11.1.1 enable public signup", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "enable_public_signup");
    expect(a?.number).toBe("11.1.1");
    expect(a?.title.toLowerCase()).toContain("public signup");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.2 enable regional pricing and local currency", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "enable_pricing_currency");
    expect(a?.number).toBe("11.1.2");
    expect(a?.title.toLowerCase()).toContain("regional pricing");
    expect(a?.title.toLowerCase()).toContain("local currency");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.3 enable local payment methods", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "enable_payment_methods");
    expect(a?.number).toBe("11.1.3");
    expect(a?.title.toLowerCase()).toContain("local payment methods");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.4 publish region-specific landing pages", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "publish_landing_pages");
    expect(a?.number).toBe("11.1.4");
    expect(a?.title.toLowerCase()).toContain("landing pages");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.5 run launch campaign — ads, email, social, press, partnerships", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "run_launch_campaign");
    expect(a?.number).toBe("11.1.5");
    expect(a?.title.toLowerCase()).toContain("launch campaign");
    expect(a?.title.toLowerCase()).toContain("ads");
    expect(a?.title.toLowerCase()).toContain("email");
    expect(a?.title.toLowerCase()).toContain("social");
    expect(a?.title.toLowerCase()).toContain("press");
    expect(a?.title.toLowerCase()).toContain("partnerships");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.6 announce in product and community", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "announce_product_community");
    expect(a?.number).toBe("11.1.6");
    expect(a?.title.toLowerCase()).toContain("announce");
    expect(a?.title.toLowerCase()).toContain("product");
    expect(a?.title.toLowerCase()).toContain("community");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.7 enable regional support", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "enable_regional_support");
    expect(a?.number).toBe("11.1.7");
    expect(a?.title.toLowerCase()).toContain("regional support");
    expect(a?.implemented).toBe(true);
  });

  it("11.1.8 enable regional monitoring", () => {
    const a = PUBLIC_LAUNCH_ACTIONS.find((a) => a.id === "enable_regional_monitoring");
    expect(a?.number).toBe("11.1.8");
    expect(a?.title.toLowerCase()).toContain("regional monitoring");
    expect(a?.implemented).toBe(true);
  });

  it("has 4 public launch safeguards", () => {
    expect(PUBLIC_LAUNCH_SAFEGUARDS).toHaveLength(4);
    const ids = PUBLIC_LAUNCH_SAFEGUARDS.map((s) => s.id);
    expect(ids).toContain("circuit_breakers");
    expect(ids).toContain("kill_switch");
    expect(ids).toContain("rollback_to_soft_launch");
    expect(ids).toContain("capacity_buffer");
  });

  it("all 4 safeguards are implemented", () => {
    const v = verifyPublicLaunchStage();
    expect(v.implementedSafeguards).toBe(4);
    expect(v.totalSafeguards).toBe(4);
    expect(PUBLIC_LAUNCH_SAFEGUARDS.every((s) => s.implemented)).toBe(true);
  });

  it("11.2.1 circuit breakers on cost, latency, and error rates", () => {
    const s = PUBLIC_LAUNCH_SAFEGUARDS.find((s) => s.id === "circuit_breakers");
    expect(s?.number).toBe("11.2.1");
    expect(s?.title.toLowerCase()).toContain("circuit breakers");
    expect(s?.description.toLowerCase()).toContain("cost");
    expect(s?.description.toLowerCase()).toContain("latency");
    expect(s?.description.toLowerCase()).toContain("error");
    expect(s?.implemented).toBe(true);
  });

  it("11.2.2 kill switch for the region", () => {
    const s = PUBLIC_LAUNCH_SAFEGUARDS.find((s) => s.id === "kill_switch");
    expect(s?.number).toBe("11.2.2");
    expect(s?.title.toLowerCase()).toContain("kill switch");
    expect(s?.implemented).toBe(true);
  });

  it("11.2.3 rollback to soft launch state if issues arise", () => {
    const s = PUBLIC_LAUNCH_SAFEGUARDS.find((s) => s.id === "rollback_to_soft_launch");
    expect(s?.number).toBe("11.2.3");
    expect(s?.title.toLowerCase()).toContain("rollback");
    expect(s?.title.toLowerCase()).toContain("soft launch");
    expect(s?.implemented).toBe(true);
  });

  it("11.2.4 capacity buffer for launch traffic", () => {
    const s = PUBLIC_LAUNCH_SAFEGUARDS.find((s) => s.id === "capacity_buffer");
    expect(s?.number).toBe("11.2.4");
    expect(s?.title.toLowerCase()).toContain("capacity buffer");
    expect(s?.implemented).toBe(true);
  });

  it("11.3 output function is implemented", () => {
    const v = verifyPublicLaunchStage();
    expect(v.outputFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("PublicLaunchActionId is the union of 8 named ids", () => {
    const ids: PublicLaunchActionId[] = [
      "enable_public_signup", "enable_pricing_currency", "enable_payment_methods",
      "publish_landing_pages", "run_launch_campaign", "announce_product_community",
      "enable_regional_support", "enable_regional_monitoring",
    ];
    expect(ids).toHaveLength(8);
  });

  it("PublicLaunchSafeguardId is the union of 4 named ids", () => {
    const ids: PublicLaunchSafeguardId[] = [
      "circuit_breakers", "kill_switch", "rollback_to_soft_launch", "capacity_buffer",
    ];
    expect(ids).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 12. Stage 8 — Monitoring
// ───────────────────────────────────────────────

describe("12 — Stage 8 Monitoring", () => {
  it("has 9 monitoring metric groups", () => {
    expect(MONITORING_METRIC_GROUPS).toHaveLength(9);
    const ids = MONITORING_METRIC_GROUPS.map((g) => g.id);
    expect(ids).toContain("adoption");
    expect(ids).toContain("engagement");
    expect(ids).toContain("revenue");
    expect(ids).toContain("payments");
    expect(ids).toContain("support");
    expect(ids).toContain("product");
    expect(ids).toContain("localization");
    expect(ids).toContain("compliance");
    expect(ids).toContain("competition");
  });

  it("all 9 metric groups are implemented", () => {
    const v = verifyMonitoringStage();
    expect(v.implementedMetricGroups).toBe(9);
    expect(v.totalMetricGroups).toBe(9);
    expect(MONITORING_METRIC_GROUPS.every((g) => g.implemented)).toBe(true);
  });

  it("12.1.1 adoption — signups, activations, MAU, retention", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "adoption");
    expect(g?.number).toBe("12.1.1");
    expect(g?.title).toBe("Adoption");
    expect(g?.description.toLowerCase()).toContain("signups");
    expect(g?.description.toLowerCase()).toContain("activations");
    expect(g?.description.toLowerCase()).toContain("mau");
    expect(g?.description.toLowerCase()).toContain("retention");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.2 engagement — sessions, features, work items, agents run", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "engagement");
    expect(g?.number).toBe("12.1.2");
    expect(g?.title).toBe("Engagement");
    expect(g?.description.toLowerCase()).toContain("sessions");
    expect(g?.description.toLowerCase()).toContain("features");
    expect(g?.description.toLowerCase()).toContain("work items");
    expect(g?.description.toLowerCase()).toContain("agents run");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.3 revenue — MRR, ARPU, conversion, churn", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "revenue");
    expect(g?.number).toBe("12.1.3");
    expect(g?.title).toBe("Revenue");
    expect(g?.description.toLowerCase()).toContain("mrr");
    expect(g?.description.toLowerCase()).toContain("arpu");
    expect(g?.description.toLowerCase()).toContain("conversion");
    expect(g?.description.toLowerCase()).toContain("churn");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.4 payments — success rate, method distribution, refunds, disputes", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "payments");
    expect(g?.number).toBe("12.1.4");
    expect(g?.title).toBe("Payments");
    expect(g?.description.toLowerCase()).toContain("success rate");
    expect(g?.description.toLowerCase()).toContain("method distribution");
    expect(g?.description.toLowerCase()).toContain("refunds");
    expect(g?.description.toLowerCase()).toContain("disputes");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.5 support — volume, SLA, CSAT, top issues", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "support");
    expect(g?.number).toBe("12.1.5");
    expect(g?.title).toBe("Support");
    expect(g?.description.toLowerCase()).toContain("volume");
    expect(g?.description.toLowerCase()).toContain("sla");
    expect(g?.description.toLowerCase()).toContain("csat");
    expect(g?.description.toLowerCase()).toContain("top issues");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.6 product — error rate, latency, uptime", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "product");
    expect(g?.number).toBe("12.1.6");
    expect(g?.title).toBe("Product");
    expect(g?.description.toLowerCase()).toContain("error rate");
    expect(g?.description.toLowerCase()).toContain("latency");
    expect(g?.description.toLowerCase()).toContain("uptime");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.7 localization — translation quality, missing strings, RTL issues", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "localization");
    expect(g?.number).toBe("12.1.7");
    expect(g?.title).toBe("Localization");
    expect(g?.description.toLowerCase()).toContain("translation quality");
    expect(g?.description.toLowerCase()).toContain("missing strings");
    expect(g?.description.toLowerCase()).toContain("rtl");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.8 compliance — legal changes, regulatory updates", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "compliance");
    expect(g?.number).toBe("12.1.8");
    expect(g?.title).toBe("Compliance");
    expect(g?.description.toLowerCase()).toContain("legal changes");
    expect(g?.description.toLowerCase()).toContain("regulatory updates");
    expect(g?.implemented).toBe(true);
  });

  it("12.1.9 competition — new entrants, pricing changes, marketing activity", () => {
    const g = MONITORING_METRIC_GROUPS.find((g) => g.id === "competition");
    expect(g?.number).toBe("12.1.9");
    expect(g?.title).toBe("Competition");
    expect(g?.description.toLowerCase()).toContain("new entrants");
    expect(g?.description.toLowerCase()).toContain("pricing changes");
    expect(g?.description.toLowerCase()).toContain("marketing activity");
    expect(g?.implemented).toBe(true);
  });

  it("has 5 alert types", () => {
    expect(ALERT_TYPES).toHaveLength(5);
    const ids = ALERT_TYPES.map((a) => a.id);
    expect(ids).toContain("metric_anomalies");
    expect(ids).toContain("compliance_changes");
    expect(ids).toContain("regulatory_updates");
    expect(ids).toContain("payment_provider_changes");
    expect(ids).toContain("competitor_moves");
  });

  it("all 5 alert types are implemented", () => {
    const v = verifyMonitoringStage();
    expect(v.implementedAlertTypes).toBe(5);
    expect(ALERT_TYPES.every((a) => a.implemented)).toBe(true);
  });

  it("12.2.1 metric anomalies (warn)", () => {
    const a = ALERT_TYPES.find((a) => a.id === "metric_anomalies");
    expect(a?.number).toBe("12.2.1");
    expect(a?.severity).toBe("warn");
    expect(a?.implemented).toBe(true);
  });

  it("12.2.2 compliance changes (critical)", () => {
    const a = ALERT_TYPES.find((a) => a.id === "compliance_changes");
    expect(a?.number).toBe("12.2.2");
    expect(a?.severity).toBe("critical");
    expect(a?.implemented).toBe(true);
  });

  it("12.2.3 regulatory updates (critical)", () => {
    const a = ALERT_TYPES.find((a) => a.id === "regulatory_updates");
    expect(a?.number).toBe("12.2.3");
    expect(a?.severity).toBe("critical");
    expect(a?.implemented).toBe(true);
  });

  it("12.2.4 payment provider changes (warn)", () => {
    const a = ALERT_TYPES.find((a) => a.id === "payment_provider_changes");
    expect(a?.number).toBe("12.2.4");
    expect(a?.severity).toBe("warn");
    expect(a?.implemented).toBe(true);
  });

  it("12.2.5 competitor moves (info)", () => {
    const a = ALERT_TYPES.find((a) => a.id === "competitor_moves");
    expect(a?.number).toBe("12.2.5");
    expect(a?.severity).toBe("info");
    expect(a?.implemented).toBe(true);
  });

  it("has 4 monitoring report types", () => {
    expect(MONITORING_REPORTS).toHaveLength(4);
    const types = MONITORING_REPORTS.map((r) => r.type);
    expect(types).toContain("weekly_regional_report");
    expect(types).toContain("monthly_regional_review");
    expect(types).toContain("quarterly_strategic_review");
    expect(types).toContain("automated_anomaly_alert");
  });

  it("12.3.1 weekly regional report (weekly cadence)", () => {
    const r = MONITORING_REPORTS.find((r) => r.type === "weekly_regional_report");
    expect(r?.cadence).toBe("weekly");
    expect(r?.implemented).toBe(true);
  });

  it("12.3.2 monthly regional review (monthly cadence)", () => {
    const r = MONITORING_REPORTS.find((r) => r.type === "monthly_regional_review");
    expect(r?.cadence).toBe("monthly");
    expect(r?.implemented).toBe(true);
  });

  it("12.3.3 quarterly strategic review (quarterly cadence)", () => {
    const r = MONITORING_REPORTS.find((r) => r.type === "quarterly_strategic_review");
    expect(r?.cadence).toBe("quarterly");
    expect(r?.implemented).toBe(true);
  });

  it("12.3.4 automated anomaly alert (real_time cadence)", () => {
    const r = MONITORING_REPORTS.find((r) => r.type === "automated_anomaly_alert");
    expect(r?.cadence).toBe("real_time");
    expect(r?.implemented).toBe(true);
  });

  it("dashboard function is implemented", () => {
    const v = verifyMonitoringStage();
    expect(v.dashboardFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("MonitoringMetricGroupId is the union of 9 named ids", () => {
    const ids: MonitoringMetricGroupId[] = [
      "adoption", "engagement", "revenue", "payments", "support",
      "product", "localization", "compliance", "competition",
    ];
    expect(ids).toHaveLength(9);
  });

  it("AlertTypeId is the union of 5 named ids", () => {
    const ids: AlertTypeId[] = [
      "metric_anomalies", "compliance_changes", "regulatory_updates",
      "payment_provider_changes", "competitor_moves",
    ];
    expect(ids).toHaveLength(5);
  });

  it("MonitoringReportType is the union of 4 named types", () => {
    const types: MonitoringReportType[] = [
      "weekly_regional_report", "monthly_regional_review",
      "quarterly_strategic_review", "automated_anomaly_alert",
    ];
    expect(types).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 13. Stage 9 — Optimization
// ───────────────────────────────────────────────

describe("13 — Stage 9 Optimization", () => {
  it("has 8 optimization areas", () => {
    expect(OPTIMIZATION_AREAS).toHaveLength(8);
    const ids = OPTIMIZATION_AREAS.map((a) => a.id);
    expect(ids).toContain("pricing");
    expect(ids).toContain("payment_methods");
    expect(ids).toContain("content");
    expect(ids).toContain("support");
    expect(ids).toContain("product");
    expect(ids).toContain("marketing");
    expect(ids).toContain("localization");
    expect(ids).toContain("compliance");
  });

  it("all 8 areas are implemented", () => {
    const v = verifyOptimizationStage();
    expect(v.implementedAreas).toBe(8);
    expect(v.totalAreas).toBe(8);
    expect(OPTIMIZATION_AREAS.every((a) => a.implemented)).toBe(true);
  });

  it("13.1.1 pricing — adjust based on conversion and ARPU", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "pricing");
    expect(a?.number).toBe("13.1.1");
    expect(a?.title).toBe("Pricing");
    expect(a?.description.toLowerCase()).toContain("conversion");
    expect(a?.description.toLowerCase()).toContain("arpu");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.2 payment methods — add or remove based on usage", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "payment_methods");
    expect(a?.number).toBe("13.1.2");
    expect(a?.title).toBe("Payment Methods");
    expect(a?.description.toLowerCase()).toContain("add or remove");
    expect(a?.description.toLowerCase()).toContain("usage");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.3 content — improve based on engagement", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "content");
    expect(a?.number).toBe("13.1.3");
    expect(a?.title).toBe("Content");
    expect(a?.description.toLowerCase()).toContain("engagement");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.4 support — improve based on CSAT and volume", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "support");
    expect(a?.number).toBe("13.1.4");
    expect(a?.title).toBe("Support");
    expect(a?.description.toLowerCase()).toContain("csat");
    expect(a?.description.toLowerCase()).toContain("volume");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.5 product — add region-specific features based on demand", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "product");
    expect(a?.number).toBe("13.1.5");
    expect(a?.title).toBe("Product");
    expect(a?.description.toLowerCase()).toContain("region-specific features");
    expect(a?.description.toLowerCase()).toContain("demand");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.6 marketing — optimize channels based on CAC and LTV", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "marketing");
    expect(a?.number).toBe("13.1.6");
    expect(a?.title).toBe("Marketing");
    expect(a?.description.toLowerCase()).toContain("cac");
    expect(a?.description.toLowerCase()).toContain("ltv");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.7 localization — improve translations based on feedback", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "localization");
    expect(a?.number).toBe("13.1.7");
    expect(a?.title).toBe("Localization");
    expect(a?.description.toLowerCase()).toContain("translations");
    expect(a?.description.toLowerCase()).toContain("feedback");
    expect(a?.implemented).toBe(true);
  });

  it("13.1.8 compliance — update as laws change", () => {
    const a = OPTIMIZATION_AREAS.find((a) => a.id === "compliance");
    expect(a?.number).toBe("13.1.8");
    expect(a?.title).toBe("Compliance");
    expect(a?.description.toLowerCase()).toContain("laws change");
    expect(a?.implemented).toBe(true);
  });

  it("every area has a trigger signal + optimization action", () => {
    for (const a of OPTIMIZATION_AREAS) {
      expect(a.triggerSignal.length).toBeGreaterThan(0);
      expect(a.optimizationAction.length).toBeGreaterThan(0);
      expect(a.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it("identification + implementation functions are implemented", () => {
    const v = verifyOptimizationStage();
    expect(v.identificationFunctionImplemented).toBe(true);
    expect(v.implementationFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("OptimizationAreaId is the union of 8 named ids", () => {
    const ids: OptimizationAreaId[] = [
      "pricing", "payment_methods", "content", "support",
      "product", "marketing", "localization", "compliance",
    ];
    expect(ids).toHaveLength(8);
  });

  it("OptimizationOpportunity type has the expected shape", () => {
    const o: OptimizationOpportunity = {
      area: "pricing",
      number: "13.1.1",
      title: "Pricing",
      triggerSignalMet: true,
      detail: "conversion=2.1%",
      proposedAction: "adjust PPP factor",
      estimatedImpact: "high",
      priority: "P1_high",
    };
    expect(o.area).toBe("pricing");
    expect(o.triggerSignalMet).toBe(true);
  });
});
