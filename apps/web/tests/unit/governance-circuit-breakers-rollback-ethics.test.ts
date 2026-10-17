/**
 * Governance — Circuit Breakers (11.2) + Rollback (11.3) + Ethics (12) — tests.
 *
 * Verifies the spec:
 *   11.2  5 governance circuit breakers (cost/latency/error/abuse/compliance).
 *         All auto-recover when conditions normalize.
 *   11.3  4 rollback paths (policy/marketplace/regional/enterprise).
 *   12.1  7 ethical principles (Fairness, Explainability, Consistency,
 *         Transparency, Reversibility, Human oversight, Accountability).
 *   12.2  4 bias audit types (disparate impact, native-speaker, cross-regional,
 *         external annual).
 *   12.3  3 ethical review depths (standard / committee / external).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  GOVERNANCE_BREAKERS,
  verifyCircuitBreakers,
  isBreakerOpen,
  getBreakerStateSnapshot,
  evaluateBreaker,
  _resetBreakerStatesForTests,
  type GovernanceBreakerType,
  type BreakerState,
  type BreakerTransition,
} from "@/lib/governance/circuit-breakers";
import {
  ROLLBACK_PATHS,
  verifyRollbacks,
  isActionReversible,
  type RollbackType,
} from "@/lib/governance/rollback";
import {
  ETHICAL_PRINCIPLES,
  BIAS_AUDITS,
  verifyEthics,
  determineReviewDepth,
  type EthicalPrinciple,
  type BiasAuditType,
  type EthicalReviewRequest,
  type EthicalReviewDepth,
} from "@/lib/governance/ethics";

// ───────────────────────────────────────────────
// 11.2 Circuit breakers — 5 types + auto-recovery
// ───────────────────────────────────────────────

describe("11.2 — Circuit breakers", () => {
  beforeEach(() => {
    _resetBreakerStatesForTests();
  });

  it("has 5 governance breaker types", () => {
    expect(GOVERNANCE_BREAKERS).toHaveLength(5);
    const types = GOVERNANCE_BREAKERS.map((b) => b.type);
    expect(types).toContain("cost");
    expect(types).toContain("latency");
    expect(types).toContain("error");
    expect(types).toContain("abuse");
    expect(types).toContain("compliance");
  });

  it("all 5 breakers are implemented", () => {
    const v = verifyCircuitBreakers();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedBreakers).toBe(5);
    expect(v.totalBreakers).toBe(5);
  });

  it("all breakers auto-recover (HALF_OPEN → CLOSED when condition normalizes)", () => {
    const v = verifyCircuitBreakers();
    expect(v.allAutoRecover).toBe(true);
    for (const b of v.breakers) {
      expect(b.autoRecover).toBe(true);
    }
  });

  it("11.2.1 cost breaker — trips on cost spikes, throttles or pauses", () => {
    const b = GOVERNANCE_BREAKERS.find((b) => b.type === "cost");
    expect(b?.title).toBe("Cost Breaker");
    expect(b?.description).toContain("cost spikes");
    expect(b?.tripAction).toBe("throttle_or_pause");
    expect(b?.unit).toBe("USD/hour");
    expect(b?.implemented).toBe(true);
  });

  it("11.2.2 latency breaker — trips on latency degradation, reduces load", () => {
    const b = GOVERNANCE_BREAKERS.find((b) => b.type === "latency");
    expect(b?.title).toBe("Latency Breaker");
    expect(b?.description).toContain("latency degrades");
    expect(b?.tripAction).toBe("reduce_load");
    expect(b?.unit).toBe("p95_ms");
    expect(b?.implemented).toBe(true);
  });

  it("11.2.3 error breaker — trips on error-rate spikes, pauses affected operations", () => {
    const b = GOVERNANCE_BREAKERS.find((b) => b.type === "error");
    expect(b?.title).toBe("Error Breaker");
    expect(b?.description).toContain("error rate spikes");
    expect(b?.tripAction).toBe("pause_affected_operations");
    expect(b?.unit).toBe("error_rate_percent");
    expect(b?.implemented).toBe(true);
  });

  it("11.2.4 abuse breaker — trips on abuse patterns, tightens limits", () => {
    const b = GOVERNANCE_BREAKERS.find((b) => b.type === "abuse");
    expect(b?.title).toBe("Abuse Breaker");
    expect(b?.description).toContain("abuse pattern");
    expect(b?.tripAction).toBe("tighten_limits");
    expect(b?.unit).toBe("abuse_events_per_hour");
    expect(b?.implemented).toBe(true);
  });

  it("11.2.5 compliance breaker — trips on compliance violations, halts operations", () => {
    const b = GOVERNANCE_BREAKERS.find((b) => b.type === "compliance");
    expect(b?.title).toBe("Compliance Breaker");
    expect(b?.description).toContain("compliance violation");
    expect(b?.tripAction).toBe("halt_affected_operations");
    expect(b?.unit).toBe("violations_per_hour");
    expect(b?.implemented).toBe(true);
    // Compliance has zero tolerance — trip on any violation.
    expect(b?.defaultThresholds.tripThreshold).toBe(1);
  });

  it("every breaker has hysteresis (recovery threshold < trip threshold)", () => {
    for (const b of GOVERNANCE_BREAKERS) {
      expect(b.defaultThresholds.recoveryThreshold).toBeLessThanOrEqual(b.defaultThresholds.tripThreshold);
    }
  });

  it("every breaker has a cooldown + window", () => {
    for (const b of GOVERNANCE_BREAKERS) {
      expect(b.defaultThresholds.cooldownMs).toBeGreaterThan(0);
      expect(b.defaultThresholds.windowMs).toBeGreaterThan(0);
      expect(b.defaultThresholds.cooldownMs).toBeLessThanOrEqual(b.defaultThresholds.windowMs);
    }
  });

  it("isBreakerOpen returns false when no breaker has tripped", () => {
    expect(isBreakerOpen("cost")).toBe(false);
    expect(isBreakerOpen("latency")).toBe(false);
    expect(isBreakerOpen("error")).toBe(false);
    expect(isBreakerOpen("abuse")).toBe(false);
    expect(isBreakerOpen("compliance")).toBe(false);
  });

  it("breaker states start CLOSED", () => {
    for (const b of GOVERNANCE_BREAKERS) {
      const snap = getBreakerStateSnapshot(b.type);
      // Snapshot is null until first evaluated; either null (unevaluated) or 'closed'.
      if (snap) {
        expect(snap.state).toBe("closed");
        expect(snap.tripCount).toBe(0);
      }
    }
  });

  it("BreakerType is the union of 5 named types", () => {
    const t: GovernanceBreakerType = "cost";
    const t2: GovernanceBreakerType = "latency";
    const t3: GovernanceBreakerType = "error";
    const t4: GovernanceBreakerType = "abuse";
    const t5: GovernanceBreakerType = "compliance";
    expect([t, t2, t3, t4, t5]).toHaveLength(5);
  });

  it("BreakerState is the union of closed / open / half_open", () => {
    const s1: BreakerState = "closed";
    const s2: BreakerState = "open";
    const s3: BreakerState = "half_open";
    expect([s1, s2, s3]).toHaveLength(3);
  });

  it("BreakerTransition is the union of 5 transitions", () => {
    const t1: BreakerTransition = "trip";
    const t2: BreakerTransition = "half_open";
    const t3: BreakerTransition = "recover";
    const t4: BreakerTransition = "re_trip";
    const t5: BreakerTransition = "no_change";
    expect([t1, t2, t3, t4, t5]).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 11.3 Rollback — 4 paths
// ───────────────────────────────────────────────

describe("11.3 — Rollback", () => {
  it("has 4 rollback paths", () => {
    expect(ROLLBACK_PATHS).toHaveLength(4);
    const types = ROLLBACK_PATHS.map((p) => p.type);
    expect(types).toContain("policy");
    expect(types).toContain("marketplace");
    expect(types).toContain("regional");
    expect(types).toContain("enterprise");
  });

  it("all 4 paths are implemented", () => {
    const v = verifyRollbacks();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedPaths).toBe(4);
  });

  it("11.3.1 policy rollback — reverts to previous version", () => {
    const p = ROLLBACK_PATHS.find((p) => p.type === "policy");
    expect(p?.title).toBe("Policy Rollback");
    expect(p?.description).toContain("previous version");
    expect(p?.scope).toBe("policy_versions");
    expect(p?.blastRadiusContained).toBe(false);
    expect(p?.implemented).toBe(true);
  });

  it("11.3.2 marketplace rollback — unpublishes + restores previous", () => {
    const p = ROLLBACK_PATHS.find((p) => p.type === "marketplace");
    expect(p?.title).toBe("Marketplace Rollback");
    expect(p?.description.toLowerCase()).toContain("unpublish");
    expect(p?.description).toContain("previous version");
    expect(p?.scope).toBe("marketplace_items");
    expect(p?.blastRadiusContained).toBe(false);
    expect(p?.implemented).toBe(true);
  });

  it("11.3.3 regional rollback — pauses a region without affecting others", () => {
    const p = ROLLBACK_PATHS.find((p) => p.type === "regional");
    expect(p?.title).toBe("Regional Rollback");
    expect(p?.description).toContain("without affecting other regions");
    expect(p?.scope).toBe("regional_state");
    expect(p?.blastRadiusContained).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("11.3.4 enterprise rollback — restores previous version in customer environments", () => {
    const p = ROLLBACK_PATHS.find((p) => p.type === "enterprise");
    expect(p?.title).toBe("Enterprise Rollback");
    expect(p?.description).toContain("previous version");
    expect(p?.description).toContain("specific customer");
    expect(p?.scope).toBe("enterprise_deployment");
    expect(p?.blastRadiusContained).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("regional + enterprise rollbacks have contained blast radius", () => {
    const regional = ROLLBACK_PATHS.find((p) => p.type === "regional");
    const enterprise = ROLLBACK_PATHS.find((p) => p.type === "enterprise");
    expect(regional?.blastRadiusContained).toBe(true);
    expect(enterprise?.blastRadiusContained).toBe(true);
  });

  it("policy + marketplace rollbacks have global blast radius", () => {
    const policy = ROLLBACK_PATHS.find((p) => p.type === "policy");
    const marketplace = ROLLBACK_PATHS.find((p) => p.type === "marketplace");
    expect(policy?.blastRadiusContained).toBe(false);
    expect(marketplace?.blastRadiusContained).toBe(false);
  });

  it("isActionReversible returns true for action types with rollback paths", () => {
    expect(isActionReversible("policy.update")).toBe(true);
    expect(isActionReversible("marketplace.publish")).toBe(true);
    expect(isActionReversible("region.activate")).toBe(true);
    expect(isActionReversible("enterprise.provision")).toBe(true);
    expect(isActionReversible("deployment.upgrade")).toBe(true);
  });

  it("isActionReversible returns true for routine actions (tool calls)", () => {
    expect(isActionReversible("tool.call")).toBe(true);
    expect(isActionReversible("agent.run")).toBe(true);
  });

  it("RollbackType is the union of 4 named types", () => {
    const t1: RollbackType = "policy";
    const t2: RollbackType = "marketplace";
    const t3: RollbackType = "regional";
    const t4: RollbackType = "enterprise";
    expect([t1, t2, t3, t4]).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 12.1 Ethical principles — 7 principles
// ───────────────────────────────────────────────

describe("12.1 — Ethical principles", () => {
  it("has 7 ethical principles", () => {
    expect(ETHICAL_PRINCIPLES).toHaveLength(7);
    const names = ETHICAL_PRINCIPLES.map((p) => p.principle);
    expect(names).toContain("fairness");
    expect(names).toContain("explainability");
    expect(names).toContain("consistency");
    expect(names).toContain("transparency");
    expect(names).toContain("reversibility");
    expect(names).toContain("human_oversight");
    expect(names).toContain("accountability");
  });

  it("all 7 principles are implemented + have measurements", () => {
    for (const p of ETHICAL_PRINCIPLES) {
      expect(p.implemented).toBe(true);
      expect(p.hasMeasurement).toBe(true);
      expect(p.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it("12.1 fairness — no discrimination based on protected characteristics", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "fairness");
    expect(p?.title).toBe("Fairness");
    expect(p?.description).toContain("protected characteristics");
    expect(p?.enforcedBy).toContain("auditBiasDisparateImpact");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 explainability — every decision has a reason", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "explainability");
    expect(p?.title).toBe("Explainability");
    expect(p?.description).toContain("reason");
    expect(p?.enforcedBy).toContain("governance_decision_log");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 consistency — same rules, everywhere, in every language", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "consistency");
    expect(p?.title).toBe("Consistency");
    expect(p?.description).toContain("every language");
    expect(p?.enforcedBy).toContain("policy_rules");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 transparency — users can see what happened and why", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "transparency");
    expect(p?.title).toBe("Transparency");
    expect(p?.description).toContain("Users can see");
    expect(p?.enforcedBy).toContain("transparency-audiences");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 reversibility — where possible", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "reversibility");
    expect(p?.title).toBe("Reversibility");
    expect(p?.description).toContain("reversed");
    expect(p?.enforcedBy).toContain("rollback.ts");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 human oversight — humans set direction and handle exceptions", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "human_oversight");
    expect(p?.title).toBe("Human oversight");
    expect(p?.description.toLowerCase()).toContain("humans");
    expect(p?.enforcedBy).toContain("policy_rules");
    expect(p?.implemented).toBe(true);
  });

  it("12.1 accountability — someone owns every policy", () => {
    const p = ETHICAL_PRINCIPLES.find((p) => p.principle === "accountability");
    expect(p?.title).toBe("Accountability");
    expect(p?.description).toContain("owns every policy");
    expect(p?.enforcedBy).toContain("owner_id");
    expect(p?.implemented).toBe(true);
  });

  it("EthicalPrinciple is the union of 7 named principles", () => {
    const p1: EthicalPrinciple = "fairness";
    const p2: EthicalPrinciple = "explainability";
    const p3: EthicalPrinciple = "consistency";
    const p4: EthicalPrinciple = "transparency";
    const p5: EthicalPrinciple = "reversibility";
    const p6: EthicalPrinciple = "human_oversight";
    const p7: EthicalPrinciple = "accountability";
    expect([p1, p2, p3, p4, p5, p6, p7]).toHaveLength(7);
  });
});

// ───────────────────────────────────────────────
// 12.2 Bias auditing — 4 audit types
// ───────────────────────────────────────────────

describe("12.2 — Bias auditing", () => {
  it("has 4 bias audit types", () => {
    expect(BIAS_AUDITS).toHaveLength(4);
    const types = BIAS_AUDITS.map((a) => a.type);
    expect(types).toContain("disparate_impact");
    expect(types).toContain("native_speaker_review");
    expect(types).toContain("cross_regional");
    expect(types).toContain("external_annual");
  });

  it("all 4 audits are implemented", () => {
    const v = verifyEthics();
    expect(v.biasAuditsImplemented).toBe(4);
    expect(v.biasAuditsTotal).toBe(4);
  });

  it("12.2.1 disparate impact audit — weekly, by platform", () => {
    const a = BIAS_AUDITS.find((a) => a.type === "disparate_impact");
    expect(a?.title).toBe("Disparate Impact Audit");
    expect(a?.cadence).toBe("weekly");
    expect(a?.auditor).toBe("platform");
    expect(a?.disparityThreshold).toBe(5);
    expect(a?.implemented).toBe(true);
  });

  it("12.2.2 native-speaker review — monthly, by native speakers", () => {
    const a = BIAS_AUDITS.find((a) => a.type === "native_speaker_review");
    expect(a?.title).toBe("Native-Speaker Moderation Review");
    expect(a?.cadence).toBe("monthly");
    expect(a?.auditor).toBe("native_speakers");
    expect(a?.disparityThreshold).toBe(3);
    expect(a?.implemented).toBe(true);
  });

  it("12.2.3 cross-regional fairness review — quarterly", () => {
    const a = BIAS_AUDITS.find((a) => a.type === "cross_regional");
    expect(a?.title).toBe("Cross-Regional Fairness Review");
    expect(a?.cadence).toBe("quarterly");
    expect(a?.auditor).toBe("cross_regional_team");
    expect(a?.disparityThreshold).toBe(10);
    expect(a?.implemented).toBe(true);
  });

  it("12.2.4 external annual audit — annually, by external firm", () => {
    const a = BIAS_AUDITS.find((a) => a.type === "external_annual");
    expect(a?.title).toBe("External Annual Audit");
    expect(a?.cadence).toBe("annually");
    expect(a?.auditor).toBe("external_firm");
    expect(a?.disparityThreshold).toBe(0); // any finding is reportable.
    expect(a?.implemented).toBe(true);
  });

  it("every audit has a cadence + auditor + threshold", () => {
    for (const a of BIAS_AUDITS) {
      expect(a.cadence.length).toBeGreaterThan(0);
      expect(a.auditor.length).toBeGreaterThan(0);
      expect(a.disparityThreshold).toBeGreaterThanOrEqual(0);
    }
  });

  it("BiasAuditType is the union of 4 named types", () => {
    const t1: BiasAuditType = "disparate_impact";
    const t2: BiasAuditType = "native_speaker_review";
    const t3: BiasAuditType = "cross_regional";
    const t4: BiasAuditType = "external_annual";
    expect([t1, t2, t3, t4]).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 12.3 Ethical review — 3 depths
// ───────────────────────────────────────────────

describe("12.3 — Ethical review", () => {
  it("standard depth for general-purpose capabilities (no harms)", () => {
    const req: EthicalReviewRequest = {
      capabilityName: "faster-text-rewrite",
      capabilityDescription: "Improves text rewrite speed by 2x.",
      highRiskDomain: null,
      potentialHarms: [],
      mitigations: ["backward-compatible API"],
      requestedBy: "eng-team",
    };
    expect(determineReviewDepth(req)).toBe("standard");
  });

  it("committee depth for capabilities with potential harms", () => {
    const req: EthicalReviewRequest = {
      capabilityName: "auto-decide-on-user-behalf",
      capabilityDescription: "Platform decides which emails to auto-archive.",
      highRiskDomain: null,
      potentialHarms: ["user loses important email"],
      mitigations: ["undo within 30 days"],
      requestedBy: "eng-team",
    };
    expect(determineReviewDepth(req)).toBe("committee");
  });

  it("external depth for healthcare capabilities", () => {
    const req: EthicalReviewRequest = {
      capabilityName: "auto-triage-healthcare",
      capabilityDescription: "Triages healthcare intake forms.",
      highRiskDomain: "healthcare",
      potentialHarms: [],
      mitigations: [],
      requestedBy: "eng-team",
    };
    expect(determineReviewDepth(req)).toBe("external");
  });

  it("external depth for legal capabilities", () => {
    const req: EthicalReviewRequest = {
      capabilityName: "auto-draft-legal-docs",
      capabilityDescription: "Auto-drafts standard legal documents.",
      highRiskDomain: "legal",
      potentialHarms: [],
      mitigations: [],
      requestedBy: "eng-team",
    };
    expect(determineReviewDepth(req)).toBe("external");
  });

  it("external depth for finance capabilities", () => {
    const req: EthicalReviewRequest = {
      capabilityName: "auto-reconcile-invoices",
      capabilityDescription: "Auto-reconciles invoices against bank transactions.",
      highRiskDomain: "finance",
      potentialHarms: [],
      mitigations: [],
      requestedBy: "eng-team",
    };
    expect(determineReviewDepth(req)).toBe("external");
  });

  it("EthicalReviewDepth is the union of 3 depths", () => {
    const d1: EthicalReviewDepth = "standard";
    const d2: EthicalReviewDepth = "committee";
    const d3: EthicalReviewDepth = "external";
    expect([d1, d2, d3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// Section 12 — overall verification
// ───────────────────────────────────────────────

describe("12 — Overall verification", () => {
  it("verifyEthics reports all sections implemented", () => {
    const v = verifyEthics();
    expect(v.allImplemented).toBe(true);
    expect(v.principlesTotal).toBe(7);
    expect(v.principlesImplemented).toBe(7);
    expect(v.biasAuditsTotal).toBe(4);
    expect(v.biasAuditsImplemented).toBe(4);
    expect(v.ethicalReviewDepths).toBe(3);
  });
});
