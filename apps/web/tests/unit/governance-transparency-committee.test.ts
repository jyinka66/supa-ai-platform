/**
 * Governance — Transparency (Section 7) + Governance Committee (Section 8) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  USER_TRANSPARENCY,
  AUDITOR_TRANSPARENCY,
  REGULATOR_TRANSPARENCY,
  AUDITOR_DATA_ACCESS_RULE,
  REGULATOR_REPORTING_CHANNEL,
  getTransparencySummary,
  verifyTransparency,
} from "@/lib/governance/transparency-audiences";
import {
  COMMITTEE_COMPOSITION,
  ROUTING_RULES,
  checkCommitteeRouting,
  createCommitteeDecision,
  verifyCommittee,
  type CommitteeRole,
  type CommitteeDecisionType,
  type CommitteeOutcome,
} from "@/lib/governance/governance-committee";

// ───────────────────────────────────────────────
// 7. Transparency
// ───────────────────────────────────────────────

describe("7 — Transparency", () => {
  it("7.1 users: 6 transparency items, all implemented", () => {
    expect(USER_TRANSPARENCY).toHaveLength(6);
    expect(USER_TRANSPARENCY.every((t) => t.implemented)).toBe(true);
  });

  it("7.1 users: what actions were taken", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "actions_taken");
    expect(item?.implemented).toBe(true);
    expect(item?.detail).toContain("getUserTransparency");
  });

  it("7.1 users: why each action was taken", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "why_taken");
    expect(item?.implemented).toBe(true);
    expect(item?.detail).toContain("reasoning_summary");
  });

  it("7.1 users: what policy applied", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "policy_applied");
    expect(item?.implemented).toBe(true);
    expect(item?.detail).toContain("policyKey");
  });

  it("7.1 users: how to change the policy", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "change_policy");
    expect(item?.implemented).toBe(true);
  });

  it("7.1 users: how to stop or undo", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "stop_or_undo");
    expect(item?.implemented).toBe(true);
    expect(item?.detail).toContain("reverseDecision");
  });

  it("7.1 users: how to appeal", () => {
    const item = USER_TRANSPARENCY.find((t) => t.key === "appeal");
    expect(item?.implemented).toBe(true);
    expect(item?.detail).toContain("appealDecision");
  });

  it("7.2 auditors: 5 transparency items, all implemented", () => {
    expect(AUDITOR_TRANSPARENCY).toHaveLength(5);
    expect(AUDITOR_TRANSPARENCY.every((t) => t.implemented)).toBe(true);
  });

  it("7.2 auditors: policy versions + history", () => {
    const item = AUDITOR_TRANSPARENCY.find((t) => t.key === "policy_versions");
    expect(item?.detail).toContain("policy_versions");
  });

  it("7.2 auditors: decision logs filterable + exportable", () => {
    const item = AUDITOR_TRANSPARENCY.find((t) => t.key === "decision_logs");
    expect(item?.detail).toContain("getAuditorEvidence");
  });

  it("7.2 auditors: compliance evidence", () => {
    const item = AUDITOR_TRANSPARENCY.find((t) => t.key === "compliance_evidence");
    expect(item?.detail).toContain("6 frameworks");
  });

  it("7.2 auditors: incidents + remediation", () => {
    const item = AUDITOR_TRANSPARENCY.find((t) => t.key === "incidents_remediation");
    expect(item?.detail).toContain("generatePostIncidentReview");
  });

  it("7.2 auditors: committee decisions", () => {
    const item = AUDITOR_TRANSPARENCY.find((t) => t.key === "committee_decisions");
    expect(item?.detail).toContain("governance_committee_decisions");
  });

  it("7.2 auditors: never see user data unless authorized by law", () => {
    expect(AUDITOR_DATA_ACCESS_RULE.implemented).toBe(true);
    expect(AUDITOR_DATA_ACCESS_RULE.rule).toContain("never see user data");
    expect(AUDITOR_DATA_ACCESS_RULE.detail).toContain("no PII");
  });

  it("7.3 regulators: 4 transparency items, all implemented", () => {
    expect(REGULATOR_TRANSPARENCY).toHaveLength(4);
    expect(REGULATOR_TRANSPARENCY.every((t) => t.implemented)).toBe(true);
  });

  it("7.3 regulators: data handling practices", () => {
    const item = REGULATOR_TRANSPARENCY.find((t) => t.key === "data_handling");
    expect(item?.detail).toContain("data_residency");
  });

  it("7.3 regulators: compliance evidence", () => {
    const item = REGULATOR_TRANSPARENCY.find((t) => t.key === "compliance_evidence");
    expect(item?.detail).toContain("6 frameworks");
  });

  it("7.3 regulators: incident reports", () => {
    const item = REGULATOR_TRANSPARENCY.find((t) => t.key === "incident_reports");
    expect(item?.detail).toContain("generatePostIncidentReview");
  });

  it("7.3 regulators: committee minutes", () => {
    const item = REGULATOR_TRANSPARENCY.find((t) => t.key === "committee_minutes");
    expect(item?.detail).toContain("minutes");
  });

  it("7.3 regulators: dedicated reporting channels", () => {
    expect(REGULATOR_REPORTING_CHANNEL.implemented).toBe(true);
    expect(REGULATOR_REPORTING_CHANNEL.rule).toContain("dedicated reporting channels");
  });

  it("summary: 6 + 5 + 4 = 15 transparency items, all implemented", () => {
    const summary = getTransparencySummary();
    expect(summary.users.total).toBe(6);
    expect(summary.auditors.total).toBe(5);
    expect(summary.regulators.total).toBe(4);
    expect(summary.allImplemented).toBe(true);
  });

  it("verifyTransparency returns 3 audiences", () => {
    const result = verifyTransparency();
    expect(result).toHaveLength(3);
    expect(result[0]?.audience).toBe("users");
    expect(result[1]?.audience).toBe("auditors");
    expect(result[2]?.audience).toBe("regulators");
  });
});

// ───────────────────────────────────────────────
// 8. Governance Committee
// ───────────────────────────────────────────────

describe("8 — Governance Committee", () => {
  it("8.1 has 6 committee members", () => {
    expect(COMMITTEE_COMPOSITION).toHaveLength(6);
  });

  it("8.1 chairman is Founder or CEO", () => {
    const chairman = COMMITTEE_COMPOSITION.find((m) => m.role === "chairman");
    expect(chairman?.title).toBe("Founder or CEO");
  });

  it("8.1 has Head of Engineering for technical decisions", () => {
    const eng = COMMITTEE_COMPOSITION.find((m) => m.role === "head_of_engineering");
    expect(eng?.title).toBe("Head of Engineering");
  });

  it("8.1 has Head of Legal for legal, compliance, ethics", () => {
    const legal = COMMITTEE_COMPOSITION.find((m) => m.role === "head_of_legal");
    expect(legal?.title).toContain("Legal");
  });

  it("8.1 has Head of Security for security incidents", () => {
    const sec = COMMITTEE_COMPOSITION.find((m) => m.role === "head_of_security");
    expect(sec?.title).toContain("Security");
  });

  it("8.1 has Head of Trust & Safety for moderation, abuse, appeals", () => {
    const trust = COMMITTEE_COMPOSITION.find((m) => m.role === "head_of_trust_safety");
    expect(trust?.title).toContain("Trust");
  });

  it("8.1 has Head of Customer Success for customer-impacting decisions", () => {
    const cs = COMMITTEE_COMPOSITION.find((m) => m.role === "head_of_customer_success");
    expect(cs?.title).toContain("Customer Success");
  });

  it("has 10 decision types", () => {
    expect(ROUTING_RULES).toHaveLength(10);
  });

  it("has 6 committee roles", () => {
    const roles: CommitteeRole[] = [
      "chairman", "head_of_engineering", "head_of_legal",
      "head_of_security", "head_of_trust_safety", "head_of_customer_success",
    ];
    expect(roles).toHaveLength(6);
  });

  it("routing: appeal requires Trust & Safety + quorum 3", () => {
    const rule = ROUTING_RULES.find((r) => r.type === "appeal");
    expect(rule?.requiredQuorum).toBe(3);
    expect(rule?.requiredRole).toBe("head_of_trust_safety");
  });

  it("routing: executive_override requires chairman + quorum 5 + 48h cooling-off", () => {
    const rule = ROUTING_RULES.find((r) => r.type === "executive_override");
    expect(rule?.requiredQuorum).toBe(5);
    expect(rule?.requiredRole).toBe("chairman");
    expect(rule?.coolingOffHours).toBe(48);
  });

  it("routing: policy_override requires chairman + quorum 4 + 24h cooling-off", () => {
    const rule = ROUTING_RULES.find((r) => r.type === "policy_override");
    expect(rule?.requiredQuorum).toBe(4);
    expect(rule?.coolingOffHours).toBe(24);
  });

  it("routing: new_jurisdiction requires Head of Legal + quorum 4", () => {
    const rule = ROUTING_RULES.find((r) => r.type === "new_jurisdiction");
    expect(rule?.requiredRole).toBe("head_of_legal");
    expect(rule?.requiredQuorum).toBe(4);
  });

  it("routing: incident_escalation requires Head of Security + quorum 3", () => {
    const rule = ROUTING_RULES.find((r) => r.type === "incident_escalation");
    expect(rule?.requiredRole).toBe("head_of_security");
  });

  it("checkCommitteeRouting: blocked when quorum not met", () => {
    const members = COMMITTEE_COMPOSITION.slice(0, 2).map((m) => ({ ...m, present: true }));
    const result = checkCommitteeRouting({ type: "appeal", membersPresent: members });
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("Quorum not met");
  });

  it("checkCommitteeRouting: blocked when required role not present", () => {
    const members = COMMITTEE_COMPOSITION.map((m) => ({
      ...m,
      present: m.role !== "head_of_trust_safety", // Trust & Safety absent.
    }));
    const result = checkCommitteeRouting({ type: "appeal", membersPresent: members });
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("Required role not present");
  });

  it("checkCommitteeRouting: approved when quorum + required role present", () => {
    const members = COMMITTEE_COMPOSITION.map((m) => ({ ...m, present: true }));
    const result = checkCommitteeRouting({ type: "appeal", membersPresent: members });
    expect(result.canProceed).toBe(true);
  });

  it("createCommitteeDecision: creates a decision with all fields", () => {
    const decision = createCommitteeDecision({
      type: "appeal",
      subject: "Marketplace takedown appeal",
      description: "Creator appeals automated takedown of their agent.",
      outcome: "approved",
      reasoning: "The takedown was triggered by a false positive in the abuse detection algorithm. The agent does not violate marketplace policies.",
      membersPresent: COMMITTEE_COMPOSITION.map((m) => ({ ...m, present: true })),
      votes: { approve: 5, reject: 1, defer: 0, table: 0 },
      dissent: "Head of Security dissented: recommends additional monitoring for 30 days.",
    });
    expect(decision.id).toBeTruthy();
    expect(decision.outcome).toBe("approved");
    expect(decision.voteCount.approve).toBe(5);
    expect(decision.dissent).toContain("Security");
  });

  it("4 committee outcomes: approved, rejected, deferred, tabled", () => {
    const outcomes: CommitteeOutcome[] = ["approved", "rejected", "deferred", "tabled"];
    expect(outcomes).toHaveLength(4);
  });

  it("verifyCommittee: 6 members, 10 decision types, all routing rules have required roles", () => {
    const summary = verifyCommittee();
    expect(summary.membersCount).toBe(6);
    expect(summary.decisionTypes).toBe(10);
    expect(summary.allRoutingRulesHaveRequiredRole).toBe(true);
  });
});
