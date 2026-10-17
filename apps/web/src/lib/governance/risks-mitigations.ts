// Risks & mitigations — Section 15.
//
// The spec (15): 15 risks + their mitigations. Each risk has a category,
// a likelihood, an impact, and a set of mitigations that we've implemented.
//
// DESIGN
//
//   This module is the RISK REGISTER — it catalogs every risk the spec
//   calls out + the mitigations we've put in place. The risk register is:
//
//     1. Displayed in the governance dashboard's "Risks" tab.
//     2. Reviewed quarterly by the governance committee (Section 8 cadence).
//     3. Updated when new risks are identified (e.g. post-incident).
//     4. Used by the acceptance-criteria check (Section 14) to verify that
//        every risk has at least one mitigation implemented.
//
//   Each risk has:
//     - id: R01..R15
//     - risk: the risk text
//     - category: operational / policy / abuse / ethics / governance /
//                 compliance / security / transparency / centralization /
//                 emergency / legal / trust
//     - likelihood: low / medium / high
//     - impact: low / medium / high / critical
//     - mitigations: array of mitigation descriptions (each pointing to a
//                   concrete module/function that implements it)
//     - residualRisk: the risk that remains after mitigations are in place
//     - implemented: whether all mitigations are wired up

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RiskCategory =
  | "operational"        // R01, R14
  | "policy"            // R02
  | "fatigue"           // R03
  | "abuse"             // R04
  | "ethics"            // R05
  | "governance"       // R06
  | "compliance"       // R07
  | "security"         // R08
  | "transparency"     // R09, R10
  | "centralization"   // R11, R12
  | "emergency"        // R13
  | "legal"            // R14
  | "trust";           // R15

export type RiskLikelihood = "low" | "medium" | "high";
export type RiskImpact = "low" | "medium" | "high" | "critical";

export interface Mitigation {
  /** Short name for the mitigation. */
  name: string;
  /** What we do to mitigate the risk. */
  description: string;
  /** The module/function that implements this mitigation. */
  enforcedBy: string;
  /** Whether this mitigation is wired up. */
  implemented: boolean;
}

export interface RiskSpec {
  id: string;
  risk: string;
  category: RiskCategory;
  likelihood: RiskLikelihood;
  impact: RiskImpact;
  mitigations: Mitigation[];
  /** The risk that remains after mitigations are in place. */
  residualRisk: "low" | "medium" | "high";
  /** Whether ALL mitigations are implemented. */
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 15 risks + mitigations.
// ───────────────────────────────────────────────

export const RISKS_AND_MITIGATIONS: RiskSpec[] = [
  {
    id: "R01",
    risk: "Autonomous systems making wrong decisions",
    category: "operational",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Risk classification",
        description: "Every action classified by risk level (low → irreversible). Higher risk = more scrutiny.",
        enforcedBy: "risk-levels.ts (assessRisk + 5 levels)",
        implemented: true,
      },
      {
        name: "Human approval for high risk",
        description: "High-risk + critical + irreversible actions require human approval; two-person rule for irreversible.",
        enforcedBy: "decision-engine.ts (routeDecision) + risk-levels.ts (approval flows)",
        implemented: true,
      },
      {
        name: "Circuit breakers",
        description: "5 breakers (cost/latency/error/abuse/compliance) trip on signal spikes + auto-recover.",
        enforcedBy: "circuit-breakers.ts",
        implemented: true,
      },
      {
        name: "Kill switches",
        description: "7 named kill switch types; halt autonomous operations globally within 60s.",
        enforcedBy: "kill-switches.ts",
        implemented: true,
      },
      {
        name: "Rollback paths",
        description: "4 rollback paths (policy/marketplace/regional/enterprise) for every reversible action.",
        enforcedBy: "rollback.ts",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R02",
    risk: "Policy drift",
    category: "policy",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "Versioning",
        description: "Every policy change creates a new version; full version history per policy_key.",
        enforcedBy: "policy-as-code.ts (policy_versions table) + policy-engine.ts",
        implemented: true,
      },
      {
        name: "Simulation",
        description: "simulatePolicy() runs a policy against historical decisions to project impact before rollout.",
        enforcedBy: "policy-as-code.ts (simulatePolicy)",
        implemented: true,
      },
      {
        name: "Testing",
        description: "Policy regression tests in CI; every policy change runs against the test suite.",
        enforcedBy: "tests/unit/governance-spec.test.ts + tests/unit/governance-risk-reputation.test.ts",
        implemented: true,
      },
      {
        name: "Gradual rollout",
        description: "Policies roll out canary-first (1% → 10% → 50% → 100%); auto-rollback on regression.",
        enforcedBy: "policy-as-code.ts (rollout_percentage + auto-rollback)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R03",
    risk: "Approval fatigue",
    category: "fatigue",
    likelihood: "high",
    impact: "medium",
    mitigations: [
      {
        name: "Policy auto-tuning proposals",
        description: "System proposes policy tuning (e.g. raise auto-approve threshold) based on observed data.",
        enforcedBy: "policy-as-code.ts (proposePolicyTuning) + governance-committee.ts (R1 responsibility)",
        implemented: true,
      },
      {
        name: "Reputation-based reduction",
        description: "Trusted actors (reputation ≥ 70) get auto-approve for low-risk; new/distrusted actors reviewed more.",
        enforcedBy: "reputation-trust.ts (4 tiers with effects)",
        implemented: true,
      },
      {
        name: "Batching",
        description: "Similar approvals batched for committee review (e.g. weekly batch of marketplace submissions).",
        enforcedBy: "governance-committee.ts (cadence: weekly batch reviews)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R04",
    risk: "Reputation gaming",
    category: "abuse",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "Algorithm detection",
        description: "Anomaly detection on reputation events (sudden boosts, coordinated upvotes).",
        enforcedBy: "reputation-trust.ts (anomaly detection) + governance-dashboards.ts (reputation anomalies)",
        implemented: true,
      },
      {
        name: "Human review of edge cases",
        description: "Anomalies trigger human review; committee can override algorithmic scores.",
        enforcedBy: "governance-committee.ts (review responsibility) + ethics.ts (bias audit integration)",
        implemented: true,
      },
      {
        name: "Audits",
        description: "External annual audit covers reputation system integrity.",
        enforcedBy: "ethics.ts (external_annual audit)",
        implemented: true,
      },
    ],
    residualRisk: "medium",
    implemented: true,
  },
  {
    id: "R05",
    risk: "Bias in decisions",
    category: "ethics",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Fairness principles",
        description: "Fairness principle enforced: no discrimination based on protected characteristics.",
        enforcedBy: "ethics.ts (ETHICAL_PRINCIPLES — fairness)",
        implemented: true,
      },
      {
        name: "Bias audits",
        description: "4 audit types: disparate impact (weekly), native-speaker (monthly), cross-regional (quarterly), external (annual).",
        enforcedBy: "ethics.ts (BIAS_AUDITS + auditBiasDisparateImpact + auditCrossRegionalFairness)",
        implemented: true,
      },
      {
        name: "External review",
        description: "Annual external audit + external advisors for high-risk domains (healthcare/legal/finance).",
        enforcedBy: "ethics.ts (scheduleExternalAudit + EthicalReviewDepth='external')",
        implemented: true,
      },
    ],
    residualRisk: "medium",
    implemented: true,
  },
  {
    id: "R06",
    risk: "Governance committee bottleneck",
    category: "governance",
    likelihood: "medium",
    impact: "medium",
    mitigations: [
      {
        name: "Clear scope",
        description: "Committee scope is explicit: 10 decision types with quorum + required role per type.",
        enforcedBy: "governance-committee.ts (ROUTING_RULES with 10 decision types)",
        implemented: true,
      },
      {
        name: "Delegation",
        description: "Committee can delegate specific decision types to specific roles (time-limited).",
        enforcedBy: "delegations.ts (explicit delegation)",
        implemented: true,
      },
      {
        name: "Autonomy for low-risk decisions",
        description: "Low-risk decisions auto-approve without committee involvement; committee only sees high-risk.",
        enforcedBy: "decision-engine.ts (routeDecision auto_approves low-risk)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R07",
    risk: "Compliance violations",
    category: "compliance",
    likelihood: "low",
    impact: "critical",
    mitigations: [
      {
        name: "Policy as code",
        description: "Compliance policies are versioned code, not tribal knowledge. Rules apply consistently.",
        enforcedBy: "policy-as-code.ts + policy-engine.ts",
        implemented: true,
      },
      {
        name: "Evidence automation",
        description: "Compliance evidence (SOC2/ISO/GDPR/HIPAA/PCI/CCPA) auto-collected via cron.",
        enforcedBy: "governance-dashboards.ts (compliance_evidence table + auto-collection)",
        implemented: true,
      },
      {
        name: "External audit",
        description: "Annual external audit verifies compliance posture.",
        enforcedBy: "ethics.ts (external_annual audit)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R08",
    risk: "Security exposure",
    category: "security",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Least privilege",
        description: "All actors (tools/agents/users/platform) start with minimum permission. Elevation is explicit + logged.",
        enforcedBy: "principles.ts (P02) + has_permission() pg function",
        implemented: true,
      },
      {
        name: "MFA",
        description: "MFA enforced for all admins + sensitive operations.",
        enforcedBy: "admin/mfa.ts",
        implemented: true,
      },
      {
        name: "Audit",
        description: "Hash-chained audit log (admin_audit_log + governance_decision_log) for every action.",
        enforcedBy: "admin/audit.ts + governance-decision-log.ts",
        implemented: true,
      },
      {
        name: "Penetration tests",
        description: "Regular pen tests + bug bounty program.",
        enforcedBy: "autonomous-security.ts (pen_test + bug_bounty)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R09",
    risk: "Opacity to users",
    category: "transparency",
    likelihood: "high",
    impact: "high",
    mitigations: [
      {
        name: "Transparency dashboards",
        description: "User-facing dashboard shows actions taken on their behalf + why.",
        enforcedBy: "transparency-audiences.ts (USER_TRANSPARENCY — 6 items) + transparency.ts (getUserTransparency)",
        implemented: true,
      },
      {
        name: "Explainability",
        description: "Every decision has a structured reasoning; user-facing explanation auto-generated.",
        enforcedBy: "ethics.ts (explainability principle) + governance-decision-log.ts (reasoning field)",
        implemented: true,
      },
      {
        name: "Appeals",
        description: "Users can appeal any decision; 6-step workflow with time limits.",
        enforcedBy: "appeals.ts",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R10",
    risk: "Opacity to auditors",
    category: "transparency",
    likelihood: "low",
    impact: "high",
    mitigations: [
      {
        name: "Dedicated audit views",
        description: "Auditor-facing surfaces with no PII; evidence-based verification.",
        enforcedBy: "transparency-audiences.ts (AUDITOR_TRANSPARENCY — 5 items, no PII)",
        implemented: true,
      },
      {
        name: "Evidence",
        description: "Auto-collected compliance evidence per framework (SOC2/ISO/GDPR/HIPAA/PCI/CCPA).",
        enforcedBy: "governance-dashboards.ts (compliance_evidence) + governance-audit-trail.ts (7 categories)",
        implemented: true,
      },
      {
        name: "Reports",
        description: "Quarterly transparency report + JSONL export of decision log.",
        enforcedBy: "governance-decision-log.ts (exportDecisionLog) + acceptance-criteria.ts (AC20)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R11",
    risk: "Over-centralization",
    category: "centralization",
    likelihood: "medium",
    impact: "medium",
    mitigations: [
      {
        name: "Domain autonomy within policy bounds",
        description: "Each decision domain (8 total) operates autonomously within its policy bounds; no central choke point for routine decisions.",
        enforcedBy: "decision-domains.ts (8 domains with autonomy) + decision-engine.ts (routeDecision per-domain)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R12",
    risk: "Under-centralization",
    category: "centralization",
    likelihood: "medium",
    impact: "medium",
    mitigations: [
      {
        name: "Global policy",
        description: "Policies are global (not per-domain overrides); consistency enforced across all domains.",
        enforcedBy: "policy-as-code.ts (policy_rules are global) + ethics.ts (consistency principle)",
        implemented: true,
      },
      {
        name: "Consistent application",
        description: "Same rules applied in every locale, every region, every workspace.",
        enforcedBy: "ethics.ts (consistency principle) + i18n checker (30-locale coverage)",
        implemented: true,
      },
      {
        name: "Governance committee oversight",
        description: "Standing committee provides cross-domain oversight + reviews high-risk decisions.",
        enforcedBy: "governance-committee.ts (6 members, 10 decision types)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R13",
    risk: "Emergencies requiring fast decisions",
    category: "emergency",
    likelihood: "low",
    impact: "critical",
    mitigations: [
      {
        name: "Kill switches",
        description: "7 named kill switch types halt autonomous operations within 60s globally.",
        enforcedBy: "kill-switches.ts (60s SLA)",
        implemented: true,
      },
      {
        name: "Emergency policies",
        description: "Pre-defined emergency policies (e.g. 'pause all financial operations') that bypass normal approval flow.",
        enforcedBy: "policy-as-code.ts (emergency policy category) + kill-switches.ts (forceBreakerState)",
        implemented: true,
      },
      {
        name: "Fast-track approvals",
        description: "Emergency approval flow: single-approver (not two-person) with post-hoc committee review.",
        enforcedBy: "risk-levels.ts (emergency fast-track) + governance-committee.ts (post-hoc review)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R14",
    risk: "Legal exposure",
    category: "legal",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "External counsel",
        description: "External legal counsel reviews policy changes affecting user rights.",
        enforcedBy: "governance-committee.ts (Legal role) + ethics.ts (external advisors for legal domain)",
        implemented: true,
      },
      {
        name: "Jurisdictional playbooks",
        description: "Per-jurisdiction legal playbooks (GDPR/LGPD/DPDP/POPIA/PIPL/CCPA) govern data handling.",
        enforcedBy: "regional/service.ts + legal/service.ts (versioned legal docs per jurisdiction)",
        implemented: true,
      },
      {
        name: "DPA coverage",
        description: "Data Processing Agreements in place for every jurisdiction we operate in.",
        enforcedBy: "regional/service.ts (compliance_gate with DPA check) + enterprise-provisioning.ts (DPA gate)",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R15",
    risk: "Trust erosion",
    category: "trust",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Transparency",
        description: "3-audience transparency (users/auditors/regulators) + dashboards + exportable logs.",
        enforcedBy: "transparency-audiences.ts + governance-dashboards.ts + governance-decision-log.ts (export)",
        implemented: true,
      },
      {
        name: "Appeals",
        description: "5 appeal types with 6-step workflow + time limits; users can contest any decision.",
        enforcedBy: "appeals.ts",
        implemented: true,
      },
      {
        name: "External audits",
        description: "Annual external audit with published findings.",
        enforcedBy: "ethics.ts (external_annual audit) + acceptance-criteria.ts (AC16)",
        implemented: true,
      },
      {
        name: "Published principles",
        description: "10 operational principles (Section 2) + 7 ethical principles (Section 12) published + verified.",
        enforcedBy: "principles.ts + ethics.ts",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface RiskVerification {
  totalRisks: number;
  mitigatedRisks: number; // risks where all mitigations are implemented.
  totalMitigations: number;
  implementedMitigations: number;
  allImplemented: boolean;
  risksByCategory: Array<{ category: RiskCategory; count: number; mitigated: number }>;
  highestResidualRisk: "low" | "medium" | "high";
}

export function verifyRisksAndMitigations(): RiskVerification {
  const allMitigations = RISKS_AND_MITIGATIONS.flatMap((r) => r.mitigations);
  const implMitigations = allMitigations.filter((m) => m.implemented).length;
  const mitigatedRisks = RISKS_AND_MITIGATIONS.filter((r) => r.implemented).length;

  // Group by category.
  const categoryMap = new Map<RiskCategory, { count: number; mitigated: number }>();
  for (const r of RISKS_AND_MITIGATIONS) {
    const existing = categoryMap.get(r.category) ?? { count: 0, mitigated: 0 };
    existing.count += 1;
    if (r.implemented) existing.mitigated += 1;
    categoryMap.set(r.category, existing);
  }
  const risksByCategory = Array.from(categoryMap.entries()).map(([category, v]) => ({
    category,
    count: v.count,
    mitigated: v.mitigated,
  }));

  // Highest residual risk: rank low < medium < high.
  const rank = { low: 0, medium: 1, high: 2 };
  const highestResidual = RISKS_AND_MITIGATIONS.reduce(
    (max, r) => (rank[r.residualRisk] > rank[max] ? r.residualRisk : max),
    "low" as "low" | "medium" | "high",
  );

  return {
    totalRisks: RISKS_AND_MITIGATIONS.length,
    mitigatedRisks,
    totalMitigations: allMitigations.length,
    implementedMitigations: implMitigations,
    allImplemented: mitigatedRisks === RISKS_AND_MITIGATIONS.length && implMitigations === allMitigations.length,
    risksByCategory,
    highestResidualRisk: highestResidual,
  };
}

/**
 * Get a single risk by id.
 */
export function getRisk(id: string): RiskSpec | undefined {
  return RISKS_AND_MITIGATIONS.find((r) => r.id === id);
}

/**
 * Get all risks in a category.
 */
export function getRisksByCategory(category: RiskCategory): RiskSpec[] {
  return RISKS_AND_MITIGATIONS.filter((r) => r.category === category);
}

/**
 * Get the highest-impact risks (for the dashboard's "Top Risks" view).
 */
export function getTopRisks(limit = 5): RiskSpec[] {
  const impactRank = { low: 0, medium: 1, high: 2, critical: 3 };
  return [...RISKS_AND_MITIGATIONS]
    .sort((a, b) => impactRank[b.impact] - impactRank[a.impact])
    .slice(0, limit);
}

/**
 * Get the residual-risk summary — a single-line summary suitable for the
 * risk dashboard.
 */
export function getResidualRiskSummary(): string {
  const v = verifyRisksAndMitigations();
  return `${v.mitigatedRisks}/${v.totalRisks} risks mitigated; ${v.implementedMitigations}/${v.totalMitigations} mitigations live; highest residual = ${v.highestResidualRisk}`;
}
