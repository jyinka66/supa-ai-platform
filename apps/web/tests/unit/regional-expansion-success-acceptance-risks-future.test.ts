/**
 * Regional Expansion Playbook — Sections 17 (Measurement of Success),
 * 18 (Acceptance Criteria), 19 (Risks & Mitigations), 20 (The Autonomous
 * Regional Expansion Future) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  SUCCESS_CRITERIA,
  verifySuccessMeasurement,
  type SuccessCriterionId,
  type SuccessVerdict,
  type SuccessMeasurement,
} from "@/lib/expansion/measurement-success";
import {
  ACCEPTANCE_CRITERIA,
  verifyAcceptanceCriteria,
  getAcceptanceCriterion,
  getPlaybookReadinessSummary,
} from "@/lib/expansion/acceptance-criteria";
import {
  RISKS_AND_MITIGATIONS,
  verifyRisksAndMitigations,
  getRisk,
  getRisksByCategory,
  getResidualRiskSummary,
  type RiskCategory,
  type RiskLikelihood,
  type RiskImpact,
  type RiskMitigation,
  type RiskSpec,
} from "@/lib/expansion/risks-mitigations";
import {
  EXPANSION_PILLARS,
  CLOSING_THESIS,
  CLOSING_STATEMENT,
  verifyExpansionFuture,
  getPillar,
  getRealizationSummary,
  type ExpansionPillar,
  type ClosingThesisStatement,
} from "@/lib/expansion/expansion-future";

// ───────────────────────────────────────────────
// 17. Measurement of Success — 8 criteria
// ───────────────────────────────────────────────

describe("17 — Measurement of Success", () => {
  it("has 8 success criteria", () => {
    expect(SUCCESS_CRITERIA).toHaveLength(8);
    const ids = SUCCESS_CRITERIA.map((c) => c.id);
    expect(ids).toContain("first_class_language_experience");
    expect(ids).toContain("payments_work");
    expect(ids).toContain("compliance_verified");
    expect(ids).toContain("support_in_language");
    expect(ids).toContain("retention_revenue_match_global");
    expect(ids).toContain("churn_comparable");
    expect(ids).toContain("nps_positive");
    expect(ids).toContain("contributes_to_growth");
  });

  it("all 8 criteria are implemented", () => {
    const v = verifySuccessMeasurement();
    expect(v.implementedCriteria).toBe(8);
    expect(v.totalCriteria).toBe(8);
    expect(v.allImplemented).toBe(true);
  });

  it("7 hard requirements + 1 soft requirement (contributes_to_growth)", () => {
    const v = verifySuccessMeasurement();
    expect(v.hardRequirements).toBe(7);
    expect(v.softRequirements).toBe(1);
  });

  it("17.1 first-class experience in their language (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "first_class_language_experience");
    expect(c?.number).toBe("17.1");
    expect(c?.title.toLowerCase()).toContain("first-class");
    expect(c?.title.toLowerCase()).toContain("language");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.2 payments work in their currency and method (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "payments_work");
    expect(c?.number).toBe("17.2");
    expect(c?.title.toLowerCase()).toContain("payments work");
    expect(c?.title.toLowerCase()).toContain("currency");
    expect(c?.title.toLowerCase()).toContain("method");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.3 legal and tax compliance verified (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "compliance_verified");
    expect(c?.number).toBe("17.3");
    expect(c?.title.toLowerCase()).toContain("compliance");
    expect(c?.title.toLowerCase()).toContain("verified");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.4 support available in their language (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "support_in_language");
    expect(c?.number).toBe("17.4");
    expect(c?.title.toLowerCase()).toContain("support");
    expect(c?.title.toLowerCase()).toContain("language");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.5 retention and revenue match or exceed global (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "retention_revenue_match_global");
    expect(c?.number).toBe("17.5");
    expect(c?.title.toLowerCase()).toContain("retention");
    expect(c?.title.toLowerCase()).toContain("revenue");
    expect(c?.title.toLowerCase()).toContain("global");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.6 churn comparable to global (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "churn_comparable");
    expect(c?.number).toBe("17.6");
    expect(c?.title.toLowerCase()).toContain("churn");
    expect(c?.title.toLowerCase()).toContain("global");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.7 NPS is positive (hard)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "nps_positive");
    expect(c?.number).toBe("17.7");
    expect(c?.title.toLowerCase()).toContain("nps");
    expect(c?.title.toLowerCase()).toContain("positive");
    expect(c?.hardRequirement).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("17.8 region contributes to platform growth (soft)", () => {
    const c = SUCCESS_CRITERIA.find((c) => c.id === "contributes_to_growth");
    expect(c?.number).toBe("17.8");
    expect(c?.title.toLowerCase()).toContain("contributes");
    expect(c?.title.toLowerCase()).toContain("growth");
    expect(c?.hardRequirement).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("measurement function is implemented", () => {
    const v = verifySuccessMeasurement();
    expect(v.measurementFunctionImplemented).toBe(true);
  });

  it("SuccessCriterionId is the union of 8 named ids", () => {
    const ids: SuccessCriterionId[] = [
      "first_class_language_experience", "payments_work", "compliance_verified",
      "support_in_language", "retention_revenue_match_global", "churn_comparable",
      "nps_positive", "contributes_to_growth",
    ];
    expect(ids).toHaveLength(8);
  });

  it("SuccessVerdict is the union of successful / partial / not_successful", () => {
    const v1: SuccessVerdict = "successful";
    const v2: SuccessVerdict = "partial";
    const v3: SuccessVerdict = "not_successful";
    expect([v1, v2, v3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 18. Acceptance Criteria — 20 criteria
// ───────────────────────────────────────────────

describe("18 — Acceptance Criteria (20 criteria)", () => {
  it("has 20 acceptance criteria", () => {
    expect(ACCEPTANCE_CRITERIA).toHaveLength(20);
    const ids = ACCEPTANCE_CRITERIA.map((c) => c.id);
    expect(ids[0]).toBe("AC01");
    expect(ids[19]).toBe("AC20");
  });

  it("all 20 criteria are implemented", () => {
    const v = verifyAcceptanceCriteria();
    expect(v.implementedCriteria).toBe(20);
    expect(v.allImplemented).toBe(true);
  });

  it("every criterion has enforcedBy + verificationMethod", () => {
    for (const c of ACCEPTANCE_CRITERIA) {
      expect(c.enforcedBy.length).toBeGreaterThan(0);
      expect(c.verificationMethod.length).toBeGreaterThan(0);
      expect(c.implemented).toBe(true);
    }
  });

  it("AC01: detection thresholds defined and monitored", () => {
    const c = getAcceptanceCriterion("AC01");
    expect(c?.title.toLowerCase()).toContain("detection thresholds");
    expect(c?.enforcedBy).toContain("stage-detection.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC02: evaluation criteria documented and automated", () => {
    const c = getAcceptanceCriterion("AC02");
    expect(c?.title.toLowerCase()).toContain("evaluation criteria");
    expect(c?.enforcedBy).toContain("stage-evaluation.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC03: prioritization scoring live", () => {
    const c = getAcceptanceCriterion("AC03");
    expect(c?.title.toLowerCase()).toContain("prioritization scoring");
    expect(c?.enforcedBy).toContain("stage-prioritization.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC04: preparation workstreams defined and automated", () => {
    const c = getAcceptanceCriterion("AC04");
    expect(c?.title.toLowerCase()).toContain("preparation workstreams");
    expect(c?.enforcedBy).toContain("stage-preparation.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC05: verification checklist defined and automated", () => {
    const c = getAcceptanceCriterion("AC05");
    expect(c?.title.toLowerCase()).toContain("verification checklist");
    expect(c?.enforcedBy).toContain("stage-verification.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC06: soft launch process defined and executed", () => {
    const c = getAcceptanceCriterion("AC06");
    expect(c?.title.toLowerCase()).toContain("soft launch");
    expect(c?.enforcedBy).toContain("stage-soft-launch.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC07: public launch process defined and executed", () => {
    const c = getAcceptanceCriterion("AC07");
    expect(c?.title.toLowerCase()).toContain("public launch");
    expect(c?.enforcedBy).toContain("stage-public-launch.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC08: monitoring dashboards live per region", () => {
    const c = getAcceptanceCriterion("AC08");
    expect(c?.title.toLowerCase()).toContain("monitoring dashboards");
    expect(c?.enforcedBy).toContain("stage-monitoring.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC09: optimization loop active", () => {
    const c = getAcceptanceCriterion("AC09");
    expect(c?.title.toLowerCase()).toContain("optimization loop");
    expect(c?.enforcedBy).toContain("stage-optimization.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC10: human checkpoints defined and enforced", () => {
    const c = getAcceptanceCriterion("AC10");
    expect(c?.title.toLowerCase()).toContain("human checkpoints");
    expect(c?.enforcedBy).toContain("autonomous-execution.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC11: rollback paths defined and tested per stage", () => {
    const c = getAcceptanceCriterion("AC11");
    expect(c?.title.toLowerCase()).toContain("rollback paths");
    expect(c?.enforcedBy).toContain("rollback-retirement.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC12: retirement process defined and communicated", () => {
    const c = getAcceptanceCriterion("AC12");
    expect(c?.title.toLowerCase()).toContain("retirement process");
    expect(c?.enforcedBy).toContain("rollback-retirement.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC13: governance integration complete", () => {
    const c = getAcceptanceCriterion("AC13");
    expect(c?.title.toLowerCase()).toContain("governance integration");
    expect(c?.enforcedBy).toContain("governance-integration.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC14: region success measured on user outcomes, not launch events", () => {
    const c = getAcceptanceCriterion("AC14");
    expect(c?.title.toLowerCase()).toContain("user outcomes");
    expect(c?.title.toLowerCase()).toContain("not launch events");
    expect(c?.enforcedBy).toContain("measurement-success.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC15: new region can be detected/evaluated/prepared/verified/launched/monitored autonomously", () => {
    const c = getAcceptanceCriterion("AC15");
    expect(c?.title.toLowerCase()).toContain("autonomously");
    expect(c?.enforcedBy).toContain("autonomous-execution.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC16: adding region 20 is the same operation as adding region 2", () => {
    const c = getAcceptanceCriterion("AC16");
    expect(c?.title.toLowerCase()).toContain("region 20");
    expect(c?.title.toLowerCase()).toContain("region 2");
    expect(c?.implemented).toBe(true);
  });

  it("AC17: every region is audit-ready", () => {
    const c = getAcceptanceCriterion("AC17");
    expect(c?.title.toLowerCase()).toContain("audit-ready");
    expect(c?.enforcedBy).toContain("governance-decision-log.ts");
    expect(c?.enforcedBy).toContain("governance-audit-trail.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC18: compliance evidence collected automatically", () => {
    const c = getAcceptanceCriterion("AC18");
    expect(c?.title.toLowerCase()).toContain("compliance evidence");
    expect(c?.enforcedBy).toContain("governance-dashboards.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC19: regional economics tracked per region", () => {
    const c = getAcceptanceCriterion("AC19");
    expect(c?.title.toLowerCase()).toContain("regional economics");
    expect(c?.enforcedBy).toContain("stage-monitoring.ts");
    expect(c?.implemented).toBe(true);
  });

  it("AC20: regions can be paused or retired without affecting others", () => {
    const c = getAcceptanceCriterion("AC20");
    expect(c?.title.toLowerCase()).toContain("paused or retired");
    expect(c?.title.toLowerCase()).toContain("without affecting others");
    expect(c?.enforcedBy).toContain("rollback-retirement.ts");
    expect(c?.enforcedBy).toContain("governance/rollback.ts");
    expect(c?.implemented).toBe(true);
  });

  it("getPlaybookReadinessSummary returns PLAYBOOK READY", () => {
    const summary = getPlaybookReadinessSummary();
    expect(summary).toContain("20/20");
    expect(summary).toContain("PLAYBOOK READY");
  });
});

// ───────────────────────────────────────────────
// 19. Risks & Mitigations — 12 risks
// ───────────────────────────────────────────────

describe("19 — Risks and Mitigations (12 risks)", () => {
  it("has 12 risks", () => {
    expect(RISKS_AND_MITIGATIONS).toHaveLength(12);
    const ids = RISKS_AND_MITIGATIONS.map((r) => r.id);
    expect(ids[0]).toBe("R01");
    expect(ids[11]).toBe("R12");
  });

  it("all 12 risks are mitigated (all mitigations implemented)", () => {
    const v = verifyRisksAndMitigations();
    expect(v.mitigatedRisks).toBe(12);
    expect(v.allImplemented).toBe(true);
  });

  it("every risk has at least 1 mitigation", () => {
    for (const r of RISKS_AND_MITIGATIONS) {
      expect(r.mitigations.length).toBeGreaterThanOrEqual(1);
      expect(r.implemented).toBe(true);
    }
  });

  it("every mitigation is implemented", () => {
    const v = verifyRisksAndMitigations();
    expect(v.implementedMitigations).toBe(v.totalMitigations);
  });

  it("R01 compliance gaps → legal review + tax review + automated evidence", () => {
    const r = getRisk("R01");
    expect(r?.risk.toLowerCase()).toContain("compliance gaps");
    expect(r?.category).toBe("compliance");
    expect(r?.mitigations.map((m) => m.name)).toContain("Legal review");
    expect(r?.mitigations.map((m) => m.name)).toContain("Tax review");
    expect(r?.mitigations.map((m) => m.name)).toContain("Automated evidence");
    expect(r?.implemented).toBe(true);
  });

  it("R02 translation quality issues → AI + native speaker + QA + glossary", () => {
    const r = getRisk("R02");
    expect(r?.risk.toLowerCase()).toContain("translation quality");
    expect(r?.category).toBe("localization");
    expect(r?.mitigations.map((m) => m.name)).toContain("AI translation");
    expect(r?.mitigations.map((m) => m.name)).toContain("Native speaker review");
    expect(r?.mitigations.map((m) => m.name)).toContain("Automated QA");
    expect(r?.mitigations.map((m) => m.name)).toContain("Glossary");
    expect(r?.implemented).toBe(true);
  });

  it("R03 payment method gaps → multi-provider + phased rollout", () => {
    const r = getRisk("R03");
    expect(r?.risk.toLowerCase()).toContain("payment method gaps");
    expect(r?.category).toBe("payments");
    expect(r?.mitigations.map((m) => m.name)).toContain("Multi-provider strategy");
    expect(r?.mitigations.map((m) => m.name)).toContain("Phased rollout");
    expect(r?.implemented).toBe(true);
  });

  it("R04 data residency violations → enforced at infrastructure + verified", () => {
    const r = getRisk("R04");
    expect(r?.risk.toLowerCase()).toContain("data residency");
    expect(r?.category).toBe("infrastructure");
    expect(r?.mitigations.map((m) => m.name)).toContain("Enforced at infrastructure");
    expect(r?.mitigations.map((m) => m.name)).toContain("Verified");
    expect(r?.implemented).toBe(true);
  });

  it("R05 cultural missteps → cultural review before launch", () => {
    const r = getRisk("R05");
    expect(r?.risk.toLowerCase()).toContain("cultural missteps");
    expect(r?.category).toBe("cultural");
    expect(r?.mitigations.map((m) => m.name)).toContain("Cultural review before launch");
    expect(r?.implemented).toBe(true);
  });

  it("R06 support overwhelm → AI triage + self-service + threshold-based scaling", () => {
    const r = getRisk("R06");
    expect(r?.risk.toLowerCase()).toContain("support overwhelm");
    expect(r?.category).toBe("support");
    expect(r?.mitigations.map((m) => m.name)).toContain("AI triage");
    expect(r?.mitigations.map((m) => m.name)).toContain("Self-service");
    expect(r?.mitigations.map((m) => m.name)).toContain("Threshold-based scaling");
    expect(r?.implemented).toBe(true);
  });

  it("R07 over-expansion → threshold-based + prioritization scoring", () => {
    const r = getRisk("R07");
    expect(r?.risk.toLowerCase()).toContain("over-expansion");
    expect(r?.category).toBe("expansion");
    expect(r?.mitigations.map((m) => m.name)).toContain("Threshold-based");
    expect(r?.mitigations.map((m) => m.name)).toContain("Prioritization scoring");
    expect(r?.implemented).toBe(true);
  });

  it("R08 under-expansion → demand detection + human override to prioritize", () => {
    const r = getRisk("R08");
    expect(r?.risk.toLowerCase()).toContain("under-expansion");
    expect(r?.category).toBe("expansion");
    expect(r?.mitigations.map((m) => m.name)).toContain("Demand detection");
    expect(r?.mitigations.map((m) => m.name)).toContain("Human override to prioritize");
    expect(r?.implemented).toBe(true);
  });

  it("R09 cost overruns per region → cost tracking + circuit breakers", () => {
    const r = getRisk("R09");
    expect(r?.risk.toLowerCase()).toContain("cost overruns");
    expect(r?.category).toBe("cost");
    expect(r?.mitigations.map((m) => m.name)).toContain("Cost tracking per region");
    expect(r?.mitigations.map((m) => m.name)).toContain("Circuit breakers");
    expect(r?.implemented).toBe(true);
  });

  it("R10 regulatory changes → monitoring + alerts + rapid update pipeline", () => {
    const r = getRisk("R10");
    expect(r?.risk.toLowerCase()).toContain("regulatory changes");
    expect(r?.category).toBe("regulatory");
    expect(r?.mitigations.map((m) => m.name)).toContain("Monitoring");
    expect(r?.mitigations.map((m) => m.name)).toContain("Alerts");
    expect(r?.mitigations.map((m) => m.name)).toContain("Rapid update pipeline");
    expect(r?.implemented).toBe(true);
  });

  it("R11 competitor moves → monitoring + response playbook", () => {
    const r = getRisk("R11");
    expect(r?.risk.toLowerCase()).toContain("competitor moves");
    expect(r?.category).toBe("competitive");
    expect(r?.mitigations.map((m) => m.name)).toContain("Monitoring");
    expect(r?.mitigations.map((m) => m.name)).toContain("Response playbook");
    expect(r?.implemented).toBe(true);
  });

  it("R12 region retirement difficult → clear process + user communication + data portability", () => {
    const r = getRisk("R12");
    expect(r?.risk.toLowerCase()).toContain("retirement difficult");
    expect(r?.category).toBe("retirement");
    expect(r?.mitigations.map((m) => m.name)).toContain("Clear process");
    expect(r?.mitigations.map((m) => m.name)).toContain("User communication");
    expect(r?.mitigations.map((m) => m.name)).toContain("Data portability");
    expect(r?.implemented).toBe(true);
  });

  it("highest residual risk across all risks is low or medium", () => {
    const v = verifyRisksAndMitigations();
    expect(["low", "medium"]).toContain(v.highestResidualRisk);
  });

  it("getResidualRiskSummary mentions mitigated/total counts", () => {
    const summary = getResidualRiskSummary();
    expect(summary).toContain("12/12");
    expect(summary).toContain("risks mitigated");
    expect(summary).toContain("residual");
  });

  it("getRisksByCategory groups risks correctly", () => {
    const expansionRisks = getRisksByCategory("expansion");
    expect(expansionRisks.length).toBe(2); // R07 + R08.
    expect(expansionRisks.map((r) => r.id)).toContain("R07");
    expect(expansionRisks.map((r) => r.id)).toContain("R08");
  });

  it("RiskCategory covers 11 categories", () => {
    const cats: RiskCategory[] = [
      "compliance", "localization", "payments", "infrastructure",
      "cultural", "support", "expansion", "cost", "regulatory",
      "competitive", "retirement",
    ];
    expect(new Set(cats).size).toBe(11);
  });
});

// ───────────────────────────────────────────────
// 20. The Autonomous Regional Expansion Future — 11 pillars + thesis
// ───────────────────────────────────────────────

describe("20 — The Autonomous Regional Expansion Future", () => {
  it("has 11 pillars", () => {
    expect(EXPANSION_PILLARS).toHaveLength(11);
    const ids = EXPANSION_PILLARS.map((p) => p.id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("all 11 pillars are implemented", () => {
    const v = verifyExpansionFuture();
    expect(v.implementedPillars).toBe(11);
    expect(v.totalPillars).toBe(11);
  });

  it("every pillar has enforcedBy + specSections", () => {
    for (const p of EXPANSION_PILLARS) {
      expect(p.enforcedBy.length).toBeGreaterThan(0);
      expect(p.specSections.length).toBeGreaterThan(0);
      expect(p.implemented).toBe(true);
    }
  });

  it("pillar 1: Global by default", () => {
    const p = getPillar(1);
    expect(p?.name.toLowerCase()).toContain("global by default");
    expect(p?.description.toLowerCase()).toContain("onboard itself");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 2: Demand-driven", () => {
    const p = getPillar(2);
    expect(p?.name.toLowerCase()).toContain("demand-driven");
    expect(p?.description.toLowerCase()).toContain("users are already there");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 3: Compliance-ready", () => {
    const p = getPillar(3);
    expect(p?.name.toLowerCase()).toContain("compliance-ready");
    expect(p?.description.toLowerCase()).toContain("legal, tax, and residency verified");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 4: Payment-ready", () => {
    const p = getPillar(4);
    expect(p?.name.toLowerCase()).toContain("payment-ready");
    expect(p?.description.toLowerCase()).toContain("local methods and currencies");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 5: Language-ready", () => {
    const p = getPillar(5);
    expect(p?.name.toLowerCase()).toContain("language-ready");
    expect(p?.description.toLowerCase()).toContain("native experience");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 6: Support-ready", () => {
    const p = getPillar(6);
    expect(p?.name.toLowerCase()).toContain("support-ready");
    expect(p?.description.toLowerCase()).toContain("in-language support");
    expect(p?.description.toLowerCase()).toContain("sla");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 7: Culture-aware", () => {
    const p = getPillar(7);
    expect(p?.name.toLowerCase()).toContain("culture-aware");
    expect(p?.description.toLowerCase()).toContain("local norms");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 8: Observable", () => {
    const p = getPillar(8);
    expect(p?.name.toLowerCase()).toContain("observable");
    expect(p?.description.toLowerCase()).toContain("measured continuously");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 9: Optimized", () => {
    const p = getPillar(9);
    expect(p?.name.toLowerCase()).toContain("optimized");
    expect(p?.description.toLowerCase()).toContain("improves continuously");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 10: Reversible", () => {
    const p = getPillar(10);
    expect(p?.name.toLowerCase()).toContain("reversible");
    expect(p?.description.toLowerCase()).toContain("paused or retired");
    expect(p?.description.toLowerCase()).toContain("without affecting others");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 11: Auditable", () => {
    const p = getPillar(11);
    expect(p?.name.toLowerCase()).toContain("auditable");
    expect(p?.description.toLowerCase()).toContain("every decision logged");
    expect(p?.description.toLowerCase()).toContain("evidence collected");
    expect(p?.implemented).toBe(true);
  });

  it("has 3 closing thesis statements", () => {
    expect(CLOSING_THESIS).toHaveLength(3);
    const ids = CLOSING_THESIS.map((t) => t.id);
    expect(ids).toEqual(["T1", "T2", "T3"]);
  });

  it("all 3 thesis statements are implemented", () => {
    const v = verifyExpansionFuture();
    expect(v.implementedThesisStatements).toBe(3);
    expect(v.totalThesisStatements).toBe(3);
  });

  it("T1: Humans set direction", () => {
    const t = CLOSING_THESIS.find((t) => t.id === "T1");
    expect(t?.statement).toBe("Humans set direction.");
    expect(t?.enforcedBy.length).toBeGreaterThan(0);
    expect(t?.implemented).toBe(true);
  });

  it("T2: The playbook executes", () => {
    const t = CLOSING_THESIS.find((t) => t.id === "T2");
    expect(t?.statement).toBe("The playbook executes.");
    expect(t?.enforcedBy.length).toBeGreaterThan(0);
    expect(t?.implemented).toBe(true);
  });

  it("T3: Users get a first-class experience in their own language, currency, and legal context", () => {
    const t = CLOSING_THESIS.find((t) => t.id === "T3");
    expect(t?.statement).toBe("Users get a first-class experience in their own language, currency, and legal context.");
    expect(t?.enforcedBy.length).toBeGreaterThan(0);
    expect(t?.implemented).toBe(true);
  });

  it("closing statement matches the spec text exactly", () => {
    expect(CLOSING_STATEMENT).toBe(
      "Humans set direction. The playbook executes. Users get a first-class " +
        "experience in their own language, currency, and legal context.",
    );
  });

  it("closing statement contains all 3 thesis statements", () => {
    expect(CLOSING_STATEMENT).toContain("Humans set direction.");
    expect(CLOSING_STATEMENT).toContain("The playbook executes.");
    expect(CLOSING_STATEMENT).toContain("Users get a first-class experience in their own language, currency, and legal context.");
  });

  it("verifyExpansionFuture() reports playbookRealized=true", () => {
    const v = verifyExpansionFuture();
    expect(v.playbookRealized).toBe(true);
    expect(v.closingStatementMatchesSpec).toBe(true);
  });

  it("getRealizationSummary returns PLAYBOOK REALIZED", () => {
    const summary = getRealizationSummary();
    expect(summary).toContain("11/11 pillars");
    expect(summary).toContain("3/3 thesis statements");
    expect(summary).toContain("PLAYBOOK REALIZED");
  });
});
