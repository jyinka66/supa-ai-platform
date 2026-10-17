// Governance integration — Section 16.
//
// The spec (16): "Every regional decision flows through Autonomous Governance."
//
//   16.1 Policy as code defines regional rules.
//   16.2 Risk levels determine approval flows.
//   16.3 Reputation shapes review depth.
//   16.4 Transparency gives users and auditors visibility.
//   16.5 Governance committee handles exceptions.
//   16.6 Kill switches provide immediate halt.
//   16.7 Circuit breakers provide automated protection.
//   16.8 Rollback provides recovery.
//
// DESIGN
//
//   This module is the INTEGRATION MAP — it documents how every regional
//   decision flows through the Autonomous Governance system. It's a static
//   catalog that maps each governance integration point to:
//     - The regional decision it governs.
//     - The governance module that enforces it.
//     - The regional expansion stage where the integration fires.
//
//   This is the closing integration section of the playbook — it ties the
//   regional expansion lifecycle to the governance substrate.

// ───────────────────────────────────────────────
// 16 Governance integration points — 8 points.
// ───────────────────────────────────────────────

export type GovernanceIntegrationId =
  | "policy_as_code"        // 16.1
  | "risk_levels"           // 16.2
  | "reputation"            // 16.3
  | "transparency"          // 16.4
  | "governance_committee"  // 16.5
  | "kill_switches"         // 16.6
  | "circuit_breakers"      // 16.7
  | "rollback";             // 16.8

export interface GovernanceIntegrationSpec {
  id: GovernanceIntegrationId;
  number: string;
  title: string;
  description: string;
  /** The regional decisions this integration governs. */
  governsDecisions: string[];
  /** The governance module that enforces this integration. */
  enforcedBy: string;
  /** The regional expansion stage(s) where this integration fires. */
  firesAtStages: string[];
  implemented: boolean;
}

export const GOVERNANCE_INTEGRATIONS: GovernanceIntegrationSpec[] = [
  {
    id: "policy_as_code",
    number: "16.1",
    title: "Policy as Code Defines Regional Rules",
    description: "Every regional rule (threshold, compliance gate, pricing factor, support hours) is stored as versioned policy — not tribal knowledge.",
    governsDecisions: [
      "Detection thresholds (500 visitors, 100 signups, etc.)",
      "Compliance gates (DPA required for EU, BAA for US healthcare)",
      "Pricing factors (PPP multiplier per region)",
      "Support hours minimums (≥8h/day in-region)",
      "Cohort size ranges (100-1000 depending on market)",
    ],
    enforcedBy: "governance/policy-as-code.ts + governance/policy-engine.ts (evaluatePolicy + evaluatePolicyFromDb).",
    firesAtStages: ["detection", "evaluation", "prioritization", "preparation", "verification"],
    implemented: true,
  },
  {
    id: "risk_levels",
    number: "16.2",
    title: "Risk Levels Determine Approval Flows",
    description: "Every regional decision is classified by risk level (low/medium/high/critical/irreversible) → approval flow scales accordingly.",
    governsDecisions: [
      "Region activation (high risk → human approval)",
      "Region retirement (critical risk → governance committee approval)",
      "Material pricing change (high risk → human approval)",
      "Payment method addition (medium risk → policy check)",
      "Legal document update (high risk → legal counsel sign-off)",
    ],
    enforcedBy: "governance/risk-levels.ts (5 levels) + governance/decision-engine.ts (assessRisk + routeDecision).",
    firesAtStages: ["prioritization", "preparation", "verification", "soft_launch", "public_launch", "optimization"],
    implemented: true,
  },
  {
    id: "reputation",
    number: "16.3",
    title: "Reputation Shapes Review Depth",
    description: "Trusted regional partners (high reputation) get lighter review; new/distrusted actors get heavier review.",
    governsDecisions: [
      "Partner integration review depth (trusted partner → lighter review)",
      "Regional content creator review (trusted creator → faster publishing)",
      "Developer sandbox access (trusted developer → higher limits)",
    ],
    enforcedBy: "governance/reputation-trust.ts (7 dimensions, 4 tiers, weighted scoring).",
    firesAtStages: ["preparation (partner/content/developer workstreams)", "optimization (partner/content changes)"],
    implemented: true,
  },
  {
    id: "transparency",
    number: "16.4",
    title: "Transparency Gives Users and Auditors Visibility",
    description: "Every regional decision is logged + visible to users (what was decided on their behalf) + auditors (without PII) + regulators (dedicated channels).",
    governsDecisions: [
      "Region activation (logged + user-visible)",
      "Region pause/rollback (logged + user-visible + auditor-visible)",
      "Region retirement (logged + user-visible + communicated)",
      "Pricing changes (logged + user-visible in transparency log)",
    ],
    enforcedBy: "governance/transparency-audiences.ts (3 audiences) + governance/transparency.ts (logTransparency) + governance/governance-decision-log.ts.",
    firesAtStages: ["all stages — every regional decision is logged"],
    implemented: true,
  },
  {
    id: "governance_committee",
    number: "16.5",
    title: "Governance Committee Handles Exceptions",
    description: "The standing governance committee (6 members) handles exceptions: go/no-go for public launch, region retirement, material pricing changes, high-risk payment changes.",
    governsDecisions: [
      "Go / No-Go for public launch (committee approves)",
      "Region retirement (committee approves)",
      "Material pricing changes (committee approves)",
      "High-risk payment changes (committee approves)",
      "Strategic shift retirement trigger (committee decides)",
    ],
    enforcedBy: "governance/governance-committee.ts (6 members, 10 decision types, routing rules).",
    firesAtStages: ["verification (go/no-go)", "public_launch (committee approval)", "optimization (material changes)", "retirement"],
    implemented: true,
  },
  {
    id: "kill_switches",
    number: "16.6",
    title: "Kill Switches Provide Immediate Halt",
    description: "Region-scoped kill switch halts all autonomous operations in the region within 60s without affecting other regions.",
    governsDecisions: [
      "Region pause (kill switch active → no new autonomous operations)",
      "Region rollback (kill switch + rollback to previous stage)",
      "Emergency halt (global kill switch halts ALL regions)",
    ],
    enforcedBy: "governance/kill-switches.ts (7 named types including region-scoped, 60s propagation SLA).",
    firesAtStages: ["any stage — kill switch can be activated at any time"],
    implemented: true,
  },
  {
    id: "circuit_breakers",
    number: "16.7",
    title: "Circuit Breakers Provide Automated Protection",
    description: "5 governance circuit breakers (cost/latency/error/abuse/compliance) trip automatically on signal spikes + auto-recover when conditions normalize.",
    governsDecisions: [
      "Cost spike → cost breaker trips → throttle or pause (no human needed)",
      "Latency degradation → latency breaker trips → reduce load",
      "Error rate spike → error breaker trips → pause affected operations",
      "Abuse pattern detected → abuse breaker trips → tighten limits",
      "Compliance violation → compliance breaker trips → halt affected operations",
    ],
    enforcedBy: "governance/circuit-breakers.ts (5 breakers, CLOSED→OPEN→HALF_OPEN→CLOSED, auto-recover).",
    firesAtStages: ["soft_launch", "public_launch", "monitoring", "optimization"],
    implemented: true,
  },
  {
    id: "rollback",
    number: "16.8",
    title: "Rollback Provides Recovery",
    description: "Every regional action that can be reversed has a rollback path (5 paths) — preparation→prioritization, verification→preparation, soft_launch→verification, public_launch→soft_launch, live→paused.",
    governsDecisions: [
      "Preparation failure → rollback to prioritization (discard incomplete work)",
      "Verification failure → rollback to preparation (with issues list)",
      "Soft launch issues → rollback to verification (pause, fix, resume)",
      "Public launch issues → rollback to soft launch (limit to cohort)",
      "Live region issues → rollback to paused (disable signup, keep users)",
    ],
    enforcedBy: "governance/rollback.ts (4 paths: policy/marketplace/regional/enterprise) + rollback-retirement.ts (5 regional rollback paths).",
    firesAtStages: ["preparation", "verification", "soft_launch", "public_launch", "monitoring"],
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 16 Verification.
// ───────────────────────────────────────────────

export interface GovernanceIntegrationVerification {
  totalIntegrations: number;
  implementedIntegrations: number;
  allImplemented: boolean;
  integrations: GovernanceIntegrationSpec[];
}

export function verifyGovernanceIntegration(): GovernanceIntegrationVerification {
  return {
    totalIntegrations: GOVERNANCE_INTEGRATIONS.length,
    implementedIntegrations: GOVERNANCE_INTEGRATIONS.filter((i) => i.implemented).length,
    allImplemented: GOVERNANCE_INTEGRATIONS.every((i) => i.implemented),
    integrations: GOVERNANCE_INTEGRATIONS,
  };
}

/**
 * Check whether a specific regional decision flows through governance.
 *
 * Used by the expansion pipeline to verify that every decision it makes
 * is governance-covered (no ungoverned regional decisions).
 */
export function isDecisionGoverned(decisionType: string): boolean {
  return GOVERNANCE_INTEGRATIONS.some((i) =>
    i.governsDecisions.some((d) => d.toLowerCase().includes(decisionType.toLowerCase())),
  );
}

/** Get the integration that governs a specific decision type. */
export function getIntegrationForDecision(decisionType: string): GovernanceIntegrationSpec | undefined {
  return GOVERNANCE_INTEGRATIONS.find((i) =>
    i.governsDecisions.some((d) => d.toLowerCase().includes(decisionType.toLowerCase())),
  );
}
