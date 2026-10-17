/**
 * Regional Expansion Playbook — Sections 4 (Region Lifecycle), 5 (Stage 1 Detection),
 * 6 (Stage 2 Evaluation) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  REGION_STAGES,
  LIFECYCLE_TRANSITIONS,
  ANY_STAGE_ACTIONS,
  verifyRegionLifecycle,
  getStage,
  getStageByNumber,
  getNextStage,
  getPreviousStage,
  getTransitionsFrom,
  type RegionStage,
  type StageStatus,
  type StageSpec,
  type LifecycleTransition,
  type RegionAction,
  type AnyStageActionSpec,
} from "@/lib/expansion/region-lifecycle";
import {
  DEMAND_SIGNAL_TYPES,
  DETECTION_THRESHOLDS,
  PER_REGION_TYPE_THRESHOLDS,
  verifyDetectionStage,
  type DemandSignalType,
  type DemandSignalTypeSpec,
  type DetectionThreshold,
  type RegionSignalBundle,
  type EvaluationQueueEntry,
} from "@/lib/expansion/stage-detection";
import {
  MARKET_FIT_CRITERIA,
  LANGUAGE_READINESS_CRITERIA,
  PAYMENT_READINESS_CRITERIA,
  LEGAL_READINESS_CRITERIA,
  TAX_READINESS_CRITERIA,
  INFRASTRUCTURE_READINESS_CRITERIA,
  SUPPORT_READINESS_CRITERIA,
  CULTURAL_READINESS_CRITERIA,
  verifyEvaluationStage,
  type MarketFitCriterion,
  type LanguageReadinessCriterion,
  type PaymentReadinessCriterion,
  type LegalReadinessCriterion,
  type TaxReadinessCriterion,
  type InfrastructureReadinessCriterion,
  type SupportReadinessCriterion,
  type CulturalReadinessCriterion,
  type MarketFitEvaluation,
  type LanguageReadinessEvaluation,
  type PaymentReadinessEvaluation,
  type LegalReadinessEvaluation,
  type TaxReadinessEvaluation,
  type InfrastructureReadinessEvaluation,
  type SupportReadinessEvaluation,
  type CulturalReadinessEvaluation,
  type CompositeReadinessEvaluation,
  type EvaluationOutput,
  type EffortEstimate,
  type RecommendedPriority,
  type DimensionResult,
} from "@/lib/expansion/stage-evaluation";

// ───────────────────────────────────────────────
// 4. Region lifecycle — 9 stages
// ───────────────────────────────────────────────

describe("4 — Region lifecycle (9 stages)", () => {
  it("has 9 stages", () => {
    expect(REGION_STAGES).toHaveLength(9);
    const stages = REGION_STAGES.map((s) => s.stage);
    expect(stages).toEqual([
      "detection",
      "evaluation",
      "prioritization",
      "preparation",
      "verification",
      "soft_launch",
      "public_launch",
      "monitoring",
      "optimization",
    ]);
  });

  it("all 9 stages are implemented", () => {
    const v = verifyRegionLifecycle();
    expect(v.implementedStages).toBe(9);
    expect(v.totalStages).toBe(9);
    expect(v.allImplemented).toBe(true);
  });

  it("every stage has entry criteria + deliverables + exit criteria + rollback path", () => {
    for (const s of REGION_STAGES) {
      expect(s.entryCriteria.length).toBeGreaterThan(0);
      expect(s.deliverables.length).toBeGreaterThan(0);
      expect(s.exitCriteria.length).toBeGreaterThan(0);
      expect(s.rollbackPath.length).toBeGreaterThan(0);
      expect(s.implemented).toBe(true);
      expect(s.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it("4.1 detection — identifies regions with real demand", () => {
    const s = getStage("detection");
    expect(s?.number).toBe(1);
    expect(s?.title).toBe("Detection");
    expect(s?.goal).toContain("real demand");
    expect(s?.enforcedBy).toContain("stage-detection.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.2 evaluation — evaluates readiness", () => {
    const s = getStage("evaluation");
    expect(s?.number).toBe(2);
    expect(s?.title).toBe("Evaluation");
    expect(s?.goal).toContain("ready for expansion");
    expect(s?.enforcedBy).toContain("stage-evaluation.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.3 prioritization — scores and queues", () => {
    const s = getStage("prioritization");
    expect(s?.number).toBe(3);
    expect(s?.title).toBe("Prioritization");
    expect(s?.goal.toLowerCase()).toContain("score and queue");
    expect(s?.enforcedBy).toContain("stage-prioritization.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.4 preparation — provisions language/content/legal/tax/payments/infrastructure", () => {
    const s = getStage("preparation");
    expect(s?.number).toBe(4);
    expect(s?.title).toBe("Preparation");
    expect(s?.goal.toLowerCase()).toContain("provision");
    expect(s?.deliverables.some((d) => d.includes("Language provisioned"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Content provisioned"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Legal provisioned"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Tax provisioned"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Payments provisioned"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Infrastructure provisioned"))).toBe(true);
    expect(s?.enforcedBy).toContain("stage-preparation.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.5 verification — automated + human review of every element", () => {
    const s = getStage("verification");
    expect(s?.number).toBe(5);
    expect(s?.title).toBe("Verification");
    expect(s?.goal.toLowerCase()).toContain("automated and human review");
    expect(s?.deliverables.some((d) => d.includes("Automated verification"))).toBe(true);
    expect(s?.deliverables.some((d) => d.includes("Human review"))).toBe(true);
    expect(s?.enforcedBy).toContain("stage-verification.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.6 soft launch — limited cohort", () => {
    const s = getStage("soft_launch");
    expect(s?.number).toBe(6);
    expect(s?.title).toBe("Soft Launch");
    expect(s?.goal).toContain("limited cohort");
    expect(s?.enforcedBy).toContain("stage-soft-launch.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.7 public launch — opens to all users", () => {
    const s = getStage("public_launch");
    expect(s?.number).toBe(7);
    expect(s?.title).toBe("Public Launch");
    expect(s?.goal).toContain("all users");
    expect(s?.enforcedBy).toContain("stage-public-launch.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.8 monitoring — measured continuously", () => {
    const s = getStage("monitoring");
    expect(s?.number).toBe(8);
    expect(s?.title).toBe("Monitoring");
    expect(s?.goal).toContain("continuously");
    expect(s?.enforcedBy).toContain("stage-monitoring.ts");
    expect(s?.implemented).toBe(true);
  });

  it("4.9 optimization — tuned based on data", () => {
    const s = getStage("optimization");
    expect(s?.number).toBe(9);
    expect(s?.title).toBe("Optimization");
    expect(s?.goal.toLowerCase()).toContain("tune the region based on data");
    expect(s?.enforcedBy).toContain("stage-optimization.ts");
    expect(s?.implemented).toBe(true);
  });

  it("regions may be paused, rolled back, or retired at any stage", () => {
    expect(ANY_STAGE_ACTIONS).toHaveLength(3);
    const actions = ANY_STAGE_ACTIONS.map((a) => a.action);
    expect(actions).toContain("pause");
    expect(actions).toContain("rollback");
    expect(actions).toContain("retire");
    expect(ANY_STAGE_ACTIONS.every((a) => a.implemented)).toBe(true);
  });

  it("lifecycle transitions form a forward chain", () => {
    expect(LIFECYCLE_TRANSITIONS.length).toBeGreaterThanOrEqual(9);
    // detection → evaluation must exist.
    expect(LIFECYCLE_TRANSITIONS.some((t) => t.from === "detection" && t.to === "evaluation")).toBe(true);
    // monitoring → optimization → monitoring (continuous loop).
    expect(LIFECYCLE_TRANSITIONS.some((t) => t.from === "monitoring" && t.to === "optimization")).toBe(true);
    expect(LIFECYCLE_TRANSITIONS.some((t) => t.from === "optimization" && t.to === "monitoring")).toBe(true);
  });

  it("getStageByNumber returns stage by 1-9", () => {
    expect(getStageByNumber(1)?.stage).toBe("detection");
    expect(getStageByNumber(9)?.stage).toBe("optimization");
  });

  it("getNextStage + getPreviousStage traverse the chain", () => {
    expect(getNextStage("detection")).toBe("evaluation");
    expect(getNextStage("optimization")).toBeNull();
    expect(getPreviousStage("detection")).toBeNull();
    expect(getPreviousStage("evaluation")).toBe("detection");
  });

  it("getTransitionsFrom returns all transitions out of a stage", () => {
    const fromEval = getTransitionsFrom("evaluation");
    expect(fromEval.length).toBeGreaterThanOrEqual(2); // →prioritization OR →detection (no-go).
    expect(fromEval.some((t) => t.to === "prioritization")).toBe(true);
  });

  it("RegionStage is the union of 9 named stages", () => {
    const s1: RegionStage = "detection";
    const s2: RegionStage = "evaluation";
    const s3: RegionStage = "prioritization";
    const s4: RegionStage = "preparation";
    const s5: RegionStage = "verification";
    const s6: RegionStage = "soft_launch";
    const s7: RegionStage = "public_launch";
    const s8: RegionStage = "monitoring";
    const s9: RegionStage = "optimization";
    expect([s1, s2, s3, s4, s5, s6, s7, s8, s9]).toHaveLength(9);
  });
});

// ───────────────────────────────────────────────
// 5. Stage 1 — Detection
// ───────────────────────────────────────────────

describe("5 — Stage 1 Detection", () => {
  it("has 9 demand signal types", () => {
    expect(DEMAND_SIGNAL_TYPES).toHaveLength(9);
    const types = DEMAND_SIGNAL_TYPES.map((s) => s.type);
    expect(types).toContain("traffic");
    expect(types).toContain("signups");
    expect(types).toContain("attempted_payments");
    expect(types).toContain("localization_requests");
    expect(types).toContain("support_requests");
    expect(types).toContain("language_usage");
    expect(types).toContain("search_demand");
    expect(types).toContain("referrals");
    expect(types).toContain("social_signals");
  });

  it("all 9 signal types are implemented + have a weight + source", () => {
    const v = verifyDetectionStage();
    expect(v.implementedSignalTypes).toBe(9);
    expect(v.allImplemented).toBe(true);
    for (const s of DEMAND_SIGNAL_TYPES) {
      expect(s.implemented).toBe(true);
      expect(s.weight).toBeGreaterThan(0);
      expect(s.source.length).toBeGreaterThan(0);
    }
  });

  it("5.1.1 traffic — visitors by volume and growth", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "traffic");
    expect(s?.title).toBe("Traffic");
    expect(s?.description).toContain("volume and growth");
    expect(s?.requiresGrowth).toBe(true);
    expect(s?.implemented).toBe(true);
  });

  it("5.1.2 signups — users signing up, volume and growth", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "signups");
    expect(s?.title).toBe("Signups");
    expect(s?.description).toContain("signing up");
    expect(s?.requiresGrowth).toBe(true);
    expect(s?.implemented).toBe(true);
  });

  it("5.1.3 attempted_payments — trying to pay even if method unsupported", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "attempted_payments");
    expect(s?.title).toBe("Attempted Payments");
    expect(s?.description).toContain("even if the method");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.4 localization_requests — requesting a language or currency", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "localization_requests");
    expect(s?.title).toBe("Localization Requests");
    expect(s?.description).toContain("language or currency");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.5 support_requests — volume and language of requests", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "support_requests");
    expect(s?.title).toBe("Support Requests");
    expect(s?.description.toLowerCase()).toContain("volume and language");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.6 language_usage — languages used by existing users", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "language_usage");
    expect(s?.title).toBe("Language Usage");
    expect(s?.description).toContain("existing users");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.7 search_demand — searches for Supa AI in region's language", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "search_demand");
    expect(s?.title).toBe("Search Demand");
    expect(s?.description).toContain("region's language");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.8 referrals — referrals from users in the region", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "referrals");
    expect(s?.title).toBe("Referrals");
    expect(s?.description.toLowerCase()).toContain("referrals from users");
    expect(s?.implemented).toBe(true);
  });

  it("5.1.9 social_signals — mentions in regional media and social platforms", () => {
    const s = DEMAND_SIGNAL_TYPES.find((s) => s.type === "social_signals");
    expect(s?.title).toBe("Social Signals");
    expect(s?.description).toContain("media and social platforms");
    expect(s?.implemented).toBe(true);
  });

  it("5.2 has 5 detection thresholds (rolling 90-day window)", () => {
    expect(DETECTION_THRESHOLDS).toHaveLength(5);
    const types = DETECTION_THRESHOLDS.map((t) => t.signalType);
    expect(types).toContain("traffic");
    expect(types).toContain("signups");
    expect(types).toContain("attempted_payments");
    expect(types).toContain("support_requests");
    expect(types).toContain("search_demand");
  });

  it("5.2.1 traffic threshold = 500 visitors/month, growing", () => {
    const t = DETECTION_THRESHOLDS.find((t) => t.signalType === "traffic");
    expect(t?.threshold).toBe(500);
    expect(t?.requiresGrowth).toBe(true);
    expect(t?.description).toContain("500 unique visitors");
  });

  it("5.2.2 signups threshold = 100 signups/month", () => {
    const t = DETECTION_THRESHOLDS.find((t) => t.signalType === "signups");
    expect(t?.threshold).toBe(100);
    expect(t?.description).toContain("100 signups");
  });

  it("5.2.3 attempted payments threshold = 20/month", () => {
    const t = DETECTION_THRESHOLDS.find((t) => t.signalType === "attempted_payments");
    expect(t?.threshold).toBe(20);
    expect(t?.description).toContain("20 attempted payments");
  });

  it("5.2.4 support requests threshold = 10/month in unsupported language", () => {
    const t = DETECTION_THRESHOLDS.find((t) => t.signalType === "support_requests");
    expect(t?.threshold).toBe(10);
    expect(t?.description).toContain("10 support requests");
    expect(t?.description).toContain("language not yet supported");
  });

  it("5.2.5 search demand threshold = 1000 searches/month", () => {
    const t = DETECTION_THRESHOLDS.find((t) => t.signalType === "search_demand");
    expect(t?.threshold).toBe(1000);
    expect(t?.description).toContain("1000 searches");
  });

  it("thresholds are configurable per region type", () => {
    expect(PER_REGION_TYPE_THRESHOLDS.enterprise!).toBeDefined();
    expect(PER_REGION_TYPE_THRESHOLDS.enterprise!.traffic).toBe(2000);
    expect(PER_REGION_TYPE_THRESHOLDS.enterprise!.signups).toBe(500);
    expect(PER_REGION_TYPE_THRESHOLDS.developer!).toBeDefined();
    expect(PER_REGION_TYPE_THRESHOLDS.developer!.search_demand).toBe(2000);
  });

  it("5.3 output: queue function is implemented", () => {
    const v = verifyDetectionStage();
    expect(v.queueFunctionImplemented).toBe(true);
    expect(v.detectionCycleImplemented).toBe(true);
  });

  it("DemandSignalType is the union of 9 named types", () => {
    const t1: DemandSignalType = "traffic";
    const t2: DemandSignalType = "signups";
    const t3: DemandSignalType = "attempted_payments";
    const t4: DemandSignalType = "localization_requests";
    const t5: DemandSignalType = "support_requests";
    const t6: DemandSignalType = "language_usage";
    const t7: DemandSignalType = "search_demand";
    const t8: DemandSignalType = "referrals";
    const t9: DemandSignalType = "social_signals";
    expect([t1, t2, t3, t4, t5, t6, t7, t8, t9]).toHaveLength(9);
  });

  it("DemandSignalTypeSpec is a structured type", () => {
    const s: DemandSignalTypeSpec = {
      type: "traffic",
      title: "Test",
      description: "test",
      requiresGrowth: true,
      weight: 1.0,
      source: "test",
      implemented: true,
    };
    expect(s.type).toBe("traffic");
    expect(s.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 6. Stage 2 — Evaluation
// ───────────────────────────────────────────────

describe("6 — Stage 2 Evaluation", () => {
  it("6.1 has 4 market-fit criteria", () => {
    expect(MARKET_FIT_CRITERIA).toHaveLength(4);
    const criteria = MARKET_FIT_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("population_penetration");
    expect(criteria).toContain("audience_size");
    expect(criteria).toContain("english_proficiency");
    expect(criteria).toContain("competitor_presence");
  });

  it("6.1.1 population_penetration — population, internet, smartphone penetration", () => {
    const c = MARKET_FIT_CRITERIA.find((c) => c.criterion === "population_penetration");
    expect(c?.title).toBe("Population + Penetration");
    expect(c?.description).toContain("Population");
    expect(c?.description).toContain("internet penetration");
    expect(c?.description).toContain("smartphone penetration");
    expect(c?.implemented).toBe(true);
  });

  it("6.1.2 audience_size — freelancer, SMB, enterprise presence", () => {
    const c = MARKET_FIT_CRITERIA.find((c) => c.criterion === "audience_size");
    expect(c?.title).toBe("Audience Size");
    expect(c?.description).toContain("Freelancer");
    expect(c?.description).toContain("small business");
    expect(c?.description).toContain("enterprise presence");
    expect(c?.implemented).toBe(true);
  });

  it("6.1.3 english_proficiency — affects translation priority", () => {
    const c = MARKET_FIT_CRITERIA.find((c) => c.criterion === "english_proficiency");
    expect(c?.title).toBe("English Proficiency");
    expect(c?.description).toContain("translation priority");
    expect(c?.implemented).toBe(true);
  });

  it("6.1.4 competitor_presence — opportunity and risk", () => {
    const c = MARKET_FIT_CRITERIA.find((c) => c.criterion === "competitor_presence");
    expect(c?.title).toBe("Competitor Presence");
    expect(c?.description).toContain("opportunity");
    expect(c?.description).toContain("risk");
    expect(c?.implemented).toBe(true);
  });

  it("6.2 has 4 language-readiness criteria", () => {
    expect(LANGUAGE_READINESS_CRITERIA).toHaveLength(4);
    const criteria = LANGUAGE_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("ai_provider_support");
    expect(criteria).toContain("native_speaker_reviewer");
    expect(criteria).toContain("translation_quality");
    expect(criteria).toContain("script_font_support");
  });

  it("6.2.1 ai_provider_support — STT, TTS, translation", () => {
    const c = LANGUAGE_READINESS_CRITERIA.find((c) => c.criterion === "ai_provider_support");
    expect(c?.title).toBe("AI Provider Support");
    expect(c?.description).toContain("STT");
    expect(c?.description).toContain("TTS");
    expect(c?.description).toContain("translation");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.2.2 native_speaker_reviewer — reviewer available", () => {
    const c = LANGUAGE_READINESS_CRITERIA.find((c) => c.criterion === "native_speaker_reviewer");
    expect(c?.title).toBe("Native-Speaker Reviewer Available");
    expect(c?.description).toContain("native-speaker reviewer");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.2.3 translation_quality — translations available at quality", () => {
    const c = LANGUAGE_READINESS_CRITERIA.find((c) => c.criterion === "translation_quality");
    expect(c?.title).toBe("Translation Quality");
    expect(c?.description).toContain("quality");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.2.4 script_font_support — script supported by our fonts", () => {
    const c = LANGUAGE_READINESS_CRITERIA.find((c) => c.criterion === "script_font_support");
    expect(c?.title).toBe("Script + Font Support");
    expect(c?.description).toContain("script");
    expect(c?.description).toContain("fonts");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.3 has 5 payment-readiness criteria", () => {
    expect(PAYMENT_READINESS_CRITERIA).toHaveLength(5);
    const criteria = PAYMENT_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("provider_support");
    expect(criteria).toContain("card_usage");
    expect(criteria).toContain("mobile_money_dominant");
    expect(criteria).toContain("payouts_possible");
    expect(criteria).toContain("multi_currency");
  });

  it("6.3.1 provider_support — Stripe/Paystack/Flutterwave", () => {
    const c = PAYMENT_READINESS_CRITERIA.find((c) => c.criterion === "provider_support");
    expect(c?.title).toBe("Provider Support");
    expect(c?.description).toContain("Stripe");
    expect(c?.description).toContain("Paystack");
    expect(c?.description).toContain("Flutterwave");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.3.2 card_usage — cards widely used", () => {
    const c = PAYMENT_READINESS_CRITERIA.find((c) => c.criterion === "card_usage");
    expect(c?.title).toBe("Card Usage");
    expect(c?.description).toContain("cards widely used");
    expect(c?.implemented).toBe(true);
  });

  it("6.3.3 mobile_money_dominant — mobile money dominant", () => {
    const c = PAYMENT_READINESS_CRITERIA.find((c) => c.criterion === "mobile_money_dominant");
    expect(c?.title).toBe("Mobile Money Dominant");
    expect(c?.description).toContain("mobile money dominant");
    expect(c?.implemented).toBe(true);
  });

  it("6.3.4 payouts_possible — payouts possible", () => {
    const c = PAYMENT_READINESS_CRITERIA.find((c) => c.criterion === "payouts_possible");
    expect(c?.title).toBe("Payouts Possible");
    expect(c?.description.toLowerCase()).toContain("payouts to users");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.3.5 multi_currency — multi-currency supported", () => {
    const c = PAYMENT_READINESS_CRITERIA.find((c) => c.criterion === "multi_currency");
    expect(c?.title).toBe("Multi-Currency Supported");
    expect(c?.description.toLowerCase()).toContain("multi-currency");
    expect(c?.implemented).toBe(true);
  });

  it("6.4 has 5 legal-readiness criteria", () => {
    expect(LEGAL_READINESS_CRITERIA).toHaveLength(5);
    const criteria = LEGAL_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("data_residency_requirement");
    expect(criteria).toContain("consumer_protection_laws");
    expect(criteria).toContain("content_laws");
    expect(criteria).toContain("dpa_requirement");
    expect(criteria).toContain("tax_requirements");
  });

  it("6.4.1 data_residency_requirement — data residency required", () => {
    const c = LEGAL_READINESS_CRITERIA.find((c) => c.criterion === "data_residency_requirement");
    expect(c?.title).toBe("Data Residency Requirement");
    expect(c?.description).toContain("data residency");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.4.2 consumer_protection_laws — local terms required", () => {
    const c = LEGAL_READINESS_CRITERIA.find((c) => c.criterion === "consumer_protection_laws");
    expect(c?.title).toBe("Consumer Protection Laws");
    expect(c?.description).toContain("local terms");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.4.3 content_laws — moderation required", () => {
    const c = LEGAL_READINESS_CRITERIA.find((c) => c.criterion === "content_laws");
    expect(c?.title).toBe("Content Laws");
    expect(c?.description).toContain("moderation");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.4.4 dpa_requirement — DPA required", () => {
    const c = LEGAL_READINESS_CRITERIA.find((c) => c.criterion === "dpa_requirement");
    expect(c?.title).toBe("DPA Requirement");
    // Spec text spells it out as "Data Processing Agreement" — title carries the acronym.
    expect(c?.title.toLowerCase()).toContain("dpa");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.4.5 tax_requirements — tax requirements", () => {
    const c = LEGAL_READINESS_CRITERIA.find((c) => c.criterion === "tax_requirements");
    expect(c?.title).toBe("Tax Requirements");
    expect(c?.description).toContain("tax");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("all evaluation criteria are implemented + composite function exists", () => {
    const v = verifyEvaluationStage();
    expect(v.marketFitCriteria).toBe(4);
    expect(v.languageReadinessCriteria).toBe(4);
    expect(v.paymentReadinessCriteria).toBe(5);
    expect(v.legalReadinessCriteria).toBe(5);
    expect(v.taxReadinessCriteria).toBe(3);
    expect(v.infrastructureReadinessCriteria).toBe(3);
    expect(v.supportReadinessCriteria).toBe(3);
    expect(v.culturalReadinessCriteria).toBe(4);
    expect(v.totalCriteria).toBe(4 + 4 + 5 + 5 + 3 + 3 + 3 + 4); // 31 criteria total.
    expect(v.compositeFunctionImplemented).toBe(true);
    expect(v.evaluationOutputImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("MarketFitCriterion is the union of 4 named criteria", () => {
    const c1: MarketFitCriterion = "population_penetration";
    const c2: MarketFitCriterion = "audience_size";
    const c3: MarketFitCriterion = "english_proficiency";
    const c4: MarketFitCriterion = "competitor_presence";
    expect([c1, c2, c3, c4]).toHaveLength(4);
  });

  it("LanguageReadinessCriterion is the union of 4 named criteria", () => {
    const c1: LanguageReadinessCriterion = "ai_provider_support";
    const c2: LanguageReadinessCriterion = "native_speaker_reviewer";
    const c3: LanguageReadinessCriterion = "translation_quality";
    const c4: LanguageReadinessCriterion = "script_font_support";
    expect([c1, c2, c3, c4]).toHaveLength(4);
  });

  it("PaymentReadinessCriterion is the union of 5 named criteria", () => {
    const c1: PaymentReadinessCriterion = "provider_support";
    const c2: PaymentReadinessCriterion = "card_usage";
    const c3: PaymentReadinessCriterion = "mobile_money_dominant";
    const c4: PaymentReadinessCriterion = "payouts_possible";
    const c5: PaymentReadinessCriterion = "multi_currency";
    expect([c1, c2, c3, c4, c5]).toHaveLength(5);
  });

  it("LegalReadinessCriterion is the union of 5 named criteria", () => {
    const c1: LegalReadinessCriterion = "data_residency_requirement";
    const c2: LegalReadinessCriterion = "consumer_protection_laws";
    const c3: LegalReadinessCriterion = "content_laws";
    const c4: LegalReadinessCriterion = "dpa_requirement";
    const c5: LegalReadinessCriterion = "tax_requirements";
    expect([c1, c2, c3, c4, c5]).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 6.5 Tax readiness — 3 criteria
// ───────────────────────────────────────────────

describe("6.5 — Tax readiness", () => {
  it("has 3 tax-readiness criteria", () => {
    expect(TAX_READINESS_CRITERIA).toHaveLength(3);
    const criteria = TAX_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("vat_gst_sales_tax_applicable");
    expect(criteria).toContain("tax_registration_required");
    expect(criteria).toContain("digital_services_tax");
  });

  it("6.5.1 vat_gst_sales_tax_applicable — VAT/GST/sales tax applicable", () => {
    const c = TAX_READINESS_CRITERIA.find((c) => c.criterion === "vat_gst_sales_tax_applicable");
    expect(c?.title).toBe("VAT / GST / Sales Tax Applicable");
    expect(c?.description.toLowerCase()).toContain("vat");
    expect(c?.description.toLowerCase()).toContain("gst");
    expect(c?.description.toLowerCase()).toContain("sales tax");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.5.2 tax_registration_required — tax registration requirement", () => {
    const c = TAX_READINESS_CRITERIA.find((c) => c.criterion === "tax_registration_required");
    expect(c?.title).toBe("Tax Registration Requirement");
    expect(c?.description.toLowerCase()).toContain("tax registration");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.5.3 digital_services_tax — DST applicable", () => {
    const c = TAX_READINESS_CRITERIA.find((c) => c.criterion === "digital_services_tax");
    expect(c?.title).toBe("Digital Services Tax");
    expect(c?.description.toLowerCase()).toContain("digital services tax");
    expect(c?.hardBlocker).toBe(false); // DST is a cost, not a blocker.
    expect(c?.implemented).toBe(true);
  });

  it("TaxReadinessCriterion is the union of 3 named criteria", () => {
    const c1: TaxReadinessCriterion = "vat_gst_sales_tax_applicable";
    const c2: TaxReadinessCriterion = "tax_registration_required";
    const c3: TaxReadinessCriterion = "digital_services_tax";
    expect([c1, c2, c3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 6.6 Infrastructure readiness — 3 criteria
// ───────────────────────────────────────────────

describe("6.6 — Infrastructure readiness", () => {
  it("has 3 infrastructure-readiness criteria", () => {
    expect(INFRASTRUCTURE_READINESS_CRITERIA).toHaveLength(3);
    const criteria = INFRASTRUCTURE_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("regional_infra_location");
    expect(criteria).toContain("cdn_coverage");
    expect(criteria).toContain("latency_acceptable");
  });

  it("6.6.1 regional_infra_location — EU/US/APAC/Africa/LATAM", () => {
    const c = INFRASTRUCTURE_READINESS_CRITERIA.find((c) => c.criterion === "regional_infra_location");
    expect(c?.title).toBe("Regional Infrastructure Location");
    expect(c?.description.toLowerCase()).toContain("eu");
    expect(c?.description.toLowerCase()).toContain("us");
    expect(c?.description.toLowerCase()).toContain("apac");
    expect(c?.description.toLowerCase()).toContain("africa");
    expect(c?.description.toLowerCase()).toContain("latam");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.6.2 cdn_coverage — CDN coverage strong", () => {
    const c = INFRASTRUCTURE_READINESS_CRITERIA.find((c) => c.criterion === "cdn_coverage");
    expect(c?.title).toBe("CDN Coverage");
    expect(c?.description.toLowerCase()).toContain("cdn");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.6.3 latency_acceptable — latency acceptable", () => {
    const c = INFRASTRUCTURE_READINESS_CRITERIA.find((c) => c.criterion === "latency_acceptable");
    expect(c?.title).toBe("Latency Acceptable");
    expect(c?.description.toLowerCase()).toContain("latency");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("InfrastructureReadinessCriterion is the union of 3 named criteria", () => {
    const c1: InfrastructureReadinessCriterion = "regional_infra_location";
    const c2: InfrastructureReadinessCriterion = "cdn_coverage";
    const c3: InfrastructureReadinessCriterion = "latency_acceptable";
    expect([c1, c2, c3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 6.7 Support readiness — 3 criteria
// ───────────────────────────────────────────────

describe("6.7 — Support readiness", () => {
  it("has 3 support-readiness criteria", () => {
    expect(SUPPORT_READINESS_CRITERIA).toHaveLength(3);
    const criteria = SUPPORT_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("support_agents_speak_language");
    expect(criteria).toContain("support_hours_feasible");
    expect(criteria).toContain("escalation_paths");
  });

  it("6.7.1 support_agents_speak_language — agents speak the language", () => {
    const c = SUPPORT_READINESS_CRITERIA.find((c) => c.criterion === "support_agents_speak_language");
    expect(c?.title).toBe("Support Agents Speak Language");
    expect(c?.description.toLowerCase()).toContain("support agents");
    expect(c?.description.toLowerCase()).toContain("speak");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("6.7.2 support_hours_feasible — support hours feasible", () => {
    const c = SUPPORT_READINESS_CRITERIA.find((c) => c.criterion === "support_hours_feasible");
    expect(c?.title).toBe("Support Hours Feasible");
    expect(c?.description.toLowerCase()).toContain("support hours");
    expect(c?.description.toLowerCase()).toContain("feasible");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.7.3 escalation_paths — escalation paths", () => {
    const c = SUPPORT_READINESS_CRITERIA.find((c) => c.criterion === "escalation_paths");
    expect(c?.title).toBe("Escalation Paths");
    expect(c?.description.toLowerCase()).toContain("escalation");
    expect(c?.hardBlocker).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("SupportReadinessCriterion is the union of 3 named criteria", () => {
    const c1: SupportReadinessCriterion = "support_agents_speak_language";
    const c2: SupportReadinessCriterion = "support_hours_feasible";
    const c3: SupportReadinessCriterion = "escalation_paths";
    expect([c1, c2, c3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 6.8 Cultural readiness — 4 criteria
// ───────────────────────────────────────────────

describe("6.8 — Cultural readiness", () => {
  it("has 4 cultural-readiness criteria", () => {
    expect(CULTURAL_READINESS_CRITERIA).toHaveLength(4);
    const criteria = CULTURAL_READINESS_CRITERIA.map((c) => c.criterion);
    expect(criteria).toContain("imagery_color_naming");
    expect(criteria).toContain("rtl_requirements");
    expect(criteria).toContain("date_number_address");
    expect(criteria).toContain("sensitivities");
  });

  it("6.8.1 imagery_color_naming — imagery, color, naming conventions", () => {
    const c = CULTURAL_READINESS_CRITERIA.find((c) => c.criterion === "imagery_color_naming");
    expect(c?.title).toBe("Imagery, Color, and Naming Conventions");
    expect(c?.description.toLowerCase()).toContain("imagery");
    expect(c?.description.toLowerCase()).toContain("color");
    expect(c?.description.toLowerCase()).toContain("naming");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.8.2 rtl_requirements — RTL requirements", () => {
    const c = CULTURAL_READINESS_CRITERIA.find((c) => c.criterion === "rtl_requirements");
    expect(c?.title).toBe("RTL Requirements");
    expect(c?.description.toLowerCase()).toContain("rtl");
    expect(c?.hardBlocker).toBe(true); // RTL must work for the locale.
    expect(c?.implemented).toBe(true);
  });

  it("6.8.3 date_number_address — date, number, address formats", () => {
    const c = CULTURAL_READINESS_CRITERIA.find((c) => c.criterion === "date_number_address");
    expect(c?.title).toBe("Date, Number, and Address Formats");
    expect(c?.description.toLowerCase()).toContain("date");
    expect(c?.description.toLowerCase()).toContain("number");
    expect(c?.description.toLowerCase()).toContain("address");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("6.8.4 sensitivities — cultural sensitivities", () => {
    const c = CULTURAL_READINESS_CRITERIA.find((c) => c.criterion === "sensitivities");
    expect(c?.title).toBe("Cultural Sensitivities");
    expect(c?.description.toLowerCase()).toContain("sensitivities");
    expect(c?.hardBlocker).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("CulturalReadinessCriterion is the union of 4 named criteria", () => {
    const c1: CulturalReadinessCriterion = "imagery_color_naming";
    const c2: CulturalReadinessCriterion = "rtl_requirements";
    const c3: CulturalReadinessCriterion = "date_number_address";
    const c4: CulturalReadinessCriterion = "sensitivities";
    expect([c1, c2, c3, c4]).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 6 Evaluation Output — structured report
// ───────────────────────────────────────────────

describe("6 — Evaluation Output (structured report)", () => {
  it("EvaluationOutput type has the expected shape", () => {
    const out: EvaluationOutput = {
      regionCode: "us",
      dimensions: [
        { dimension: "market_fit", score: 80, confidence: "high", blockers: [], risks: [] },
      ],
      compositeScore: 80,
      compositeConfidence: "high",
      gaps: [{ dimension: "market_fit", gap: "test", severity: "risk" }],
      risksAndMitigations: [{ risk: "test", mitigation: "test", dimension: "market_fit" }],
      effort: {
        engineeringHours: 100,
        localizationHours: 80,
        legalHours: 60,
        supportHours: 40,
        totalHours: 280,
        estimatedCostUsd: 33600,
        estimatedWeeks: 7,
      },
      recommendedPriority: "P1_high",
      recommendation: "go",
      recommendationReason: "test",
      evaluatedAt: new Date(),
    };
    expect(out.regionCode).toBe("us");
    expect(out.compositeScore).toBe(80);
    expect(out.recommendation).toBe("go");
    expect(out.recommendedPriority).toBe("P1_high");
    expect(out.effort.totalHours).toBe(280);
    expect(out.dimensions).toHaveLength(1);
  });

  it("EffortEstimate type has the expected shape", () => {
    const e: EffortEstimate = {
      engineeringHours: 100,
      localizationHours: 80,
      legalHours: 60,
      supportHours: 40,
      totalHours: 280,
      estimatedCostUsd: 33600,
      estimatedWeeks: 7,
    };
    expect(e.totalHours).toBe(e.engineeringHours + e.localizationHours + e.legalHours + e.supportHours);
    expect(e.estimatedWeeks).toBeGreaterThan(0);
  });

  it("RecommendedPriority is the union of 5 priority levels", () => {
    const p0: RecommendedPriority = "P0_critical";
    const p1: RecommendedPriority = "P1_high";
    const p2: RecommendedPriority = "P2_medium";
    const p3: RecommendedPriority = "P3_low";
    const p4: RecommendedPriority = "P4_backlog";
    expect([p0, p1, p2, p3, p4]).toHaveLength(5);
  });

  it("DimensionResult type has score + confidence + blockers + risks", () => {
    const d: DimensionResult = {
      dimension: "test",
      score: 75,
      confidence: "medium",
      blockers: ["blocker1"],
      risks: ["risk1"],
    };
    expect(d.score).toBe(75);
    expect(d.confidence).toBe("medium");
    expect(d.blockers).toHaveLength(1);
    expect(d.risks).toHaveLength(1);
  });

  it("the 8 dimensions cover every readiness aspect from the spec", () => {
    const v = verifyEvaluationStage();
    // market fit + language + payment + legal + tax + infrastructure + support + cultural = 8.
    const totalDimensionLists = [
      v.marketFitCriteria,
      v.languageReadinessCriteria,
      v.paymentReadinessCriteria,
      v.legalReadinessCriteria,
      v.taxReadinessCriteria,
      v.infrastructureReadinessCriteria,
      v.supportReadinessCriteria,
      v.culturalReadinessCriteria,
    ];
    expect(totalDimensionLists).toHaveLength(8);
    expect(v.totalCriteria).toBe(31); // 4+4+5+5+3+3+3+4.
  });
});
