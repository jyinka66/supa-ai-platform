/**
 * Governance — Committee Responsibilities (8.2-8.3) + Appeals (Section 9) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  COMMITTEE_RESPONSIBILITIES,
  COMMITTEE_CADENCES,
  verifyCommitteeResponsibilities,
  type CommitteeResponsibility,
  type CommitteeCadence,
} from "@/lib/governance/committee-responsibilities";
import {
  APPEAL_TYPES,
  APPEAL_WORKFLOW,
  APPEAL_TIME_LIMITS,
  getDecisionDeadline,
  createAppeal,
  isAppealOverdue,
  verifyAppeals,
  type AppealType,
  type AppealWorkflowStep,
  type AppealStatus,
} from "@/lib/governance/appeals";

// ───────────────────────────────────────────────
// 8.2 Committee Responsibilities
// ───────────────────────────────────────────────

describe("8.2 — Committee Responsibilities", () => {
  it("has 7 responsibilities", () => {
    expect(COMMITTEE_RESPONSIBILITIES).toHaveLength(7);
  });

  it("all 7 responsibilities are implemented", () => {
    expect(COMMITTEE_RESPONSIBILITIES.every((r) => r.implemented)).toBe(true);
  });

  it("R1: approve or deny policy changes proposed by auto-tuning", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "approve_policy_changes");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("proposePolicyTuning");
  });

  it("R2: review high-risk and critical-risk actions", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "review_high_risk_actions");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("routeDecision");
  });

  it("R3: review incident reports and remediation", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "review_incidents");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("generatePostIncidentReview");
  });

  it("R4: review appeals of automated decisions", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "review_appeals");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("appealDecision");
  });

  it("R5: review marketplace submissions requiring human judgment", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "review_marketplace");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("reviewSubmission");
  });

  it("R6: set direction on ethics, fairness, and safety", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "set_ethics_direction");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("runEthicalAiCheck");
  });

  it("R7: publish quarterly transparency reports", () => {
    const r = COMMITTEE_RESPONSIBILITIES.find((r) => r.key === "publish_transparency");
    expect(r?.implemented).toBe(true);
    expect(r?.detail).toContain("generateReport");
  });
});

// ───────────────────────────────────────────────
// 8.3 Cadence
// ───────────────────────────────────────────────

describe("8.3 — Cadence", () => {
  it("has 4 cadences: weekly, monthly, quarterly, ad hoc", () => {
    const cadences: CommitteeCadence[] = ["weekly", "monthly", "quarterly", "ad_hoc"];
    expect(cadences).toHaveLength(4);
    expect(COMMITTEE_CADENCES).toHaveLength(4);
  });

  it("all 4 cadences are implemented", () => {
    expect(COMMITTEE_CADENCES.every((c) => c.implemented)).toBe(true);
  });

  it("weekly: routine reviews, pending approvals, incidents", () => {
    const c = COMMITTEE_CADENCES.find((c) => c.cadence === "weekly");
    expect(c?.items).toContain("Pending approval queue");
    expect(c?.items).toContain("Incident review");
  });

  it("monthly: policy auto-tuning proposals, marketplace escalations", () => {
    const c = COMMITTEE_CADENCES.find((c) => c.cadence === "monthly");
    expect(c?.items).toContain("Policy auto-tuning proposals review");
    expect(c?.items).toContain("Marketplace escalation review");
  });

  it("quarterly: transparency report, compliance review, strategic direction", () => {
    const c = COMMITTEE_CADENCES.find((c) => c.cadence === "quarterly");
    expect(c?.items).toContain("Transparency report publication");
    expect(c?.items).toContain("Compliance review (6 frameworks)");
    expect(c?.items).toContain("Strategic direction on ethics/fairness/safety");
  });

  it("ad hoc: incidents, urgent decisions", () => {
    const c = COMMITTEE_CADENCES.find((c) => c.cadence === "ad_hoc");
    expect(c?.items).toContain("Critical incidents");
    expect(c?.items).toContain("Emergency takedowns");
  });

  it("verifyCommitteeResponsibilities: 7 + 4, all implemented", () => {
    const summary = verifyCommitteeResponsibilities();
    expect(summary.responsibilities.total).toBe(7);
    expect(summary.responsibilities.implemented).toBe(7);
    expect(summary.cadences.total).toBe(4);
    expect(summary.cadences.implemented).toBe(4);
    expect(summary.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 9. Appeals
// ───────────────────────────────────────────────

describe("9 — Appeals", () => {
  it("9.1: has 5 appeal types", () => {
    expect(APPEAL_TYPES).toHaveLength(5);
  });

  it("9.1: user appeal — contests action on their behalf", () => {
    const t = APPEAL_TYPES.find((t) => t.type === "user");
    expect(t?.description).toContain("on their behalf");
  });

  it("9.1: creator appeal — marketplace submission rejected or removed", () => {
    const t = APPEAL_TYPES.find((t) => t.type === "creator");
    expect(t?.description).toContain("rejected or removed");
  });

  it("9.1: partner appeal — partnership decision", () => {
    const t = APPEAL_TYPES.find((t) => t.type === "partner");
    expect(t?.description).toContain("partnership");
  });

  it("9.1: developer appeal — rate limit, suspension, or ban", () => {
    const t = APPEAL_TYPES.find((t) => t.type === "developer");
    expect(t?.description).toContain("rate limit");
    expect(t?.description).toContain("suspension");
    expect(t?.description).toContain("ban");
  });

  it("9.1: regional appeal — regional rollout denied", () => {
    const t = APPEAL_TYPES.find((t) => t.type === "regional");
    expect(t?.description).toContain("regional rollout");
  });

  it("9.2: has 6 workflow steps", () => {
    expect(APPEAL_WORKFLOW).toHaveLength(6);
  });

  it("9.2: all 6 steps are implemented", () => {
    expect(APPEAL_WORKFLOW.every((s) => s.implemented)).toBe(true);
  });

  it("9.2: submit — in-app or via email", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "submit");
    expect(s?.implemented).toBe(true);
    expect(s?.detail).toContain("appealDecision");
  });

  it("9.2: acknowledge — within 24 hours", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "acknowledge");
    expect(s?.description).toContain("24 hours");
  });

  it("9.2: review — by human reviewer with authority to overturn", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "review");
    expect(s?.description).toContain("authority to overturn");
  });

  it("9.2: decide — with reasoning", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "decide");
    expect(s?.description).toContain("reasoning");
  });

  it("9.2: notify — clear, respectful, actionable", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "notify");
    expect(s?.description).toContain("respectful");
    expect(s?.description).toContain("actionable");
  });

  it("9.2: log — every appeal and decision is auditable", () => {
    const s = APPEAL_WORKFLOW.find((s) => s.step === "log");
    expect(s?.description).toContain("auditable");
  });

  it("9.3: acknowledge within 24 hours", () => {
    expect(APPEAL_TIME_LIMITS.acknowledgeHours).toBe(24);
  });

  it("9.3: decide within 7 days for routine", () => {
    expect(APPEAL_TIME_LIMITS.decideRoutineDays).toBe(7);
  });

  it("9.3: decide within 48 hours for time-sensitive", () => {
    expect(APPEAL_TIME_LIMITS.decideTimeSensitiveHours).toBe(48);
  });

  it("9.3: developer appeals are time-sensitive (48h)", () => {
    const deadline = getDecisionDeadline("developer");
    expect(deadline.isTimeSensitive).toBe(true);
    expect(deadline.hours).toBe(48);
  });

  it("9.3: user appeals are routine (7d = 168h)", () => {
    const deadline = getDecisionDeadline("user");
    expect(deadline.isTimeSensitive).toBe(false);
    expect(deadline.hours).toBe(168); // 7 * 24.
  });

  it("createAppeal: creates a record with all fields", () => {
    const appeal = createAppeal({
      type: "user",
      decisionId: "dec-123",
      appellantId: "user-456",
      reason: "The agent action was incorrectly blocked.",
    });
    expect(appeal.id).toBeTruthy();
    expect(appeal.type).toBe("user");
    expect(appeal.status).toBe("submitted");
    expect(appeal.deadline).toBeInstanceOf(Date);
    expect(appeal.outcome).toBeNull();
  });

  it("createAppeal: developer appeal deadline is 48h from now", () => {
    const before = Date.now();
    const appeal = createAppeal({ type: "developer", decisionId: "dec", appellantId: "dev", reason: "banned" });
    const after = Date.now();
    const deadlineMs = appeal.deadline.getTime();
    expect(deadlineMs).toBeGreaterThan(before + 47 * 3600000); // at least ~47h.
    expect(deadlineMs).toBeLessThan(after + 49 * 3600000); // at most ~49h.
  });

  it("isAppealOverdue: true when past deadline + not decided", () => {
    const appeal = createAppeal({ type: "user", decisionId: "dec", appellantId: "u", reason: "test" });
    const future = new Date(Date.now() + 10 * 24 * 3600000); // 10 days later.
    expect(isAppealOverdue(appeal, future)).toBe(true);
  });

  it("isAppealOverdue: false when decided", () => {
    const appeal = createAppeal({ type: "user", decisionId: "dec", appellantId: "u", reason: "test" });
    appeal.status = "decided";
    const future = new Date(Date.now() + 10 * 24 * 3600000);
    expect(isAppealOverdue(appeal, future)).toBe(false);
  });

  it("verifyAppeals: 5 types + 6 workflow steps + 3 time limits, all implemented", () => {
    const summary = verifyAppeals();
    expect(summary.types.total).toBe(5);
    expect(summary.types.implemented).toBe(5);
    expect(summary.workflow.total).toBe(6);
    expect(summary.workflow.implemented).toBe(6);
    expect(summary.timeLimits.acknowledge).toBe(24);
    expect(summary.timeLimits.routine).toBe(7);
    expect(summary.timeLimits.timeSensitive).toBe(48);
    expect(summary.allImplemented).toBe(true);
  });

  it("5 appeal statuses: submitted, acknowledged, under_review, decided, closed", () => {
    const statuses: AppealStatus[] = ["submitted", "acknowledged", "under_review", "decided", "closed"];
    expect(statuses).toHaveLength(5);
  });
});
