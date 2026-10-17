/**
 * Governance — Risk Levels (Section 5) + Reputation & Trust (Section 6) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  RISK_LEVELS,
  classifyAction,
  getRiskLevelSpec,
  checkRiskLevel,
  type RiskLevel,
  type ApprovalFlow,
} from "@/lib/governance/risk-levels";
import {
  TRUST_THRESHOLDS,
  TRUST_TIER_EFFECTS,
  getTrustTier,
  calculateReputation,
  getTrustTierEffects,
  canAdjustReputation,
  type ReputationDimension,
  type TrustTier,
} from "@/lib/governance/reputation-trust";

// ───────────────────────────────────────────────
// 5. Risk Levels and Approval Flows
// ───────────────────────────────────────────────

describe("5 — Risk Levels and Approval Flows", () => {
  it("has 5 risk levels: low, medium, high, critical, irreversible", () => {
    const levels: RiskLevel[] = ["low", "medium", "high", "critical", "irreversible"];
    expect(levels).toHaveLength(5);
    expect(Object.keys(RISK_LEVELS)).toHaveLength(5);
  });

  it("5.1 low: automatic, standard logging, standard rate limits", () => {
    const spec = getRiskLevelSpec("low");
    expect(spec.approvalFlow).toBe("automatic");
    expect(spec.loggingLevel).toBe("standard");
    expect(spec.rateLimitTier).toBe("standard");
    expect(spec.delegable).toBe(false);
  });

  it("5.2 medium: policy_check, detailed logging, tiered rate limits", () => {
    const spec = getRiskLevelSpec("medium");
    expect(spec.approvalFlow).toBe("policy_check");
    expect(spec.loggingLevel).toBe("detailed");
    expect(spec.rateLimitTier).toBe("tiered");
  });

  it("5.3 high: human_approval, full audit, strict rate limits, delegable", () => {
    const spec = getRiskLevelSpec("high");
    expect(spec.approvalFlow).toBe("human_approval");
    expect(spec.loggingLevel).toBe("full_audit");
    expect(spec.rateLimitTier).toBe("strict");
    expect(spec.delegable).toBe(true);
  });

  it("5.4 critical: two_person_rule, full audit + owner notification, throttled, delay window", () => {
    const spec = getRiskLevelSpec("critical");
    expect(spec.approvalFlow).toBe("two_person_rule");
    expect(spec.loggingLevel).toBe("full_audit_plus_notification");
    expect(spec.rateLimitTier).toBe("throttled");
    expect(spec.requiresTwoPerson).toBe(true);
    expect(spec.requiresDelay).toBe(true);
    expect(spec.delayWindowMinutes).toBe(5);
    expect(spec.notifyOwner).toBe(true);
  });

  it("5.5 irreversible: two_person + cooling_off, external notification, executive override", () => {
    const spec = getRiskLevelSpec("irreversible");
    expect(spec.approvalFlow).toBe("two_person_plus_cooling_off");
    expect(spec.loggingLevel).toBe("full_audit_plus_external_notification");
    expect(spec.requiresTwoPerson).toBe(true);
    expect(spec.requiresCoolingOff).toBe(true);
    expect(spec.coolingOffHours).toBe(24);
    expect(spec.notifyExternal).toBe(true);
    expect(spec.executiveOverrideAllowed).toBe(true);
  });

  it("classifyAction: read-only → low", () => {
    expect(classifyAction("search.web")).toBe("low");
    expect(classifyAction("format.text")).toBe("low");
  });

  it("classifyAction: email.send → medium", () => {
    expect(classifyAction("email.send")).toBe("medium");
    expect(classifyAction("invoice.create")).toBe("medium");
  });

  it("classifyAction: charge → high", () => {
    expect(classifyAction("charge.payment")).toBe("high");
    expect(classifyAction("deploy.production")).toBe("high");
  });

  it("classifyAction: workspace.delete → critical", () => {
    expect(classifyAction("workspace.delete")).toBe("critical");
    expect(classifyAction("credentials.revoke")).toBe("critical");
  });

  it("classifyAction: permanent.delete → irreversible", () => {
    expect(classifyAction("permanent.delete")).toBe("irreversible");
    expect(classifyAction("fund.transfer.out")).toBe("irreversible");
  });

  it("classifyAction: high cost financial → high", () => {
    expect(classifyAction("payment.process", { isFinancial: true, costUsd: 150 })).toBe("high");
  });

  it("classifyAction: low cost financial → medium", () => {
    expect(classifyAction("payment.process", { isFinancial: true, costUsd: 5 })).toBe("medium");
  });

  it("checkRiskLevel: low → canProceed immediately", () => {
    const result = checkRiskLevel("low");
    expect(result.canProceed).toBe(true);
    expect(result.approvalRequired).toBe(false);
  });

  it("checkRiskLevel: high with delegation → canProceed", () => {
    const result = checkRiskLevel("high", { hasDelegation: true });
    expect(result.canProceed).toBe(true);
  });

  it("checkRiskLevel: high without delegation → blocked", () => {
    const result = checkRiskLevel("high", { hasDelegation: false });
    expect(result.canProceed).toBe(false);
    expect(result.approvalRequired).toBe(true);
  });

  it("checkRiskLevel: critical with two-person + delay elapsed → canProceed", () => {
    const result = checkRiskLevel("critical", { hasTwoPersonApproval: true, delayElapsed: true });
    expect(result.canProceed).toBe(true);
  });

  it("checkRiskLevel: critical without two-person → blocked", () => {
    const result = checkRiskLevel("critical", { hasTwoPersonApproval: false, delayElapsed: true });
    expect(result.canProceed).toBe(false);
    expect(result.twoPersonRequired).toBe(true);
  });

  it("checkRiskLevel: irreversible with executive override → canProceed", () => {
    const result = checkRiskLevel("irreversible", { hasExecutiveOverride: true });
    expect(result.canProceed).toBe(true);
    expect(result.notifyExternal).toBe(true);
  });

  it("checkRiskLevel: irreversible without cooling-off → blocked", () => {
    const result = checkRiskLevel("irreversible", { hasTwoPersonApproval: true, coolingOffElapsed: false });
    expect(result.canProceed).toBe(false);
    expect(result.coolingOffRequired).toBe(true);
  });

  it("checkRiskLevel: irreversible with two-person + cooling-off → canProceed", () => {
    const result = checkRiskLevel("irreversible", { hasTwoPersonApproval: true, coolingOffElapsed: true });
    expect(result.canProceed).toBe(true);
  });

  it("5 approval flows: automatic, policy_check, human_approval, two_person_rule, two_person_plus_cooling_off", () => {
    const flows: ApprovalFlow[] = ["automatic", "policy_check", "human_approval", "two_person_rule", "two_person_plus_cooling_off"];
    expect(flows).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 6. Reputation and Trust
// ───────────────────────────────────────────────

describe("6 — Reputation and Trust", () => {
  it("has 7 reputation dimensions", () => {
    const dims: ReputationDimension[] = ["user", "workspace", "agent_creator", "connector_creator", "template_creator", "partner", "developer"];
    expect(dims).toHaveLength(7);
  });

  it("has 4 trust tiers: trusted, new, distrusted, banned", () => {
    const tiers: TrustTier[] = ["trusted", "new", "distrusted", "banned"];
    expect(tiers).toHaveLength(4);
    expect(Object.keys(TRUST_TIER_EFFECTS)).toHaveLength(4);
  });

  it("trust thresholds: trusted≥70, new≥40, distrusted≥1, banned=0", () => {
    expect(TRUST_THRESHOLDS.trusted).toBe(70);
    expect(TRUST_THRESHOLDS.new).toBe(40);
    expect(TRUST_THRESHOLDS.distrusted).toBe(1);
    expect(TRUST_THRESHOLDS.banned).toBe(0);
  });

  it("getTrustTier: score 80 → trusted", () => {
    expect(getTrustTier(80)).toBe("trusted");
    expect(getTrustTier(70)).toBe("trusted");
  });

  it("getTrustTier: score 50 → new", () => {
    expect(getTrustTier(50)).toBe("new");
    expect(getTrustTier(40)).toBe("new");
  });

  it("getTrustTier: score 20 → distrusted", () => {
    expect(getTrustTier(20)).toBe("distrusted");
    expect(getTrustTier(1)).toBe("distrusted");
  });

  it("getTrustTier: score 0 → banned", () => {
    expect(getTrustTier(0)).toBe("banned");
  });

  it("trusted effects: lighter review, extended limits, fast publishing, full scopes", () => {
    const effects = getTrustTierEffects("trusted");
    expect(effects.reviewLevel).toBe("lighter");
    expect(effects.rateLimits).toBe("extended");
    expect(effects.publishingSpeed).toBe("fast");
    expect(effects.scopes).toBe("full");
    expect(effects.probation).toBe(false);
  });

  it("new effects: standard review, standard limits, probation", () => {
    const effects = getTrustTierEffects("new");
    expect(effects.reviewLevel).toBe("standard");
    expect(effects.rateLimits).toBe("standard");
    expect(effects.publishingSpeed).toBe("standard");
    expect(effects.probation).toBe(true);
  });

  it("distrusted effects: heavier review, lower limits, restricted scopes, appeal path", () => {
    const effects = getTrustTierEffects("distrusted");
    expect(effects.reviewLevel).toBe("heavier");
    expect(effects.rateLimits).toBe("lower");
    expect(effects.scopes).toBe("restricted");
    expect(effects.appealPath).toBe(true);
  });

  it("banned effects: blocked, restricted, appeal path", () => {
    const effects = getTrustTierEffects("banned");
    expect(effects.reviewLevel).toBe("blocked");
    expect(effects.publishingSpeed).toBe("blocked");
    expect(effects.scopes).toBe("none");
    expect(effects.appealPath).toBe(true);
  });

  it("calculateReputation: user with high tenure + verified → trusted", () => {
    const rep = calculateReputation("user", "user-1", {
      tenure_months: 48,
      verified_identity: 1,
      payment_history: 1,
      abuse_free_months: 48,
    });
    expect(rep.score).toBeGreaterThan(70);
    expect(rep.tier).toBe("trusted");
  });

  it("calculateReputation: user with abuse history → distrusted", () => {
    const rep = calculateReputation("user", "user-2", {
      tenure_months: 6,
      verified_identity: 0,
      payment_history: 0,
      abuse_free_months: 0,
    });
    expect(rep.score).toBeLessThan(40);
    expect(rep.tier).toBe("distrusted");
  });

  it("calculateReputation: agent creator with high ratings + no takedowns → trusted", () => {
    const rep = calculateReputation("agent_creator", "creator-1", {
      published_count: 20,
      avg_rating: 4.5,
      takedown_count: 0,
      support_responsiveness: 1,
    });
    expect(rep.tier).toBe("trusted");
  });

  it("canAdjustReputation: small drop (≤10) is automatic", () => {
    const result = canAdjustReputation(80, 75);
    expect(result.allowed).toBe(true);
    expect(result.requiresHumanReview).toBe(false);
  });

  it("canAdjustReputation: medium drop (11-30) requires human review", () => {
    const result = canAdjustReputation(80, 55);
    expect(result.allowed).toBe(false);
    expect(result.requiresHumanReview).toBe(true);
  });

  it("canAdjustReputation: large drop (>30) requires human review", () => {
    const result = canAdjustReputation(80, 10);
    expect(result.allowed).toBe(false);
    expect(result.requiresHumanReview).toBe(true);
  });

  it("canAdjustReputation: banning (to 0) requires human review", () => {
    const result = canAdjustReputation(70, 0);
    expect(result.allowed).toBe(false);
    expect(result.requiresHumanReview).toBe(true);
  });

  it("reputation is never permanently punitive without human review", () => {
    // All drops > 10 points require human review.
    expect(canAdjustReputation(50, 30).requiresHumanReview).toBe(true);
    expect(canAdjustReputation(50, 10).requiresHumanReview).toBe(true);
    expect(canAdjustReputation(50, 45).requiresHumanReview).toBe(false); // 5 point drop = automatic.
  });
});
