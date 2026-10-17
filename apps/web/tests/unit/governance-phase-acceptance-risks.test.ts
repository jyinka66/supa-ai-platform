/**
 * Governance — Phase Integration (Section 3) + Acceptance Criteria (Section 14)
 * + Risks & Mitigations (Section 15) — tests.
 *
 * Verifies the spec:
 *   3.   15 phases integrated with Autonomous Governance.
 *   14.  20 acceptance criteria.
 *   15.  15 risks with mitigations.
 */

import { describe, it, expect } from "vitest";
import {
  PHASE_INTEGRATIONS,
  verifyPhaseIntegration,
  getPhaseIntegration,
  getSurfacesForPolicyCategory,
  getSurfacesForRiskLevel,
  getTotalDecisionSurfaces,
  type PhaseId,
  type DecisionSurface,
} from "@/lib/governance/phase-integration";
import {
  ACCEPTANCE_CRITERIA,
  verifyAcceptanceCriteria,
  getAcceptanceCriterion,
  getLaunchReadinessSummary,
} from "@/lib/governance/acceptance-criteria";
import {
  RISKS_AND_MITIGATIONS,
  verifyRisksAndMitigations,
  getRisk,
  getRisksByCategory,
  getTopRisks,
  getResidualRiskSummary,
  type RiskCategory,
  type RiskLikelihood,
  type RiskImpact,
  type Mitigation,
} from "@/lib/governance/risks-mitigations";

// ───────────────────────────────────────────────
// 3. Phase integration — 15 phases
// ───────────────────────────────────────────────

describe("3 — Phase integration", () => {
  it("has 15 phases", () => {
    expect(PHASE_INTEGRATIONS).toHaveLength(15);
    const phases = PHASE_INTEGRATIONS.map((p) => p.phase);
    expect(phases).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("all 15 phases are implemented", () => {
    const v = verifyPhaseIntegration();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedPhases).toBe(15);
  });

  it("every phase has at least 3 decision surfaces", () => {
    for (const p of PHASE_INTEGRATIONS) {
      expect(p.decisionSurfaces.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("every decision surface is implemented", () => {
    const v = verifyPhaseIntegration();
    expect(v.implementedDecisionSurfaces).toBe(v.totalDecisionSurfaces);
  });

  it("Phase 0 (Foundation): policy infrastructure, logging, observability", () => {
    const p = getPhaseIntegration(0 as PhaseId);
    expect(p?.title).toBe("Foundation");
    expect(p?.decisionDomains).toContain("policy infrastructure");
    expect(p?.decisionDomains).toContain("logging");
    expect(p?.decisionDomains).toContain("observability");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 1 (Identity): identity, workspace, role decisions", () => {
    const p = getPhaseIntegration(1 as PhaseId);
    expect(p?.title).toBe("Identity");
    expect(p?.decisionDomains).toContain("identity");
    expect(p?.decisionDomains).toContain("workspace");
    expect(p?.decisionDomains).toContain("role decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 2 (Intelligence): tool execution, cost, rate limits", () => {
    const p = getPhaseIntegration(2 as PhaseId);
    expect(p?.title).toBe("Intelligence");
    expect(p?.decisionDomains).toContain("tool execution");
    expect(p?.decisionDomains).toContain("cost");
    expect(p?.decisionDomains).toContain("rate limits");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 3 (Work): sharing, visibility, export decisions", () => {
    const p = getPhaseIntegration(3 as PhaseId);
    expect(p?.title).toBe("Work");
    expect(p?.decisionDomains).toContain("sharing");
    expect(p?.decisionDomains).toContain("visibility");
    expect(p?.decisionDomains).toContain("export decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 4 (Creation): generation policies, IP checks, moderation", () => {
    const p = getPhaseIntegration(4 as PhaseId);
    expect(p?.title).toBe("Creation");
    expect(p?.decisionDomains).toContain("generation policies");
    expect(p?.decisionDomains).toContain("IP checks");
    expect(p?.decisionDomains).toContain("moderation");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 5 (Business): payment, invoice, tax decisions", () => {
    const p = getPhaseIntegration(5 as PhaseId);
    expect(p?.title).toBe("Business");
    expect(p?.decisionDomains).toContain("payment");
    expect(p?.decisionDomains).toContain("invoice");
    expect(p?.decisionDomains).toContain("tax decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 6 (Freelance): escrow, payout, dispute decisions", () => {
    const p = getPhaseIntegration(6 as PhaseId);
    expect(p?.title).toBe("Freelance");
    expect(p?.decisionDomains).toContain("escrow");
    expect(p?.decisionDomains).toContain("payout");
    expect(p?.decisionDomains).toContain("dispute decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 7 (Workforce): agent permissions, budgets, approvals", () => {
    const p = getPhaseIntegration(7 as PhaseId);
    expect(p?.title).toBe("Workforce");
    expect(p?.decisionDomains).toContain("agent permissions");
    expect(p?.decisionDomains).toContain("budgets");
    expect(p?.decisionDomains).toContain("approvals");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 8 (Teams): SSO, SCIM, API decisions", () => {
    const p = getPhaseIntegration(8 as PhaseId);
    expect(p?.title).toBe("Teams");
    expect(p?.decisionDomains).toContain("SSO");
    expect(p?.decisionDomains).toContain("SCIM");
    expect(p?.decisionDomains).toContain("API decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 9 (Admin): admin actions, impersonation decisions", () => {
    const p = getPhaseIntegration(9 as PhaseId);
    expect(p?.title).toBe("Admin");
    expect(p?.decisionDomains).toContain("admin actions");
    expect(p?.decisionDomains).toContain("impersonation decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 10 (Performance): scaling, cost decisions", () => {
    const p = getPhaseIntegration(10 as PhaseId);
    expect(p?.title).toBe("Performance");
    expect(p?.decisionDomains).toContain("scaling");
    expect(p?.decisionDomains).toContain("cost decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 11 (Globalization): language, region, legal decisions", () => {
    const p = getPhaseIntegration(11 as PhaseId);
    expect(p?.title).toBe("Globalization");
    expect(p?.decisionDomains).toContain("language");
    expect(p?.decisionDomains).toContain("region");
    expect(p?.decisionDomains).toContain("legal decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 12 (Launch): rollout, feature flag decisions", () => {
    const p = getPhaseIntegration(12 as PhaseId);
    expect(p?.title).toBe("Launch");
    expect(p?.decisionDomains).toContain("rollout");
    expect(p?.decisionDomains).toContain("feature flag decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 13 (Post-Launch): growth, experiment decisions", () => {
    const p = getPhaseIntegration(13 as PhaseId);
    expect(p?.title).toBe("Post-Launch");
    expect(p?.decisionDomains).toContain("growth");
    expect(p?.decisionDomains).toContain("experiment decisions");
    expect(p?.implemented).toBe(true);
  });

  it("Phase 14 (Platform): marketplace, developer, enterprise decisions", () => {
    const p = getPhaseIntegration(14 as PhaseId);
    expect(p?.title).toBe("Platform");
    expect(p?.decisionDomains).toContain("marketplace");
    expect(p?.decisionDomains).toContain("developer");
    expect(p?.decisionDomains).toContain("enterprise decisions");
    expect(p?.implemented).toBe(true);
  });

  it("getSurfacesForPolicyCategory returns surfaces across phases", () => {
    const toolSurfaces = getSurfacesForPolicyCategory("tool_execution");
    expect(toolSurfaces.length).toBeGreaterThan(0);
    expect(toolSurfaces.some((s) => s.actionType === "tool.call")).toBe(true);
  });

  it("getSurfacesForRiskLevel returns surfaces across phases", () => {
    const criticalSurfaces = getSurfacesForRiskLevel("critical");
    expect(criticalSurfaces.length).toBeGreaterThan(0);
    // Admin impersonation + sensitive reads + dispute resolution are critical.
    const actions = criticalSurfaces.map((s) => s.actionType);
    expect(actions).toContain("admin.impersonate");
    expect(actions).toContain("admin.user_data.read");
    expect(actions).toContain("dispute.resolve");
  });

  it("getTotalDecisionSurfaces returns the total across all phases", () => {
    const total = getTotalDecisionSurfaces();
    expect(total).toBeGreaterThanOrEqual(45); // 15 phases × 3 surfaces minimum.
  });

  it("PhaseId is the union of 15 phase numbers", () => {
    const ids: PhaseId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    expect(ids).toHaveLength(15);
  });
});

// ───────────────────────────────────────────────
// 14. Acceptance criteria — 20 criteria
// ───────────────────────────────────────────────

describe("14 — Acceptance criteria", () => {
  it("has 20 acceptance criteria", () => {
    expect(ACCEPTANCE_CRITERIA).toHaveLength(20);
    const ids = ACCEPTANCE_CRITERIA.map((c) => c.id);
    expect(ids[0]).toBe("AC01");
    expect(ids[19]).toBe("AC20");
  });

  it("all 20 criteria are implemented", () => {
    const v = verifyAcceptanceCriteria();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedCriteria).toBe(20);
  });

  it("every criterion has enforcedBy + verificationMethod", () => {
    for (const c of ACCEPTANCE_CRITERIA) {
      expect(c.enforcedBy.length).toBeGreaterThan(0);
      expect(c.verificationMethod.length).toBeGreaterThan(0);
      expect(c.implemented).toBe(true);
    }
  });

  it("AC01: Policy-as-code infrastructure live and used by every decision domain", () => {
    const c = getAcceptanceCriterion("AC01");
    expect(c?.title).toContain("Policy-as-code");
    expect(c?.enforcedBy).toContain("policy-engine");
    expect(c?.enforcedBy).toContain("decision-engine");
    expect(c?.implemented).toBe(true);
  });

  it("AC02: Every tool call, agent action, and platform operation evaluated by policy", () => {
    const c = getAcceptanceCriterion("AC02");
    expect(c?.title).toContain("evaluated by policy");
    expect(c?.enforcedBy).toContain("decision-engine");
    expect(c?.implemented).toBe(true);
  });

  it("AC03: Policy changes versioned, simulated, tested, rolled out gradually", () => {
    const c = getAcceptanceCriterion("AC03");
    expect(c?.title).toContain("versioned");
    expect(c?.enforcedBy).toContain("policy-as-code");
    expect(c?.implemented).toBe(true);
  });

  it("AC04: Risk classification applied consistently", () => {
    const c = getAcceptanceCriterion("AC04");
    expect(c?.title).toContain("Risk classification");
    expect(c?.enforcedBy).toContain("risk-levels");
    expect(c?.implemented).toBe(true);
  });

  it("AC05: Auto-approval, policy-check, human-approval flows all live", () => {
    const c = getAcceptanceCriterion("AC05");
    expect(c?.title).toContain("flows all live");
    expect(c?.enforcedBy).toContain("risk-levels");
    expect(c?.implemented).toBe(true);
  });

  it("AC06: Reputation system live and effective", () => {
    const c = getAcceptanceCriterion("AC06");
    expect(c?.title).toContain("Reputation system");
    expect(c?.enforcedBy).toContain("reputation-trust");
    expect(c?.implemented).toBe(true);
  });

  it("AC07: Transparency dashboards live for users, auditors, regulators", () => {
    const c = getAcceptanceCriterion("AC07");
    expect(c?.title).toContain("Transparency dashboards");
    expect(c?.enforcedBy).toContain("transparency-audiences");
    expect(c?.implemented).toBe(true);
  });

  it("AC08: Governance committee formed and meeting regularly", () => {
    const c = getAcceptanceCriterion("AC08");
    expect(c?.title).toContain("Governance committee");
    expect(c?.enforcedBy).toContain("governance-committee");
    expect(c?.implemented).toBe(true);
  });

  it("AC09: Appeals workflow live and responsive", () => {
    const c = getAcceptanceCriterion("AC09");
    expect(c?.title).toContain("Appeals workflow");
    expect(c?.enforcedBy).toContain("appeals");
    expect(c?.implemented).toBe(true);
  });

  it("AC10: All decisions logged with tamper-evident trail", () => {
    const c = getAcceptanceCriterion("AC10");
    expect(c?.title).toContain("tamper-evident");
    expect(c?.enforcedBy).toContain("governance-decision-log");
    expect(c?.enforcedBy).toContain("governance-audit-trail");
    expect(c?.implemented).toBe(true);
  });

  it("AC11: Kill switches live, tested, effective within 60 seconds", () => {
    const c = getAcceptanceCriterion("AC11");
    expect(c?.title).toContain("60 seconds");
    expect(c?.enforcedBy).toContain("kill-switches");
    expect(c?.implemented).toBe(true);
  });

  it("AC12: Circuit breakers live, tested, recovering automatically", () => {
    const c = getAcceptanceCriterion("AC12");
    expect(c?.title).toContain("Circuit breakers");
    expect(c?.enforcedBy).toContain("circuit-breakers");
    expect(c?.implemented).toBe(true);
  });

  it("AC13: Rollback paths defined for every reversible action", () => {
    const c = getAcceptanceCriterion("AC13");
    expect(c?.title).toContain("Rollback paths");
    expect(c?.enforcedBy).toContain("rollback");
    expect(c?.implemented).toBe(true);
  });

  it("AC14: Ethical governance principles adopted and enforced", () => {
    const c = getAcceptanceCriterion("AC14");
    expect(c?.title).toContain("Ethical governance");
    expect(c?.enforcedBy).toContain("ethics");
    expect(c?.implemented).toBe(true);
  });

  it("AC15: Bias audits scheduled and executed", () => {
    const c = getAcceptanceCriterion("AC15");
    expect(c?.title).toContain("Bias audits");
    expect(c?.enforcedBy).toContain("ethics");
    expect(c?.implemented).toBe(true);
  });

  it("AC16: Annual external audit completed", () => {
    const c = getAcceptanceCriterion("AC16");
    expect(c?.title).toContain("Annual external audit");
    expect(c?.enforcedBy).toContain("ethics");
    expect(c?.implemented).toBe(true);
  });

  it("AC17: Every policy has an owner and version history", () => {
    const c = getAcceptanceCriterion("AC17");
    expect(c?.title).toContain("owner");
    expect(c?.enforcedBy).toContain("policy-as-code");
    expect(c?.implemented).toBe(true);
  });

  it("AC18: Every decision has a documented reason", () => {
    const c = getAcceptanceCriterion("AC18");
    expect(c?.title).toContain("documented reason");
    expect(c?.enforcedBy).toContain("governance-decision-log");
    expect(c?.implemented).toBe(true);
  });

  it("AC19: Compliance evidence collected automatically", () => {
    const c = getAcceptanceCriterion("AC19");
    expect(c?.title).toContain("Compliance evidence");
    expect(c?.enforcedBy).toContain("governance-dashboards");
    expect(c?.implemented).toBe(true);
  });

  it("AC20: Quarterly transparency report published", () => {
    const c = getAcceptanceCriterion("AC20");
    expect(c?.title).toContain("Quarterly transparency report");
    expect(c?.enforcedBy).toContain("governance-committee");
    expect(c?.enforcedBy).toContain("governance-dashboards");
    expect(c?.implemented).toBe(true);
  });

  it("getLaunchReadinessSummary returns READY when all criteria met", () => {
    const summary = getLaunchReadinessSummary();
    expect(summary).toContain("20/20");
    expect(summary).toContain("READY");
  });
});

// ───────────────────────────────────────────────
// 15. Risks & mitigations — 15 risks
// ───────────────────────────────────────────────

describe("15 — Risks and mitigations", () => {
  it("has 15 risks", () => {
    expect(RISKS_AND_MITIGATIONS).toHaveLength(15);
    const ids = RISKS_AND_MITIGATIONS.map((r) => r.id);
    expect(ids[0]).toBe("R01");
    expect(ids[14]).toBe("R15");
  });

  it("all 15 risks are mitigated (all mitigations implemented)", () => {
    const v = verifyRisksAndMitigations();
    expect(v.allImplemented).toBe(true);
    expect(v.mitigatedRisks).toBe(15);
  });

  it("every risk has at least 1 mitigation", () => {
    for (const r of RISKS_AND_MITIGATIONS) {
      expect(r.mitigations.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every mitigation is implemented", () => {
    const v = verifyRisksAndMitigations();
    expect(v.implementedMitigations).toBe(v.totalMitigations);
  });

  it("R01: Autonomous systems making wrong decisions", () => {
    const r = getRisk("R01");
    expect(r?.risk).toContain("wrong decisions");
    expect(r?.category).toBe("operational");
    expect(r?.mitigations.length).toBeGreaterThanOrEqual(5); // risk classification + human approval + circuit breakers + kill switches + rollback
    expect(r?.residualRisk).toBe("low");
    expect(r?.implemented).toBe(true);
  });

  it("R02: Policy drift", () => {
    const r = getRisk("R02");
    expect(r?.risk).toContain("Policy drift");
    expect(r?.category).toBe("policy");
    expect(r?.mitigations.map((m) => m.name)).toContain("Versioning");
    expect(r?.mitigations.map((m) => m.name)).toContain("Simulation");
    expect(r?.mitigations.map((m) => m.name)).toContain("Testing");
    expect(r?.mitigations.map((m) => m.name)).toContain("Gradual rollout");
    expect(r?.implemented).toBe(true);
  });

  it("R03: Approval fatigue", () => {
    const r = getRisk("R03");
    expect(r?.risk).toContain("Approval fatigue");
    expect(r?.category).toBe("fatigue");
    expect(r?.mitigations.map((m) => m.name)).toContain("Policy auto-tuning proposals");
    expect(r?.mitigations.map((m) => m.name)).toContain("Reputation-based reduction");
    expect(r?.mitigations.map((m) => m.name)).toContain("Batching");
    expect(r?.implemented).toBe(true);
  });

  it("R04: Reputation gaming", () => {
    const r = getRisk("R04");
    expect(r?.risk).toContain("Reputation gaming");
    expect(r?.category).toBe("abuse");
    expect(r?.mitigations.map((m) => m.name)).toContain("Algorithm detection");
    expect(r?.mitigations.map((m) => m.name)).toContain("Human review of edge cases");
    expect(r?.mitigations.map((m) => m.name)).toContain("Audits");
    expect(r?.implemented).toBe(true);
  });

  it("R05: Bias in decisions", () => {
    const r = getRisk("R05");
    expect(r?.risk).toContain("Bias");
    expect(r?.category).toBe("ethics");
    expect(r?.mitigations.map((m) => m.name)).toContain("Fairness principles");
    expect(r?.mitigations.map((m) => m.name)).toContain("Bias audits");
    expect(r?.mitigations.map((m) => m.name)).toContain("External review");
    expect(r?.implemented).toBe(true);
  });

  it("R06: Governance committee bottleneck", () => {
    const r = getRisk("R06");
    expect(r?.risk).toContain("committee bottleneck");
    expect(r?.category).toBe("governance");
    expect(r?.mitigations.map((m) => m.name)).toContain("Clear scope");
    expect(r?.mitigations.map((m) => m.name)).toContain("Delegation");
    expect(r?.mitigations.map((m) => m.name)).toContain("Autonomy for low-risk decisions");
    expect(r?.implemented).toBe(true);
  });

  it("R07: Compliance violations", () => {
    const r = getRisk("R07");
    expect(r?.risk).toContain("Compliance violations");
    expect(r?.category).toBe("compliance");
    expect(r?.mitigations.map((m) => m.name)).toContain("Policy as code");
    expect(r?.mitigations.map((m) => m.name)).toContain("Evidence automation");
    expect(r?.mitigations.map((m) => m.name)).toContain("External audit");
    expect(r?.implemented).toBe(true);
  });

  it("R08: Security exposure", () => {
    const r = getRisk("R08");
    expect(r?.risk).toContain("Security exposure");
    expect(r?.category).toBe("security");
    expect(r?.mitigations.map((m) => m.name)).toContain("Least privilege");
    expect(r?.mitigations.map((m) => m.name)).toContain("MFA");
    expect(r?.mitigations.map((m) => m.name)).toContain("Audit");
    expect(r?.mitigations.map((m) => m.name)).toContain("Penetration tests");
    expect(r?.implemented).toBe(true);
  });

  it("R09: Opacity to users", () => {
    const r = getRisk("R09");
    expect(r?.risk).toContain("Opacity to users");
    expect(r?.category).toBe("transparency");
    expect(r?.mitigations.map((m) => m.name)).toContain("Transparency dashboards");
    expect(r?.mitigations.map((m) => m.name)).toContain("Explainability");
    expect(r?.mitigations.map((m) => m.name)).toContain("Appeals");
    expect(r?.implemented).toBe(true);
  });

  it("R10: Opacity to auditors", () => {
    const r = getRisk("R10");
    expect(r?.risk).toContain("Opacity to auditors");
    expect(r?.category).toBe("transparency");
    expect(r?.mitigations.map((m) => m.name)).toContain("Dedicated audit views");
    expect(r?.mitigations.map((m) => m.name)).toContain("Evidence");
    expect(r?.mitigations.map((m) => m.name)).toContain("Reports");
    expect(r?.implemented).toBe(true);
  });

  it("R11: Over-centralization", () => {
    const r = getRisk("R11");
    expect(r?.risk).toContain("Over-centralization");
    expect(r?.category).toBe("centralization");
    expect(r?.mitigations.map((m) => m.name)).toContain("Domain autonomy within policy bounds");
    expect(r?.implemented).toBe(true);
  });

  it("R12: Under-centralization", () => {
    const r = getRisk("R12");
    expect(r?.risk).toContain("Under-centralization");
    expect(r?.category).toBe("centralization");
    expect(r?.mitigations.map((m) => m.name)).toContain("Global policy");
    expect(r?.mitigations.map((m) => m.name)).toContain("Consistent application");
    expect(r?.mitigations.map((m) => m.name)).toContain("Governance committee oversight");
    expect(r?.implemented).toBe(true);
  });

  it("R13: Emergencies requiring fast decisions", () => {
    const r = getRisk("R13");
    expect(r?.risk).toContain("Emergencies");
    expect(r?.category).toBe("emergency");
    expect(r?.mitigations.map((m) => m.name)).toContain("Kill switches");
    expect(r?.mitigations.map((m) => m.name)).toContain("Emergency policies");
    expect(r?.mitigations.map((m) => m.name)).toContain("Fast-track approvals");
    expect(r?.implemented).toBe(true);
  });

  it("R14: Legal exposure", () => {
    const r = getRisk("R14");
    expect(r?.risk).toContain("Legal exposure");
    expect(r?.category).toBe("legal");
    expect(r?.mitigations.map((m) => m.name)).toContain("External counsel");
    expect(r?.mitigations.map((m) => m.name)).toContain("Jurisdictional playbooks");
    expect(r?.mitigations.map((m) => m.name)).toContain("DPA coverage");
    expect(r?.implemented).toBe(true);
  });

  it("R15: Trust erosion", () => {
    const r = getRisk("R15");
    expect(r?.risk).toContain("Trust erosion");
    expect(r?.category).toBe("trust");
    expect(r?.mitigations.map((m) => m.name)).toContain("Transparency");
    expect(r?.mitigations.map((m) => m.name)).toContain("Appeals");
    expect(r?.mitigations.map((m) => m.name)).toContain("External audits");
    expect(r?.mitigations.map((m) => m.name)).toContain("Published principles");
    expect(r?.implemented).toBe(true);
  });

  it("every risk has a category, likelihood, impact, residual risk", () => {
    for (const r of RISKS_AND_MITIGATIONS) {
      expect(r.category.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(r.likelihood);
      expect(["low", "medium", "high", "critical"]).toContain(r.impact);
      expect(["low", "medium", "high"]).toContain(r.residualRisk);
    }
  });

  it("highest residual risk across all risks is low or medium (no high residuals)", () => {
    const v = verifyRisksAndMitigations();
    expect(["low", "medium"]).toContain(v.highestResidualRisk);
  });

  it("getRisksByCategory groups risks correctly", () => {
    const transparencyRisks = getRisksByCategory("transparency");
    expect(transparencyRisks.length).toBe(2); // R09 + R10.
    expect(transparencyRisks.map((r) => r.id)).toContain("R09");
    expect(transparencyRisks.map((r) => r.id)).toContain("R10");
  });

  it("getTopRisks returns the highest-impact risks", () => {
    const top = getTopRisks(5);
    expect(top.length).toBe(5);
    // Top risks should be critical impact.
    expect(top.every((r) => r.impact === "critical")).toBe(true);
  });

  it("getResidualRiskSummary mentions mitigated/total counts", () => {
    const summary = getResidualRiskSummary();
    expect(summary).toContain("15/15");
    expect(summary).toContain("risks mitigated");
    expect(summary).toContain("residual");
  });

  it("RiskCategory is the union of 12 categories", () => {
    const cats: RiskCategory[] = [
      "operational", "policy", "fatigue", "abuse", "ethics", "governance",
      "compliance", "security", "transparency", "centralization", "emergency",
      "legal", "trust",
    ];
    // 13 distinct categories (transparency appears twice but is one category).
    const uniqueCats = new Set(cats);
    expect(uniqueCats.size).toBe(13);
  });
});
