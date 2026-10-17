// Governance committee — the standing human committee for non-automatable decisions.
// Section 8: "A small, standing human committee makes the decisions that are not safely automated."

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type CommitteeRole =
  | "chairman"           // Founder or CEO.
  | "head_of_engineering" // Technical decisions.
  | "head_of_legal"      // Legal, compliance, ethics.
  | "head_of_security"    // Security incidents, access decisions.
  | "head_of_trust_safety" // Moderation, abuse, appeals.
  | "head_of_customer_success"; // Customer-impacting decisions.

export type CommitteeDecisionType =
  | "appeal"              // User appeals an algorithmic decision.
  | "exception"           // Exception to a policy.
  | "policy_override"     // Override a policy rule.
  | "executive_override"  // Bypass irreversible action safeguards.
  | "incident_escalation" // Escalated incident requiring human decision.
  | "new_jurisdiction"    // New jurisdiction launch approval.
  | "vertical_launch"     // New vertical launch approval.
  | "enterprise_custom"   // Custom enterprise terms approval.
  | "reputation_override" // Override reputation adjustment.
  | "kill_switch_review"; // Review of an activated kill switch.

export type CommitteeOutcome = "approved" | "rejected" | "deferred" | "tabled";

export interface CommitteeMember {
  role: CommitteeRole;
  title: string;
  name: string | null; // null = vacant.
  present: boolean;
}

export interface CommitteeDecision {
  id: string;
  type: CommitteeDecisionType;
  subject: string;
  description: string;
  outcome: CommitteeOutcome;
  reasoning: string;
  membersPresent: CommitteeMember[];
  voteCount: { approve: number; reject: number; defer: number; table: number };
  dissent: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

// ───────────────────────────────────────────────
// Committee composition (Section 8.1).
// ───────────────────────────────────────────────

export const COMMITTEE_COMPOSITION: CommitteeMember[] = [
  { role: "chairman", title: "Founder or CEO", name: null, present: true },
  { role: "head_of_engineering", title: "Head of Engineering", name: null, present: true },
  { role: "head_of_legal", title: "Head of Legal or external counsel", name: null, present: true },
  { role: "head_of_security", title: "Head of Security", name: null, present: true },
  { role: "head_of_trust_safety", title: "Head of Trust & Safety", name: null, present: true },
  { role: "head_of_customer_success", title: "Head of Customer Success", name: null, present: true },
];

// ───────────────────────────────────────────────
// Decision routing — which decisions go to the committee.
// ───────────────────────────────────────────────

export interface CommitteeRoutingRule {
  type: CommitteeDecisionType;
  description: string;
  requiredQuorum: number; // minimum members present.
  requiredRole: CommitteeRole; // the role that must be present.
  coolingOffHours: number; // delay before decision can be finalized.
}

export const ROUTING_RULES: CommitteeRoutingRule[] = [
  { type: "appeal", description: "User appeals an algorithmic decision", requiredQuorum: 3, requiredRole: "head_of_trust_safety", coolingOffHours: 0 },
  { type: "exception", description: "Exception to a policy", requiredQuorum: 3, requiredRole: "head_of_engineering", coolingOffHours: 0 },
  { type: "policy_override", description: "Override a policy rule", requiredQuorum: 4, requiredRole: "chairman", coolingOffHours: 24 },
  { type: "executive_override", description: "Bypass irreversible action safeguards", requiredQuorum: 5, requiredRole: "chairman", coolingOffHours: 48 },
  { type: "incident_escalation", description: "Escalated incident requiring human decision", requiredQuorum: 3, requiredRole: "head_of_security", coolingOffHours: 0 },
  { type: "new_jurisdiction", description: "New jurisdiction launch approval", requiredQuorum: 4, requiredRole: "head_of_legal", coolingOffHours: 24 },
  { type: "vertical_launch", description: "New vertical launch approval", requiredQuorum: 3, requiredRole: "head_of_engineering", coolingOffHours: 0 },
  { type: "enterprise_custom", description: "Custom enterprise terms approval", requiredQuorum: 4, requiredRole: "head_of_legal", coolingOffHours: 0 },
  { type: "reputation_override", description: "Override reputation adjustment", requiredQuorum: 3, requiredRole: "head_of_trust_safety", coolingOffHours: 0 },
  { type: "kill_switch_review", description: "Review of an activated kill switch", requiredQuorum: 3, requiredRole: "head_of_security", coolingOffHours: 0 },
];

// ───────────────────────────────────────────────
// Check if a decision can be routed to the committee.
// ───────────────────────────────────────────────

export function checkCommitteeRouting(input: {
  type: CommitteeDecisionType;
  membersPresent: CommitteeMember[];
}): { canProceed: boolean; reason: string; routingRule: CommitteeRoutingRule | null } {
  const rule = ROUTING_RULES.find((r) => r.type === input.type);
  if (!rule) {
    return { canProceed: false, reason: `No routing rule for decision type: ${input.type}`, routingRule: null };
  }

  const presentCount = input.membersPresent.filter((m) => m.present).length;
  if (presentCount < rule.requiredQuorum) {
    return { canProceed: false, reason: `Quorum not met: ${presentCount}/${rule.requiredQuorum} members present. Required role: ${rule.requiredRole}.`, routingRule: rule };
  }

  const requiredRolePresent = input.membersPresent.some((m) => m.role === rule.requiredRole && m.present);
  if (!requiredRolePresent) {
    return { canProceed: false, reason: `Required role not present: ${rule.requiredRole}.`, routingRule: rule };
  }

  return { canProceed: true, reason: `Quorum met (${presentCount} members). Required role ${rule.requiredRole} present. Cooling-off: ${rule.coolingOffHours}h.`, routingRule: rule };
}

// ───────────────────────────────────────────────
// Create a committee decision record.
// ───────────────────────────────────────────────

export function createCommitteeDecision(input: {
  type: CommitteeDecisionType;
  subject: string;
  description: string;
  outcome: CommitteeOutcome;
  reasoning: string;
  membersPresent: CommitteeMember[];
  votes: { approve: number; reject: number; defer: number; table: number };
  dissent?: string;
}): CommitteeDecision {
  return {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    subject: input.subject,
    description: input.description,
    outcome: input.outcome,
    reasoning: input.reasoning,
    membersPresent: input.membersPresent,
    voteCount: input.votes,
    ...(input.dissent ? { dissent: input.dissent } : { dissent: null }),
    createdAt: new Date(),
    resolvedAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export function verifyCommittee(): {
  membersCount: number;
  decisionTypes: number;
  routingRules: number;
  allRoutingRulesHaveRequiredRole: boolean;
} {
  return {
    membersCount: COMMITTEE_COMPOSITION.length,
    decisionTypes: ROUTING_RULES.length,
    routingRules: ROUTING_RULES.length,
    allRoutingRulesHaveRequiredRole: ROUTING_RULES.every((r) => COMMITTEE_COMPOSITION.some((m) => m.role === r.requiredRole)),
  };
}
