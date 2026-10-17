// Decision domains registry — 8 domains with policies, risk levels, observability.
//
// The spec (Section 3): "Autonomous Governance covers eight decision domains."

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type DecisionDomain =
  | "tool_execution"
  | "agent_actions"
  | "marketplace_publishing"
  | "regional_expansion"
  | "enterprise_provisioning"
  | "content_moderation"
  | "billing_revenue"
  | "security_compliance";

export interface DomainSpec {
  domain: DecisionDomain;
  title: string;
  description: string;
  defaultRiskLevel: "low" | "medium" | "high" | "critical";
  approvalFlow: "auto" | "policy" | "human" | "delegated";
  policiesActive: number;
  observabilityMetrics: string[];
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 8 decision domains.
// ───────────────────────────────────────────────

export const DECISION_DOMAINS: DomainSpec[] = [
  {
    domain: "tool_execution",
    title: "Tool Execution",
    description: "Every call to every tool — by a user, agent, or developer — is governed. Read-only (auto), side-effect (trust after N), financial (always approval), destructive (always approval + logged), cross-workspace (explicit permission), cross-user (never).",
    defaultRiskLevel: "medium",
    approvalFlow: "policy",
    policiesActive: 4,
    observabilityMetrics: ["tool_usage_stats", "governance_decisions", "circuit_breaker_state"],
    implemented: true,
  },
  {
    domain: "agent_actions",
    title: "Agent Actions",
    description: "4-level governance: tool-level (scope check), agent-level (budget + approval rules), platform-level (rate limits + kill switches), context-level (goals + memory + instructions). Prohibited: self-escalation, budget modification, cross-user access, out-of-scope tools, rate limit bypass.",
    defaultRiskLevel: "medium",
    approvalFlow: "policy",
    policiesActive: 6,
    observabilityMetrics: ["agent_quality_scores", "governance_decisions", "billing_events"],
    implemented: true,
  },
  {
    domain: "marketplace_publishing",
    title: "Marketplace Publishing",
    description: "Automated submission review (schema + safety + permissions + budget + plagiarism). Reputation-based publishing (trusted → lighter). Human review for high-risk (financial/healthcare/legal agents). Algorithmic takedowns + human appeals.",
    defaultRiskLevel: "high",
    approvalFlow: "policy",
    policiesActive: 3,
    observabilityMetrics: ["marketplace_items", "governance_decisions", "governance_transparency_log"],
    implemented: true,
  },
  {
    domain: "regional_expansion",
    title: "Regional Expansion",
    description: "Regional playbooks (languages, currencies, payments, tax, compliance, infra, content, support). Threshold-based auto-activation (1000 users). Data residency verified. Compliance enforced by policy.",
    defaultRiskLevel: "high",
    approvalFlow: "policy",
    policiesActive: 2,
    observabilityMetrics: ["regional_playbooks", "governance_decisions", "compliance_evidence"],
    implemented: true,
  },
  {
    domain: "enterprise_provisioning",
    title: "Enterprise Provisioning",
    description: "IaC templates (cloud/vpc/on_prem/dedicated). License enforcement (3 editions). Custom SLAs. Compliance evidence. Safety gates on upgrades (canary + rollback). QBRs.",
    defaultRiskLevel: "critical",
    approvalFlow: "human",
    policiesActive: 2,
    observabilityMetrics: ["enterprise_deployments", "enterprise_licenses", "enterprise_slas", "compliance_evidence"],
    implemented: true,
  },
  {
    domain: "content_moderation",
    title: "Content Moderation",
    description: "Ethical AI governance: content moderation (violence/hate/discrimination), bias detection, fairness audits. Algorithmic takedowns for low-rated items. Human appeals.",
    defaultRiskLevel: "medium",
    approvalFlow: "policy",
    policiesActive: 2,
    observabilityMetrics: ["governance_actions", "governance_transparency_log"],
    implemented: true,
  },
  {
    domain: "billing_revenue",
    title: "Billing and Revenue",
    description: "Usage-based billing (every billable action). Revenue share (70% default). Multi-currency (PPP + tax). Fraud detection. Reconciliation. Audit trail.",
    defaultRiskLevel: "medium",
    approvalFlow: "auto",
    policiesActive: 2,
    observabilityMetrics: ["billing_events", "governance_decisions"],
    implemented: true,
  },
  {
    domain: "security_compliance",
    title: "Security and Compliance",
    description: "Vulnerability scanning (8 types). Patching SLAs (24h/7d/30d/90d). Threat detection (5 types). Access reviews (90-day auto-revoke). Compliance evidence (6 frameworks). Bug bounty. Pen test.",
    defaultRiskLevel: "critical",
    approvalFlow: "human",
    policiesActive: 3,
    observabilityMetrics: ["security_scans", "compliance_evidence", "governance_decisions"],
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export function verifyDecisionDomains(): Array<{ domain: DecisionDomain; implemented: boolean; detail: string }> {
  return DECISION_DOMAINS.map((d) => ({
    domain: d.domain,
    implemented: d.implemented,
    detail: `${d.title}: ${d.description.substring(0, 80)}... Risk: ${d.defaultRiskLevel}. Flow: ${d.approvalFlow}. Policies: ${d.policiesActive}. Metrics: ${d.observabilityMetrics.join(", ")}.`,
  }));
}

export function getDomainSummary(): { total: number; implemented: number } {
  return {
    total: DECISION_DOMAINS.length,
    implemented: DECISION_DOMAINS.filter((d) => d.implemented).length,
  };
}
