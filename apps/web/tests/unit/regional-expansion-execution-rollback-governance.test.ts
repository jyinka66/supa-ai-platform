/**
 * Regional Expansion Playbook — Sections 13 (Optimization Output), 14
 * (Autonomous Execution), 15 (Rollback & Retirement), 16 (Governance
 * Integration) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  type RegionTrajectory,
  type OptimizationOutput,
} from "@/lib/expansion/stage-optimization";
import {
  STAGE_AUTONOMY,
  HUMAN_CHECKPOINTS,
  HUMAN_OVERRIDES,
  verifyAutonomousExecution,
  type StageAutonomyLevel,
  type StageAutonomySpec,
  type HumanCheckpointId,
  type HumanCheckpointSpec,
  type HumanOverrideAction,
  type HumanOverrideSpec,
} from "@/lib/expansion/autonomous-execution";
import {
  ROLLBACK_PATHS,
  RETIREMENT_TRIGGERS,
  verifyRollbackRetirement,
  type RollbackPathId,
  type RollbackPathSpec,
  type RetirementTriggerId,
  type RetirementTriggerSpec,
  type RetirementProcess,
} from "@/lib/expansion/rollback-retirement";
import {
  GOVERNANCE_INTEGRATIONS,
  verifyGovernanceIntegration,
  isDecisionGoverned,
  getIntegrationForDecision,
  type GovernanceIntegrationId,
  type GovernanceIntegrationSpec,
} from "@/lib/expansion/governance-integration";

// ───────────────────────────────────────────────
// 13.2 Optimization Output
// ───────────────────────────────────────────────

describe("13.2 — Optimization Output", () => {
  it("RegionTrajectory is the union of growing / stable / declining / retired", () => {
    const t1: RegionTrajectory = "growing";
    const t2: RegionTrajectory = "stable";
    const t3: RegionTrajectory = "declining";
    const t4: RegionTrajectory = "retired";
    expect([t1, t2, t3, t4]).toHaveLength(4);
  });

  it("OptimizationOutput type has the expected shape", () => {
    const o: OptimizationOutput = {
      regionCode: "us",
      improvementsShipped: [
        { area: "pricing", title: "Adjusted PPP factor", shippedAt: new Date(), impact: "high" },
      ],
      regionScore: 85,
      regionScoreTrend: "up",
      trajectory: "growing",
      trajectoryReason: "score trending up + adoption growing",
      retirementCandidate: false,
      generatedAt: new Date(),
    };
    expect(o.regionCode).toBe("us");
    expect(o.trajectory).toBe("growing");
    expect(o.retirementCandidate).toBe(false);
    expect(o.improvementsShipped).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────
// 14. Autonomous Execution
// ───────────────────────────────────────────────

describe("14 — Autonomous Execution", () => {
  it("14.1 has 9 stages with autonomy levels", () => {
    expect(STAGE_AUTONOMY).toHaveLength(9);
    const stages = STAGE_AUTONOMY.map((s) => s.stage);
    expect(stages).toContain("detection");
    expect(stages).toContain("evaluation");
    expect(stages).toContain("prioritization");
    expect(stages).toContain("preparation");
    expect(stages).toContain("verification");
    expect(stages).toContain("soft_launch");
    expect(stages).toContain("public_launch");
    expect(stages).toContain("monitoring");
    expect(stages).toContain("optimization");
  });

  it("all 9 stages are implemented", () => {
    const v = verifyAutonomousExecution();
    expect(v.implementedStages).toBe(9);
    expect(v.totalStages).toBe(9);
    expect(v.allImplemented).toBe(true);
  });

  it("14.1.1 detection: fully automatic", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "detection");
    expect(s?.number).toBe("14.1.1");
    expect(s?.autonomy).toBe("fully_automatic");
    expect(s?.humanInvolvement).toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.2 evaluation: fully automatic", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "evaluation");
    expect(s?.number).toBe("14.1.2");
    expect(s?.autonomy).toBe("fully_automatic");
    expect(s?.humanInvolvement).toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.3 prioritization: automatic with override", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "prioritization");
    expect(s?.number).toBe("14.1.3");
    expect(s?.autonomy).toBe("automatic_with_override");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.4 preparation: automatic with signoff", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "preparation");
    expect(s?.number).toBe("14.1.4");
    expect(s?.autonomy).toBe("automatic_with_signoff");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.5 verification: automatic with escalation", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "verification");
    expect(s?.number).toBe("14.1.5");
    expect(s?.autonomy).toBe("automatic_with_escalation");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.6 soft launch: automatic with monitoring", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "soft_launch");
    expect(s?.number).toBe("14.1.6");
    expect(s?.autonomy).toBe("automatic_with_monitoring");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.7 public launch: automatic with monitoring", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "public_launch");
    expect(s?.number).toBe("14.1.7");
    expect(s?.autonomy).toBe("automatic_with_monitoring");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.8 monitoring: fully automatic", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "monitoring");
    expect(s?.number).toBe("14.1.8");
    expect(s?.autonomy).toBe("fully_automatic");
    expect(s?.humanInvolvement).toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("14.1.9 optimization: automatic with approval", () => {
    const s = STAGE_AUTONOMY.find((s) => s.stage === "optimization");
    expect(s?.number).toBe("14.1.9");
    expect(s?.autonomy).toBe("automatic_with_approval");
    expect(s?.humanInvolvement).not.toBeNull();
    expect(s?.implemented).toBe(true);
  });

  it("3 stages are fully automatic (detection, evaluation, monitoring)", () => {
    const v = verifyAutonomousExecution();
    expect(v.fullyAutomaticStages).toBe(3);
    expect(v.stagesWithHumanInvolvement).toBe(6);
  });

  it("14.2 has 7 human checkpoints", () => {
    expect(HUMAN_CHECKPOINTS).toHaveLength(7);
    const ids = HUMAN_CHECKPOINTS.map((c) => c.id);
    expect(ids).toContain("legal_documents");
    expect(ids).toContain("tax_setups");
    expect(ids).toContain("high_risk_payment_changes");
    expect(ids).toContain("cultural_considerations");
    expect(ids).toContain("go_no_go_public_launch");
    expect(ids).toContain("material_pricing_changes");
    expect(ids).toContain("region_retirement");
  });

  it("all 7 human checkpoints are implemented", () => {
    const v = verifyAutonomousExecution();
    expect(v.implementedHumanCheckpoints).toBe(7);
    expect(v.totalHumanCheckpoints).toBe(7);
  });

  it("14.2.1 legal_documents per region", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "legal_documents");
    expect(c?.number).toBe("14.2.1");
    expect(c?.title.toLowerCase()).toContain("legal documents");
    expect(c?.approver).toBe("legal_counsel");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.2 tax_setups per region", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "tax_setups");
    expect(c?.number).toBe("14.2.2");
    expect(c?.title.toLowerCase()).toContain("tax setups");
    expect(c?.approver).toBe("tax_advisor");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.3 high-risk payment changes", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "high_risk_payment_changes");
    expect(c?.number).toBe("14.2.3");
    expect(c?.title.toLowerCase()).toContain("payment changes");
    expect(c?.approver).toBe("payments_advisor");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.4 cultural considerations", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "cultural_considerations");
    expect(c?.number).toBe("14.2.4");
    expect(c?.title.toLowerCase()).toContain("cultural");
    expect(c?.approver).toBe("cultural_reviewer");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.5 go / no-go for public launch", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "go_no_go_public_launch");
    expect(c?.number).toBe("14.2.5");
    expect(c?.title.toLowerCase()).toContain("go");
    expect(c?.title.toLowerCase()).toContain("no-go");
    expect(c?.title.toLowerCase()).toContain("public launch");
    expect(c?.approver).toBe("governance_committee");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.6 material pricing changes", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "material_pricing_changes");
    expect(c?.number).toBe("14.2.6");
    expect(c?.title.toLowerCase()).toContain("pricing changes");
    expect(c?.approver).toBe("governance_committee");
    expect(c?.implemented).toBe(true);
  });

  it("14.2.7 region retirement", () => {
    const c = HUMAN_CHECKPOINTS.find((c) => c.id === "region_retirement");
    expect(c?.number).toBe("14.2.7");
    expect(c?.title.toLowerCase()).toContain("retirement");
    expect(c?.approver).toBe("governance_committee");
    expect(c?.implemented).toBe(true);
  });

  it("14.3 has 5 human override actions", () => {
    expect(HUMAN_OVERRIDES).toHaveLength(5);
    const actions = HUMAN_OVERRIDES.map((o) => o.action);
    expect(actions).toContain("pause");
    expect(actions).toContain("rollback");
    expect(actions).toContain("prioritize");
    expect(actions).toContain("deprioritize");
    expect(actions).toContain("retire");
  });

  it("all 5 human overrides are implemented", () => {
    const v = verifyAutonomousExecution();
    expect(v.implementedHumanOverrides).toBe(5);
    expect(v.totalHumanOverrides).toBe(5);
  });

  it("14.3.1 pause a region (any stage)", () => {
    const o = HUMAN_OVERRIDES.find((o) => o.action === "pause");
    expect(o?.number).toBe("14.3.1");
    expect(o?.title.toLowerCase()).toContain("pause");
    expect(o?.applicableStages.toLowerCase()).toContain("any stage");
    expect(o?.implemented).toBe(true);
  });

  it("14.3.2 roll back a region (any stage after detection)", () => {
    const o = HUMAN_OVERRIDES.find((o) => o.action === "rollback");
    expect(o?.number).toBe("14.3.2");
    expect(o?.title.toLowerCase()).toContain("roll back");
    expect(o?.implemented).toBe(true);
  });

  it("14.3.3 prioritize a region", () => {
    const o = HUMAN_OVERRIDES.find((o) => o.action === "prioritize");
    expect(o?.number).toBe("14.3.3");
    expect(o?.title.toLowerCase()).toContain("prioritize");
    expect(o?.implemented).toBe(true);
  });

  it("14.3.4 deprioritize a region", () => {
    const o = HUMAN_OVERRIDES.find((o) => o.action === "deprioritize");
    expect(o?.number).toBe("14.3.4");
    expect(o?.title.toLowerCase()).toContain("deprioritize");
    expect(o?.implemented).toBe(true);
  });

  it("14.3.5 retire a region", () => {
    const o = HUMAN_OVERRIDES.find((o) => o.action === "retire");
    expect(o?.number).toBe("14.3.5");
    expect(o?.title.toLowerCase()).toContain("retire");
    expect(o?.implemented).toBe(true);
  });

  it("StageAutonomyLevel is the union of 6 levels", () => {
    const l1: StageAutonomyLevel = "fully_automatic";
    const l2: StageAutonomyLevel = "automatic_with_override";
    const l3: StageAutonomyLevel = "automatic_with_signoff";
    const l4: StageAutonomyLevel = "automatic_with_escalation";
    const l5: StageAutonomyLevel = "automatic_with_monitoring";
    const l6: StageAutonomyLevel = "automatic_with_approval";
    expect([l1, l2, l3, l4, l5, l6]).toHaveLength(6);
  });

  it("HumanCheckpointId is the union of 7 named ids", () => {
    const ids: HumanCheckpointId[] = [
      "legal_documents", "tax_setups", "high_risk_payment_changes",
      "cultural_considerations", "go_no_go_public_launch",
      "material_pricing_changes", "region_retirement",
    ];
    expect(ids).toHaveLength(7);
  });

  it("HumanOverrideAction is the union of 5 named actions", () => {
    const actions: HumanOverrideAction[] = ["pause", "rollback", "prioritize", "deprioritize", "retire"];
    expect(actions).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 15. Rollback and Retirement
// ───────────────────────────────────────────────

describe("15 — Rollback and Retirement", () => {
  it("15.1 has 5 rollback paths", () => {
    expect(ROLLBACK_PATHS).toHaveLength(5);
    const ids = ROLLBACK_PATHS.map((p) => p.id);
    expect(ids).toContain("preparation_to_previous");
    expect(ids).toContain("verification_to_preparation");
    expect(ids).toContain("soft_launch_to_verification");
    expect(ids).toContain("public_launch_to_soft_launch");
    expect(ids).toContain("live_to_paused");
  });

  it("all 5 rollback paths are implemented", () => {
    const v = verifyRollbackRetirement();
    expect(v.implementedRollbackPaths).toBe(5);
    expect(v.totalRollbackPaths).toBe(5);
    expect(v.allImplemented).toBe(true);
  });

  it("15.1.1 preparation → previous state (discard incomplete work)", () => {
    const p = ROLLBACK_PATHS.find((p) => p.id === "preparation_to_previous");
    expect(p?.number).toBe("15.1.1");
    expect(p?.fromStage).toBe("preparation");
    expect(p?.toStage).toBe("prioritization");
    expect(p?.description.toLowerCase()).toContain("discard");
    expect(p?.implemented).toBe(true);
  });

  it("15.1.2 verification → preparation (return with issues list)", () => {
    const p = ROLLBACK_PATHS.find((p) => p.id === "verification_to_preparation");
    expect(p?.number).toBe("15.1.2");
    expect(p?.fromStage).toBe("verification");
    expect(p?.toStage).toBe("preparation");
    expect(p?.description.toLowerCase()).toContain("issues list");
    expect(p?.implemented).toBe(true);
  });

  it("15.1.3 soft launch → verification (pause, fix, resume)", () => {
    const p = ROLLBACK_PATHS.find((p) => p.id === "soft_launch_to_verification");
    expect(p?.number).toBe("15.1.3");
    expect(p?.fromStage).toBe("soft_launch");
    expect(p?.toStage).toBe("verification");
    expect(p?.description.toLowerCase()).toContain("pause");
    expect(p?.description.toLowerCase()).toContain("fix");
    expect(p?.description.toLowerCase()).toContain("resume");
    expect(p?.implemented).toBe(true);
  });

  it("15.1.4 public launch → soft launch (limit access to cohort)", () => {
    const p = ROLLBACK_PATHS.find((p) => p.id === "public_launch_to_soft_launch");
    expect(p?.number).toBe("15.1.4");
    expect(p?.fromStage).toBe("public_launch");
    expect(p?.toStage).toBe("soft_launch");
    expect(p?.description.toLowerCase()).toContain("cohort");
    expect(p?.implemented).toBe(true);
  });

  it("15.1.5 live → paused (disable signup, keep existing users)", () => {
    const p = ROLLBACK_PATHS.find((p) => p.id === "live_to_paused");
    expect(p?.number).toBe("15.1.5");
    expect(p?.fromStage).toBe("monitoring (live)");
    expect(p?.toStage).toBe("paused");
    expect(p?.description.toLowerCase()).toContain("disable signup");
    expect(p?.description.toLowerCase()).toContain("keep existing users");
    expect(p?.implemented).toBe(true);
  });

  it("15.2 has 4 retirement triggers", () => {
    expect(RETIREMENT_TRIGGERS).toHaveLength(4);
    const ids = RETIREMENT_TRIGGERS.map((t) => t.id);
    expect(ids).toContain("adoption_below_threshold");
    expect(ids).toContain("economics_dont_work");
    expect(ids).toContain("compliance_prohibitive");
    expect(ids).toContain("strategic_shift");
  });

  it("all 4 retirement triggers are implemented", () => {
    const v = verifyRollbackRetirement();
    expect(v.implementedRetirementTriggers).toBe(4);
    expect(v.totalRetirementTriggers).toBe(4);
  });

  it("15.2.1 adoption below threshold for 12+ months", () => {
    const t = RETIREMENT_TRIGGERS.find((t) => t.id === "adoption_below_threshold");
    expect(t?.number).toBe("15.2.1");
    expect(t?.title.toLowerCase()).toContain("adoption");
    expect(t?.title.toLowerCase()).toContain("12");
    expect(t?.implemented).toBe(true);
  });

  it("15.2.2 economics don't work", () => {
    const t = RETIREMENT_TRIGGERS.find((t) => t.id === "economics_dont_work");
    expect(t?.number).toBe("15.2.2");
    expect(t?.title.toLowerCase()).toContain("economics");
    expect(t?.implemented).toBe(true);
  });

  it("15.2.3 compliance becomes prohibitive", () => {
    const t = RETIREMENT_TRIGGERS.find((t) => t.id === "compliance_prohibitive");
    expect(t?.number).toBe("15.2.3");
    expect(t?.title.toLowerCase()).toContain("compliance");
    expect(t?.title.toLowerCase()).toContain("prohibitive");
    expect(t?.implemented).toBe(true);
  });

  it("15.2.4 strategic priorities shift", () => {
    const t = RETIREMENT_TRIGGERS.find((t) => t.id === "strategic_shift");
    expect(t?.number).toBe("15.2.4");
    expect(t?.title.toLowerCase()).toContain("strategic");
    expect(t?.implemented).toBe(true);
  });

  it("retirement function is implemented (human-approved, communicated, data export)", () => {
    const v = verifyRollbackRetirement();
    expect(v.retirementFunctionImplemented).toBe(true);
  });

  it("RetirementProcess type has the expected shape", () => {
    const r: RetirementProcess = {
      regionCode: "us",
      trigger: "adoption_below_threshold",
      approvedBy: "committee",
      approvedAt: new Date(),
      usersNotified: true,
      notifiedAt: new Date(),
      dataExportProvided: true,
      migrationOptionsProvided: true,
      retiredAt: new Date(),
      dataArchived: false,
      archivedAt: null,
    };
    expect(r.regionCode).toBe("us");
    expect(r.trigger).toBe("adoption_below_threshold");
    expect(r.usersNotified).toBe(true);
    expect(r.dataExportProvided).toBe(true);
    expect(r.migrationOptionsProvided).toBe(true);
  });

  it("RollbackPathId is the union of 5 named ids", () => {
    const ids: RollbackPathId[] = [
      "preparation_to_previous", "verification_to_preparation",
      "soft_launch_to_verification", "public_launch_to_soft_launch", "live_to_paused",
    ];
    expect(ids).toHaveLength(5);
  });

  it("RetirementTriggerId is the union of 4 named ids", () => {
    const ids: RetirementTriggerId[] = [
      "adoption_below_threshold", "economics_dont_work",
      "compliance_prohibitive", "strategic_shift",
    ];
    expect(ids).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 16. Governance Integration
// ───────────────────────────────────────────────

describe("16 — Governance Integration", () => {
  it("has 8 governance integration points", () => {
    expect(GOVERNANCE_INTEGRATIONS).toHaveLength(8);
    const ids = GOVERNANCE_INTEGRATIONS.map((i) => i.id);
    expect(ids).toContain("policy_as_code");
    expect(ids).toContain("risk_levels");
    expect(ids).toContain("reputation");
    expect(ids).toContain("transparency");
    expect(ids).toContain("governance_committee");
    expect(ids).toContain("kill_switches");
    expect(ids).toContain("circuit_breakers");
    expect(ids).toContain("rollback");
  });

  it("all 8 integrations are implemented", () => {
    const v = verifyGovernanceIntegration();
    expect(v.implementedIntegrations).toBe(8);
    expect(v.totalIntegrations).toBe(8);
    expect(v.allImplemented).toBe(true);
  });

  it("every integration has decisions it governs + enforcedBy + firesAtStages", () => {
    for (const i of GOVERNANCE_INTEGRATIONS) {
      expect(i.governsDecisions.length).toBeGreaterThan(0);
      expect(i.enforcedBy.length).toBeGreaterThan(0);
      expect(i.firesAtStages.length).toBeGreaterThan(0);
      expect(i.implemented).toBe(true);
    }
  });

  it("16.1 policy as code defines regional rules", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "policy_as_code");
    expect(i?.number).toBe("16.1");
    expect(i?.title.toLowerCase()).toContain("policy as code");
    expect(i?.enforcedBy).toContain("policy-as-code.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.2 risk levels determine approval flows", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "risk_levels");
    expect(i?.number).toBe("16.2");
    expect(i?.title.toLowerCase()).toContain("risk levels");
    expect(i?.enforcedBy).toContain("risk-levels.ts");
    expect(i?.enforcedBy).toContain("decision-engine.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.3 reputation shapes review depth", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "reputation");
    expect(i?.number).toBe("16.3");
    expect(i?.title.toLowerCase()).toContain("reputation");
    expect(i?.enforcedBy).toContain("reputation-trust.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.4 transparency gives users and auditors visibility", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "transparency");
    expect(i?.number).toBe("16.4");
    expect(i?.title.toLowerCase()).toContain("transparency");
    expect(i?.enforcedBy).toContain("transparency-audiences.ts");
    expect(i?.enforcedBy).toContain("governance-decision-log.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.5 governance committee handles exceptions", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "governance_committee");
    expect(i?.number).toBe("16.5");
    expect(i?.title.toLowerCase()).toContain("governance committee");
    expect(i?.enforcedBy).toContain("governance-committee.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.6 kill switches provide immediate halt", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "kill_switches");
    expect(i?.number).toBe("16.6");
    expect(i?.title.toLowerCase()).toContain("kill switches");
    expect(i?.enforcedBy).toContain("kill-switches.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.7 circuit breakers provide automated protection", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "circuit_breakers");
    expect(i?.number).toBe("16.7");
    expect(i?.title.toLowerCase()).toContain("circuit breakers");
    expect(i?.enforcedBy).toContain("circuit-breakers.ts");
    expect(i?.implemented).toBe(true);
  });

  it("16.8 rollback provides recovery", () => {
    const i = GOVERNANCE_INTEGRATIONS.find((i) => i.id === "rollback");
    expect(i?.number).toBe("16.8");
    expect(i?.title.toLowerCase()).toContain("rollback");
    expect(i?.enforcedBy).toContain("rollback.ts");
    expect(i?.enforcedBy).toContain("rollback-retirement.ts");
    expect(i?.implemented).toBe(true);
  });

  it("isDecisionGoverned returns true for known decision types", () => {
    expect(isDecisionGoverned("region activation")).toBe(true);
    expect(isDecisionGoverned("region retirement")).toBe(true);
    expect(isDecisionGoverned("pricing")).toBe(true);
    expect(isDecisionGoverned("payment method")).toBe(true);
    expect(isDecisionGoverned("compliance gate")).toBe(true);
  });

  it("getIntegrationForDecision returns the governing integration", () => {
    // "region retirement" is governed by risk_levels (first match — "Region retirement (critical risk → ...)")
    // and governance_committee. The function returns the first match.
    const integration = getIntegrationForDecision("region retirement");
    expect(integration).toBeDefined();
    // Verify it's one of the integrations that govern retirement decisions.
    expect(["risk_levels", "governance_committee"]).toContain(integration?.id);
  });

  it("GovernanceIntegrationId is the union of 8 named ids", () => {
    const ids: GovernanceIntegrationId[] = [
      "policy_as_code", "risk_levels", "reputation", "transparency",
      "governance_committee", "kill_switches", "circuit_breakers", "rollback",
    ];
    expect(ids).toHaveLength(8);
  });
});
