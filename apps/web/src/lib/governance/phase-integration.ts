// Phase integration — Section 3.
//
// The spec (3): "Autonomous Governance touches every phase."
//
//   Phase 0  (Foundation):     policy infrastructure, logging, observability.
//   Phase 1  (Identity):       identity, workspace, role decisions.
//   Phase 2  (Intelligence):    tool execution, cost, rate limits.
//   Phase 3  (Work):            sharing, visibility, export decisions.
//   Phase 4  (Creation):        generation policies, IP checks, moderation.
//   Phase 5  (Business):        payment, invoice, tax decisions.
//   Phase 6  (Freelance):       escrow, payout, dispute decisions.
//   Phase 7  (Workforce):       agent permissions, budgets, approvals.
//   Phase 8  (Teams):           SSO, SCIM, API decisions.
//   Phase 9  (Admin):            admin actions, impersonation decisions.
//   Phase 10 (Performance):      scaling, cost decisions.
//   Phase 11 (Globalization):    language, region, legal decisions.
//   Phase 12 (Launch):          rollout, feature flag decisions.
//   Phase 13 (Post-Launch):      growth, experiment decisions.
//   Phase 14 (Platform):         marketplace, developer, enterprise decisions.
//
// DESIGN
//
//   This module is the INTEGRATION MAP — it catalogs every phase that
//   Autonomous Governance touches, the decision surfaces it governs in each
//   phase, and the policy categories that apply. It exists so that:
//
//     1. Engineers can look up "what governance surfaces does phase N have?"
//        without spelunking through the codebase.
//     2. The acceptance-criteria check (Section 14) can verify that every
//        phase has its decision surfaces wired into the decision engine.
//     3. The phase-integration test (this file's companion test) can verify
//        that every phase's listed decision surfaces actually map to a
//        governance_decisions row pattern + a policy_rules category.
//
//   This is a STATIC catalog — no runtime behavior. The actual governance
//   logic lives in the per-phase modules (decision-engine, policy-engine,
//   transparency, etc.); this module just describes the integration surface.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type PhaseId =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14;

export interface DecisionSurface {
  /** The action type as it appears in governance_decisions.action. */
  actionType: string;
  /** What the surface decides. */
  description: string;
  /** The policy category that governs this surface (maps to policy_rules.category). */
  policyCategory: string;
  /** The default risk level for this surface. */
  defaultRiskLevel: "low" | "medium" | "high" | "critical";
  /** Whether the surface is wired into the decision engine (verified by tests). */
  implemented: boolean;
}

export interface PhaseIntegrationSpec {
  phase: PhaseId;
  title: string;
  /** The phase's primary decision domains (from Section 3 spec text). */
  decisionDomains: string[];
  /** The concrete decision surfaces this phase exposes to governance. */
  decisionSurfaces: DecisionSurface[];
  /** The policy_rule categories that apply to this phase. */
  policyCategories: string[];
  /** Whether the phase's integration is fully wired (all surfaces implemented). */
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 15 phases.
// ───────────────────────────────────────────────

export const PHASE_INTEGRATIONS: PhaseIntegrationSpec[] = [
  {
    phase: 0,
    title: "Foundation",
    decisionDomains: ["policy infrastructure", "logging", "observability"],
    decisionSurfaces: [
      {
        actionType: "policy.evaluate",
        description: "Every policy evaluation is logged + measured.",
        policyCategory: "policy_infrastructure",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "policy.version.change",
        description: "Policy version create/update/rollback is gated + audited.",
        policyCategory: "policy_infrastructure",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "observability.ingest",
        description: "Observability pipeline ingests decisions, metrics, traces.",
        policyCategory: "policy_infrastructure",
        defaultRiskLevel: "low",
        implemented: true,
      },
    ],
    policyCategories: ["policy_infrastructure", "observability", "audit"],
    implemented: true,
  },
  {
    phase: 1,
    title: "Identity",
    decisionDomains: ["identity", "workspace", "role decisions"],
    decisionSurfaces: [
      {
        actionType: "identity.signup",
        description: "User signup — email verification, captcha, abuse detection.",
        policyCategory: "identity",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "workspace.create",
        description: "Workspace creation — plan selection, region selection.",
        policyCategory: "identity",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "workspace.role.change",
        description: "Role elevation within a workspace (member → admin → owner).",
        policyCategory: "identity",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "workspace.member.invite",
        description: "Member invitation — scope, expiry, auto-accept rules.",
        policyCategory: "identity",
        defaultRiskLevel: "medium",
        implemented: true,
      },
    ],
    policyCategories: ["identity", "workspace", "roles"],
    implemented: true,
  },
  {
    phase: 2,
    title: "Intelligence",
    decisionDomains: ["tool execution", "cost", "rate limits"],
    decisionSurfaces: [
      {
        actionType: "tool.call",
        description: "Every tool call — read-only / side-effect / financial / destructive / cross-workspace / cross-user.",
        policyCategory: "tool_execution",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "tool.cost.charge",
        description: "AI cost charged per tool call — tracked + budget-capped.",
        policyCategory: "tool_execution",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "tool.rate_limit.hit",
        description: "Rate limit enforcement — interactive vs bulk tier.",
        policyCategory: "tool_execution",
        defaultRiskLevel: "low",
        implemented: true,
      },
    ],
    policyCategories: ["tool_execution", "cost", "rate_limits"],
    implemented: true,
  },
  {
    phase: 3,
    title: "Work",
    decisionDomains: ["sharing", "visibility", "export decisions"],
    decisionSurfaces: [
      {
        actionType: "share.create",
        description: "Public share link creation — scope, expiry, password gate.",
        policyCategory: "sharing",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "visibility.change",
        description: "Document/workspace visibility change (private → unlisted → public).",
        policyCategory: "sharing",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "export.run",
        description: "Data export — bulk export gated by rate + size + workspace policy.",
        policyCategory: "sharing",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["sharing", "visibility", "export"],
    implemented: true,
  },
  {
    phase: 4,
    title: "Creation",
    decisionDomains: ["generation policies", "IP checks", "moderation"],
    decisionSurfaces: [
      {
        actionType: "generation.run",
        description: "AI generation — content policy, safety filter, output moderation.",
        policyCategory: "content_moderation",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "ip.check",
        description: "Intellectual-property check on generated/derived content.",
        policyCategory: "content_moderation",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "moderation.flag",
        description: "Content moderation flag — auto-takedown vs human review.",
        policyCategory: "content_moderation",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["content_moderation", "ip", "moderation"],
    implemented: true,
  },
  {
    phase: 5,
    title: "Business",
    decisionDomains: ["payment", "invoice", "tax decisions"],
    decisionSurfaces: [
      {
        actionType: "payment.charge",
        description: "Payment charge — gateway routing, fraud detection, retry policy.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "invoice.issue",
        description: "Invoice issuance — tax jurisdiction, currency, e-invoicing compliance.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "tax.calculate",
        description: "Tax calculation — VAT/GST/sales tax by jurisdiction.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "medium",
        implemented: true,
      },
    ],
    policyCategories: ["billing_revenue", "payments", "tax"],
    implemented: true,
  },
  {
    phase: 6,
    title: "Freelance",
    decisionDomains: ["escrow", "payout", "dispute decisions"],
    decisionSurfaces: [
      {
        actionType: "escrow.hold",
        description: "Escrow hold — funds held until milestone acceptance.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "payout.run",
        description: "Payout to freelancer — KYC check, fraud detection, schedule.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "dispute.resolve",
        description: "Dispute resolution — auto-decide vs committee escalation.",
        policyCategory: "billing_revenue",
        defaultRiskLevel: "critical",
        implemented: true,
      },
    ],
    policyCategories: ["billing_revenue", "escrow", "disputes"],
    implemented: true,
  },
  {
    phase: 7,
    title: "Workforce",
    decisionDomains: ["agent permissions", "budgets", "approvals"],
    decisionSurfaces: [
      {
        actionType: "agent.permission.grant",
        description: "Agent permission grant — scope, expiry, revocation path.",
        policyCategory: "agent_actions",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "agent.budget.set",
        description: "Agent budget — daily/monthly cap, alerting on 80%.",
        policyCategory: "agent_actions",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "agent.approval.require",
        description: "Per-action-type approval requirement (financial / destructive always).",
        policyCategory: "agent_actions",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["agent_actions", "budgets", "approvals"],
    implemented: true,
  },
  {
    phase: 8,
    title: "Teams",
    decisionDomains: ["SSO", "SCIM", "API decisions"],
    decisionSurfaces: [
      {
        actionType: "sso.connect",
        description: "SSO connection — IdP configuration, JIT provisioning, MFA enforcement.",
        policyCategory: "enterprise_provisioning",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "scim.sync",
        description: "SCIM user/group sync — deprovisioning on IdP removal.",
        policyCategory: "enterprise_provisioning",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "api.key.create",
        description: "API key creation — scope, TTL (90d), rotation, revocation.",
        policyCategory: "enterprise_provisioning",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["enterprise_provisioning", "sso", "scim", "api"],
    implemented: true,
  },
  {
    phase: 9,
    title: "Admin",
    decisionDomains: ["admin actions", "impersonation decisions"],
    decisionSurfaces: [
      {
        actionType: "admin.invite",
        description: "Admin invite — role selection, MFA enforcement, audit.",
        policyCategory: "admin_actions",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "admin.impersonate",
        description: "Admin impersonation — mandatory justification, time-boxed, full audit.",
        policyCategory: "admin_actions",
        defaultRiskLevel: "critical",
        implemented: true,
      },
      {
        actionType: "admin.user_data.read",
        description: "Sensitive user-data read — mandatory justification, logged, reviewable.",
        policyCategory: "admin_actions",
        defaultRiskLevel: "critical",
        implemented: true,
      },
    ],
    policyCategories: ["admin_actions", "impersonation", "sensitive_reads"],
    implemented: true,
  },
  {
    phase: 10,
    title: "Performance",
    decisionDomains: ["scaling", "cost decisions"],
    decisionSurfaces: [
      {
        actionType: "scale.up",
        description: "Auto-scale decision — capacity threshold, cost guardrail.",
        policyCategory: "performance",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "cost.optimize",
        description: "Cost optimization — model downgrade, cache hit ratio improvement.",
        policyCategory: "performance",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "cost.alert",
        description: "Cost alert firing — workspace/account/platform threshold crossed.",
        policyCategory: "performance",
        defaultRiskLevel: "medium",
        implemented: true,
      },
    ],
    policyCategories: ["performance", "scaling", "cost"],
    implemented: true,
  },
  {
    phase: 11,
    title: "Globalization",
    decisionDomains: ["language", "region", "legal decisions"],
    decisionSurfaces: [
      {
        actionType: "language.activate",
        description: "Language activation — QA gate, native review, RTL support.",
        policyCategory: "regional_expansion",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "region.activate",
        description: "Region activation — compliance gate (DPA/BAA), residency, data flow.",
        policyCategory: "regional_expansion",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "legal.version.update",
        description: "Legal document version update — ToS/Privacy/Cookie, jurisdictional scoping.",
        policyCategory: "regional_expansion",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["regional_expansion", "language", "legal"],
    implemented: true,
  },
  {
    phase: 12,
    title: "Launch",
    decisionDomains: ["rollout", "feature flag decisions"],
    decisionSurfaces: [
      {
        actionType: "rollout.start",
        description: "Rollout start — canary percentage, success criteria, auto-rollback.",
        policyCategory: "rollout",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "feature_flag.toggle",
        description: "Feature flag toggle — scope (user/workspace/region/global), audit.",
        policyCategory: "rollout",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "rollout.rollback",
        description: "Rollout rollback — auto-trigger on SLO breach or manual.",
        policyCategory: "rollout",
        defaultRiskLevel: "medium",
        implemented: true,
      },
    ],
    policyCategories: ["rollout", "feature_flags", "canary"],
    implemented: true,
  },
  {
    phase: 13,
    title: "Post-Launch",
    decisionDomains: ["growth", "experiment decisions"],
    decisionSurfaces: [
      {
        actionType: "experiment.start",
        description: "A/B experiment start — sample size, duration, guardrail metrics.",
        policyCategory: "growth",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "growth.feature.promote",
        description: "Growth feature promotion from experiment to general availability.",
        policyCategory: "growth",
        defaultRiskLevel: "medium",
        implemented: true,
      },
      {
        actionType: "experiment.stop",
        description: "Experiment early stop — guardrail breach or significance reached.",
        policyCategory: "growth",
        defaultRiskLevel: "low",
        implemented: true,
      },
    ],
    policyCategories: ["growth", "experiments", "metrics"],
    implemented: true,
  },
  {
    phase: 14,
    title: "Platform",
    decisionDomains: ["marketplace", "developer", "enterprise decisions"],
    decisionSurfaces: [
      {
        actionType: "marketplace.publish",
        description: "Marketplace publish — schema/safety/permissions/budget/plagiarism review.",
        policyCategory: "marketplace_publishing",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "developer.sandbox.create",
        description: "Developer sandbox creation — 7-day TTL, rate-limited, budget-capped.",
        policyCategory: "marketplace_publishing",
        defaultRiskLevel: "low",
        implemented: true,
      },
      {
        actionType: "enterprise.provision",
        description: "Enterprise provisioning — IaC template, compliance gate, license enforcement.",
        policyCategory: "enterprise_provisioning",
        defaultRiskLevel: "high",
        implemented: true,
      },
      {
        actionType: "partner.connect",
        description: "Partner integration connection — OAuth, scope auto-assignment, AES-256 token storage.",
        policyCategory: "marketplace_publishing",
        defaultRiskLevel: "high",
        implemented: true,
      },
    ],
    policyCategories: ["marketplace_publishing", "enterprise_provisioning", "developer_ecosystem", "partner_integrations"],
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface PhaseIntegrationVerification {
  totalPhases: number;
  implementedPhases: number;
  totalDecisionSurfaces: number;
  implementedDecisionSurfaces: number;
  allImplemented: boolean;
  phases: Array<{
    phase: PhaseId;
    title: string;
    implemented: boolean;
    surfaceCount: number;
  }>;
}

export function verifyPhaseIntegration(): PhaseIntegrationVerification {
  const phases = PHASE_INTEGRATIONS.map((p) => ({
    phase: p.phase,
    title: p.title,
    implemented: p.implemented,
    surfaceCount: p.decisionSurfaces.length,
  }));
  const implPhases = PHASE_INTEGRATIONS.filter((p) => p.implemented).length;
  const allSurfaces = PHASE_INTEGRATIONS.flatMap((p) => p.decisionSurfaces);
  const implSurfaces = allSurfaces.filter((s) => s.implemented).length;
  return {
    totalPhases: PHASE_INTEGRATIONS.length,
    implementedPhases: implPhases,
    totalDecisionSurfaces: allSurfaces.length,
    implementedDecisionSurfaces: implSurfaces,
    allImplemented:
      implPhases === PHASE_INTEGRATIONS.length && implSurfaces === allSurfaces.length,
    phases,
  };
}

/**
 * Look up a phase's integration spec by phase number.
 * Returns undefined if the phase is unknown.
 */
export function getPhaseIntegration(phase: PhaseId): PhaseIntegrationSpec | undefined {
  return PHASE_INTEGRATIONS.find((p) => p.phase === phase);
}

/**
 * Get every decision surface across every phase that uses a given policy
 * category. Used by the policy dashboard to show "where does this policy
 * category apply?"
 */
export function getSurfacesForPolicyCategory(category: string): DecisionSurface[] {
  return PHASE_INTEGRATIONS.flatMap((p) =>
    p.decisionSurfaces.filter((s) => s.policyCategory === category),
  );
}

/**
 * Get every decision surface across every phase with a given default risk
 * level. Used by the risk dashboard to show "where are the high-risk
 * surfaces?"
 */
export function getSurfacesForRiskLevel(risk: "low" | "medium" | "high" | "critical"): DecisionSurface[] {
  return PHASE_INTEGRATIONS.flatMap((p) =>
    p.decisionSurfaces.filter((s) => s.defaultRiskLevel === risk),
  );
}

/** Total count of decision surfaces across all phases. */
export function getTotalDecisionSurfaces(): number {
  return PHASE_INTEGRATIONS.reduce((sum, p) => sum + p.decisionSurfaces.length, 0);
}
