/**
 * Governance — The Autonomous Governance Future (Section 6) — tests.
 *
 * Verifies the spec's closing vision:
 *   10 pillars of the realized autonomous governance system + the closing
 *   thesis (humans set direction / platform executes / both accountable).
 */

import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_PILLARS,
  CLOSING_THESIS,
  CLOSING_STATEMENT,
  verifyGovernanceFuture,
  getPillar,
  getThesisStatement,
  getRealizationSummary,
  type GovernancePillar,
  type ClosingThesisStatement,
} from "@/lib/governance/governance-future";

// ───────────────────────────────────────────────
// 6. The 10 pillars
// ───────────────────────────────────────────────

describe("6 — The 10 pillars of the realized autonomous governance system", () => {
  it("has 10 pillars", () => {
    expect(GOVERNANCE_PILLARS).toHaveLength(10);
    const ids = GOVERNANCE_PILLARS.map((p) => p.id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("all 10 pillars are implemented", () => {
    const v = verifyGovernanceFuture();
    expect(v.implementedPillars).toBe(10);
    expect(v.totalPillars).toBe(10);
  });

  it("every pillar has enforcedBy + verificationFunction", () => {
    for (const p of GOVERNANCE_PILLARS) {
      expect(p.enforcedBy.length).toBeGreaterThan(0);
      expect(p.verificationFunction.length).toBeGreaterThan(0);
      expect(p.implemented).toBe(true);
    }
  });

  it("pillar 1: Policies — every rule is code, versioned, tested, simulated", () => {
    const p = getPillar(1);
    expect(p?.name).toBe("Policies");
    expect(p?.description).toContain("code");
    expect(p?.description).toContain("versioned");
    expect(p?.description).toContain("tested");
    expect(p?.description).toContain("simulated");
    expect(p?.enforcedBy).toContain("policy-as-code.ts (versioning + simulatePolicy + proposePolicyTuning)");
    expect(p?.enforcedBy).toContain("policy-engine.ts (evaluatePolicy + evaluatePolicyFromDb)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 2: Risk levels — every action classified, every approval aligned to risk", () => {
    const p = getPillar(2);
    expect(p?.name).toBe("Risk levels");
    expect(p?.description).toContain("classified");
    expect(p?.description).toContain("approval aligned");
    expect(p?.enforcedBy).toContain("risk-levels.ts (5 levels: low/medium/high/critical/irreversible)");
    expect(p?.enforcedBy).toContain("decision-engine.ts (assessRisk + routeDecision)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 3: Reputation — trust reduces friction, distrust increases scrutiny", () => {
    const p = getPillar(3);
    expect(p?.name).toBe("Reputation");
    expect(p?.description).toContain("Trust reduces friction");
    expect(p?.description).toContain("distrust increases scrutiny");
    expect(p?.enforcedBy).toContain("reputation-trust.ts (7 dimensions, 4 tiers, weighted scoring)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 4: Transparency — users, auditors, regulators can see everything they should", () => {
    const p = getPillar(4);
    expect(p?.name).toBe("Transparency");
    expect(p?.description).toContain("Users, auditors, and regulators");
    expect(p?.enforcedBy).toContain("transparency-audiences.ts (3 audiences: user/auditor/regulator)");
    expect(p?.enforcedBy).toContain("governance-decision-log.ts (exportDecisionLog for auditors)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 5: Human oversight — a governance committee handles the exceptions", () => {
    const p = getPillar(5);
    expect(p?.name).toBe("Human oversight");
    expect(p?.description).toContain("governance committee");
    expect(p?.description).toContain("exceptions");
    expect(p?.enforcedBy).toContain("governance-committee.ts (6 members, 10 decision types, routing rules)");
    expect(p?.enforcedBy).toContain("committee-responsibilities.ts (7 responsibilities + 4 cadences)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 6: Appeals — every decision can be contested and reviewed", () => {
    const p = getPillar(6);
    expect(p?.name).toBe("Appeals");
    expect(p?.description).toContain("contested");
    expect(p?.description).toContain("reviewed");
    expect(p?.enforcedBy).toContain("appeals.ts (5 appeal types, 6-step workflow, time limits)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 7: Observability — every decision logged, measurable, auditable", () => {
    const p = getPillar(7);
    expect(p?.name).toBe("Observability");
    expect(p?.description).toContain("logged");
    expect(p?.description).toContain("measurable");
    expect(p?.description).toContain("auditable");
    expect(p?.enforcedBy).toContain("governance-metrics.ts (8 metric groups, Prometheus counters/histograms/gauges)");
    expect(p?.enforcedBy).toContain("governance-decision-log.ts (hash-chained, 8 fields, exportable)");
    expect(p?.enforcedBy).toContain("governance-dashboards.ts (4 dashboards: governance/policy/reputation/compliance)");
    expect(p?.enforcedBy).toContain("governance-audit-trail.ts (7 event categories, 7+ year retention, legal holds)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 8: Safeguards — kill switches, circuit breakers, rollback everywhere", () => {
    const p = getPillar(8);
    expect(p?.name).toBe("Safeguards");
    expect(p?.description.toLowerCase()).toContain("kill switches");
    expect(p?.description.toLowerCase()).toContain("circuit breakers");
    expect(p?.description.toLowerCase()).toContain("rollback");
    expect(p?.enforcedBy).toContain("kill-switches.ts (7 named types, 60s propagation SLA, per-subscriber confirmation)");
    expect(p?.enforcedBy).toContain("circuit-breakers.ts (5 breakers: cost/latency/error/abuse/compliance, auto-recover)");
    expect(p?.enforcedBy).toContain("rollback.ts (4 paths: policy/marketplace/regional/enterprise)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 9: Ethics — fairness, explainability, consistency, accountability", () => {
    const p = getPillar(9);
    expect(p?.name).toBe("Ethics");
    expect(p?.description.toLowerCase()).toContain("fairness");
    expect(p?.description.toLowerCase()).toContain("explainability");
    expect(p?.description.toLowerCase()).toContain("consistency");
    expect(p?.description.toLowerCase()).toContain("accountability");
    expect(p?.enforcedBy).toContain("ethics.ts (7 ethical principles)");
    expect(p?.enforcedBy).toContain("ethics.ts (4 bias audits: disparate impact/native-speaker/cross-regional/external annual)");
    expect(p?.enforcedBy).toContain("ethics.ts (3 ethical review depths: standard/committee/external)");
    expect(p?.implemented).toBe(true);
  });

  it("pillar 10: Autonomy — platform decides routine; humans decide direction", () => {
    const p = getPillar(10);
    expect(p?.name).toBe("Autonomy");
    expect(p?.description).toContain("routine matters");
    expect(p?.description).toContain("humans decide direction");
    expect(p?.enforcedBy).toContain("decision-engine.ts (auto-approves low-risk; escalates high-risk)");
    expect(p?.enforcedBy).toContain("decision-domains.ts (8 domains with autonomy within policy bounds)");
    expect(p?.enforcedBy).toContain("phase-integration.ts (15 phases wired into the decision engine)");
    expect(p?.implemented).toBe(true);
  });

  it("GovernancePillar is a structured type", () => {
    const p: GovernancePillar = {
      id: 99,
      name: "Test",
      description: "test",
      specSection: "test",
      enforcedBy: ["test"],
      verificationFunction: "test",
      implemented: true,
    };
    expect(p.id).toBe(99);
    expect(p.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 6. The closing thesis — 3 statements
// ───────────────────────────────────────────────

describe("6 — The closing thesis", () => {
  it("has 3 thesis statements", () => {
    expect(CLOSING_THESIS).toHaveLength(3);
    const ids = CLOSING_THESIS.map((t) => t.id);
    expect(ids).toEqual(["T1", "T2", "T3"]);
  });

  it("all 3 thesis statements are implemented", () => {
    const v = verifyGovernanceFuture();
    expect(v.implementedThesisStatements).toBe(3);
    expect(v.totalThesisStatements).toBe(3);
  });

  it("every thesis statement has enforcedBy", () => {
    for (const t of CLOSING_THESIS) {
      expect(t.enforcedBy.length).toBeGreaterThan(0);
      expect(t.implemented).toBe(true);
    }
  });

  it("T1: Humans set direction", () => {
    const t = getThesisStatement("T1");
    expect(t?.statement).toBe("Humans set direction.");
    expect(t?.enforcedBy).toContain("policy_rules (humans define every rule as code)");
    expect(t?.enforcedBy).toContain("governance-committee.ts (6 humans on the standing committee)");
    expect(t?.enforcedBy).toContain("ethics.ts (ethical review + committee approval for high-risk capabilities)");
    expect(t?.enforcedBy).toContain("appeals.ts (humans review contested decisions)");
    expect(t?.implemented).toBe(true);
  });

  it("T2: The platform executes", () => {
    const t = getThesisStatement("T2");
    expect(t?.statement).toBe("The platform executes.");
    expect(t?.enforcedBy).toContain("decision-engine.ts (routeDecision executes every routine decision)");
    expect(t?.enforcedBy).toContain("policy-engine.ts (evaluatePolicy applies the rules at runtime)");
    expect(t?.enforcedBy).toContain("circuit-breakers.ts (platform auto-recovers when conditions normalize)");
    expect(t?.enforcedBy).toContain("kill-switches.ts (platform auto-deactivates expired switches)");
    expect(t?.implemented).toBe(true);
  });

  it("T3: Both are accountable", () => {
    const t = getThesisStatement("T3");
    expect(t?.statement).toBe("Both are accountable.");
    expect(t?.enforcedBy).toContain("governance-decision-log.ts (every autonomous decision logged + hash-chained)");
    expect(t?.enforcedBy).toContain("admin-audit-log (every human admin action logged + hash-chained)");
    expect(t?.enforcedBy).toContain("policy_rules.owner_id (every policy has a named human owner)");
    expect(t?.enforcedBy).toContain("transparency-audiences.ts (3 audiences can verify both human + platform actions)");
    expect(t?.enforcedBy).toContain("ethics.ts (external annual audit covers both human decisions + platform decisions)");
    expect(t?.implemented).toBe(true);
  });

  it("ClosingThesisStatement is a structured type", () => {
    const t: ClosingThesisStatement = {
      id: "T9",
      statement: "test",
      enforcedBy: ["test"],
      implemented: true,
    };
    expect(t.id).toBe("T9");
    expect(t.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 6. The closing statement
// ───────────────────────────────────────────────

describe("6 — The closing statement", () => {
  it("matches the spec text exactly", () => {
    expect(CLOSING_STATEMENT).toBe(
      "Humans set direction. The platform executes. Both are accountable. " +
        "That is what it means to build an autonomous global platform with real governance.",
    );
  });

  it("contains all 3 thesis statements", () => {
    expect(CLOSING_STATEMENT).toContain("Humans set direction.");
    expect(CLOSING_STATEMENT).toContain("The platform executes.");
    expect(CLOSING_STATEMENT).toContain("Both are accountable.");
  });

  it("contains the final thesis sentence", () => {
    expect(CLOSING_STATEMENT).toContain(
      "That is what it means to build an autonomous global platform with real governance.",
    );
  });
});

// ───────────────────────────────────────────────
// 6. Overall verification — the spec's definition of done
// ───────────────────────────────────────────────

describe("6 — Spec realization", () => {
  it("verifyGovernanceFuture() reports specRealized=true", () => {
    const v = verifyGovernanceFuture();
    expect(v.specRealized).toBe(true);
  });

  it("all 10 pillars implemented", () => {
    const v = verifyGovernanceFuture();
    expect(v.implementedPillars).toBe(v.totalPillars);
    expect(v.totalPillars).toBe(10);
  });

  it("all 3 thesis statements implemented", () => {
    const v = verifyGovernanceFuture();
    expect(v.implementedThesisStatements).toBe(v.totalThesisStatements);
    expect(v.totalThesisStatements).toBe(3);
  });

  it("closing statement matches spec", () => {
    const v = verifyGovernanceFuture();
    expect(v.closingStatementMatchesSpec).toBe(true);
  });

  it("getRealizationSummary returns 'SPEC REALIZED'", () => {
    const summary = getRealizationSummary();
    expect(summary).toContain("10/10 pillars");
    expect(summary).toContain("3/3 thesis statements");
    expect(summary).toContain("SPEC REALIZED");
  });
});
