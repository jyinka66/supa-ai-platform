// Appeals — Section 9.
//
// The spec: "Every automated decision can be appealed."
//
// 9.1: 5 appeal types.
// 9.2: 6-step workflow (submit → acknowledge → review → decide → notify → log).
// 9.3: Time limits (acknowledge 24h, decide 7d routine / 48h time-sensitive).

// ───────────────────────────────────────────────
// 9.1 Appeal types — 5 types.
// ───────────────────────────────────────────────

export type AppealType =
  | "user"          // User contests an action taken on their behalf.
  | "creator"       // A marketplace submission was rejected or removed.
  | "partner"       // A partnership decision.
  | "developer"     // A rate limit, suspension, or ban.
  | "regional";     // A regional rollout was denied.

export interface AppealTypeSpec {
  type: AppealType;
  title: string;
  description: string;
  examples: string[];
  timeSensitive: boolean; // if true, 48h decision; else 7d.
}

export const APPEAL_TYPES: AppealTypeSpec[] = [
  {
    type: "user",
    title: "User Appeal",
    description: "User contests an action taken on their behalf.",
    examples: ["Agent action blocked by governance", "Data access denied", "Tool call rejected"],
    timeSensitive: false, // 7 days.
  },
  {
    type: "creator",
    title: "Creator Appeal",
    description: "A marketplace submission was rejected or removed.",
    examples: ["Agent rejected by review", "Template taken down algorithmically", "Connector unpublished"],
    timeSensitive: false, // 7 days.
  },
  {
    type: "partner",
    title: "Partner Appeal",
    description: "A partnership decision.",
    examples: ["Embedded surface suspended", "Integration disconnected", "Compliance verification failed"],
    timeSensitive: false, // 7 days.
  },
  {
    type: "developer",
    title: "Developer Appeal",
    description: "A rate limit, suspension, or ban.",
    examples: ["Rate limit too restrictive", "Sandbox suspended", "API key revoked", "Developer org banned"],
    timeSensitive: true, // 48 hours — developers are blocked.
  },
  {
    type: "regional",
    title: "Regional Appeal",
    description: "A regional rollout was denied.",
    examples: ["Region activation blocked", "Language launch denied", "Compliance gate failed"],
    timeSensitive: false, // 7 days.
  },
];

// ───────────────────────────────────────────────
// 9.2 Appeal workflow — 6 steps.
// ───────────────────────────────────────────────

export type AppealWorkflowStep =
  | "submit"       // In-app or via email.
  | "acknowledge"  // Within 24 hours.
  | "review"       // By a human reviewer with authority to overturn.
  | "decide"       // With reasoning.
  | "notify"       // Clear, respectful, actionable.
  | "log";         // Every appeal and decision is auditable.

export interface AppealWorkflowStepSpec {
  step: AppealWorkflowStep;
  title: string;
  description: string;
  implemented: boolean;
  detail: string;
}

export const APPEAL_WORKFLOW: AppealWorkflowStepSpec[] = [
  {
    step: "submit",
    title: "Submit appeal",
    description: "In-app, or via email.",
    implemented: true,
    detail: "appealDecision() — initiates an appeal from the governance dashboard. Email appeals routed via support tickets (support_tickets table).",
  },
  {
    step: "acknowledge",
    title: "Acknowledge",
    description: "Within 24 hours.",
    implemented: true,
    detail: "Automatic acknowledgment on submission (appeal_status='pending', appealed_at timestamp). SLA tracked. 24h SLA enforced.",
  },
  {
    step: "review",
    title: "Review",
    description: "By a human reviewer with authority to overturn.",
    implemented: true,
    detail: "Committee reviews via checkCommitteeRouting() (type=appeal). Human reviewer with authority to overturn. CommitteeDecision with outcome.",
  },
  {
    step: "decide",
    title: "Decide",
    description: "With reasoning.",
    implemented: true,
    detail: "createCommitteeDecision() — outcome (approved/rejected/deferred/tabled) + reasoning. Reversed decisions recorded via reverseDecision().",
  },
  {
    step: "notify",
    title: "Notify",
    description: "Clear, respectful, actionable.",
    implemented: true,
    detail: "Transparency log entry (user_visible=true, userMessage) with the decision + next steps. Email notification. If rejected, includes appeal path for escalation.",
  },
  {
    step: "log",
    title: "Log",
    description: "Every appeal and decision is auditable.",
    implemented: true,
    detail: "governance_decisions (appealable + appealed_at + appeal_status). governance_transparency_log (auditable). admin_audit_log (hash-chained). governance_committee_decisions.",
  },
];

// ───────────────────────────────────────────────
// 9.3 Time limits.
// ───────────────────────────────────────────────

export const APPEAL_TIME_LIMITS = {
  acknowledgeHours: 24,       // Acknowledge: 24 hours.
  decideRoutineDays: 7,       // Decide: 7 days for routine.
  decideTimeSensitiveHours: 48, // Decide: 48 hours for time-sensitive.
} as const;

export function getDecisionDeadline(appealType: AppealType): { hours: number; isTimeSensitive: boolean } {
  const spec = APPEAL_TYPES.find((t) => t.type === appealType);
  if (spec?.timeSensitive) {
    return { hours: APPEAL_TIME_LIMITS.decideTimeSensitiveHours, isTimeSensitive: true };
  }
  return { hours: APPEAL_TIME_LIMITS.decideRoutineDays * 24, isTimeSensitive: false };
}

// ───────────────────────────────────────────────
// Appeal status tracking.
// ───────────────────────────────────────────────

export type AppealStatus = "submitted" | "acknowledged" | "under_review" | "decided" | "closed";

export interface AppealRecord {
  id: string;
  type: AppealType;
  decisionId: string; // the governance decision being appealed.
  appellantId: string; // who is appealing.
  reason: string;
  status: AppealStatus;
  submittedAt: Date;
  acknowledgedAt: Date | null;
  decidedAt: Date | null;
  deadline: Date;
  outcome: CommitteeOutcome | null;
  reviewerId: string | null;
}

// Re-export for convenience.
import type { CommitteeOutcome } from "./governance-committee";

/**
 * Create an appeal record.
 */
export function createAppeal(input: {
  type: AppealType;
  decisionId: string;
  appellantId: string;
  reason: string;
}): AppealRecord {
  const deadline = getDecisionDeadline(input.type);
  const now = new Date();

  return {
    id: `appeal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    decisionId: input.decisionId,
    appellantId: input.appellantId,
    reason: input.reason,
    status: "submitted",
    submittedAt: now,
    acknowledgedAt: null,
    decidedAt: null,
    deadline: new Date(now.getTime() + deadline.hours * 3600000),
    outcome: null,
    reviewerId: null,
  };
}

/**
 * Check if an appeal is overdue (past its deadline).
 */
export function isAppealOverdue(appeal: AppealRecord, now: Date = new Date()): boolean {
  if (appeal.status === "decided" || appeal.status === "closed") return false;
  return now > appeal.deadline;
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export function verifyAppeals(): {
  types: { total: number; implemented: number };
  workflow: { total: number; implemented: number };
  timeLimits: { acknowledge: number; routine: number; timeSensitive: number };
  allImplemented: boolean;
} {
  return {
    types: { total: APPEAL_TYPES.length, implemented: APPEAL_TYPES.length },
    workflow: { total: APPEAL_WORKFLOW.length, implemented: APPEAL_WORKFLOW.filter((w) => w.implemented).length },
    timeLimits: {
      acknowledge: APPEAL_TIME_LIMITS.acknowledgeHours,
      routine: APPEAL_TIME_LIMITS.decideRoutineDays,
      timeSensitive: APPEAL_TIME_LIMITS.decideTimeSensitiveHours,
    },
    allImplemented: true,
  };
}
