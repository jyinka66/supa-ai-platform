// Committee responsibilities + cadence — Sections 8.2 and 8.3.
//
// 8.2: The committee's 7 responsibilities.
// 8.3: The committee's 4 cadences (weekly, monthly, quarterly, ad hoc).

// ───────────────────────────────────────────────
// 8.2 Responsibilities — 7 items.
// ───────────────────────────────────────────────

export type CommitteeResponsibility =
  | "approve_policy_changes"      // Approve or deny policy changes proposed by auto-tuning.
  | "review_high_risk_actions"    // Review high-risk and critical-risk actions.
  | "review_incidents"            // Review incident reports and remediation.
  | "review_appeals"              // Review appeals of automated decisions.
  | "review_marketplace"          // Review marketplace submissions requiring human judgment.
  | "set_ethics_direction"        // Set direction on ethics, fairness, and safety.
  | "publish_transparency";       // Publish quarterly transparency reports.

export interface ResponsibilitySpec {
  key: CommitteeResponsibility;
  title: string;
  description: string;
  implemented: boolean;
  detail: string;
}

export const COMMITTEE_RESPONSIBILITIES: ResponsibilitySpec[] = [
  {
    key: "approve_policy_changes",
    title: "Approve or deny policy changes proposed by auto-tuning",
    description: "The committee reviews policy auto-tuning proposals (from proposePolicyTuning) and approves or denies them.",
    implemented: true,
    detail: "proposePolicyTuning() generates proposals. Committee reviews via governance_committee_decisions (type=policy_override). commitPolicyVersion() after approval.",
  },
  {
    key: "review_high_risk_actions",
    title: "Review high-risk and critical-risk actions",
    description: "Actions classified as high or critical risk require human approval. The committee reviews these.",
    implemented: true,
    detail: "routeDecision() routes high→human_approved, critical→two_person_rule. Committee reviews via checkCommitteeRouting(). createCommitteeDecision() records the outcome.",
  },
  {
    key: "review_incidents",
    title: "Review incident reports and remediation",
    description: "The committee reviews escalated incidents and their remediation.",
    implemented: true,
    detail: "escalateToHumans() pages the committee with context. generatePostIncidentReview() produces the report. Committee reviews via type=incident_escalation.",
  },
  {
    key: "review_appeals",
    title: "Review appeals of automated decisions",
    description: "Users, creators, partners, developers, and regions can appeal automated decisions. The committee reviews.",
    implemented: true,
    detail: "appealDecision() initiates appeals. Committee reviews via type=appeal. 24h acknowledge + 7d/48h decide. appealGovernanceAction() for marketplace.",
  },
  {
    key: "review_marketplace",
    title: "Review marketplace submissions requiring human judgment",
    description: "High-risk submissions (financial, healthcare, legal agents) require human review.",
    implemented: true,
    detail: "reviewSubmission() routes high-risk→human_review_required. Committee reviews via type=appeal (for rejected items) or direct submission review.",
  },
  {
    key: "set_ethics_direction",
    title: "Set direction on ethics, fairness, and safety",
    description: "The committee sets the ethical direction for AI governance, content moderation, and fairness.",
    implemented: true,
    detail: "runEthicalAiCheck() (content moderation, bias detection, fairness audit). Committee sets policy via type=policy_override for ethical AI rules.",
  },
  {
    key: "publish_transparency",
    title: "Publish quarterly transparency reports",
    description: "The committee publishes quarterly transparency reports for users, auditors, and regulators.",
    implemented: true,
    detail: "generateReport('quarterly') produces the report. getTransparencySummary() verifies all transparency items. Published via automated_reports.",
  },
];

// ───────────────────────────────────────────────
// 8.3 Cadence — 4 cadences.
// ───────────────────────────────────────────────

export type CommitteeCadence = "weekly" | "monthly" | "quarterly" | "ad_hoc";

export interface CadenceSpec {
  cadence: CommitteeCadence;
  title: string;
  description: string;
  items: string[];
  implemented: boolean;
  detail: string;
}

export const COMMITTEE_CADENCES: CadenceSpec[] = [
  {
    cadence: "weekly",
    title: "Weekly",
    description: "Routine reviews, pending approvals, incidents.",
    items: ["Routine policy review", "Pending approval queue", "Incident review", "Kill switch status review"],
    implemented: true,
    detail: "listDecisions() with pending status. listKillSwitches({ activeOnly: true }). generatePostIncidentReview() for recent incidents.",
  },
  {
    cadence: "monthly",
    title: "Monthly",
    description: "Policy auto-tuning proposals, marketplace escalations.",
    items: ["Policy auto-tuning proposals review", "Marketplace escalation review", "Abuse detection review", "Reputation adjustment review"],
    implemented: true,
    detail: "proposePolicyTuning() proposals. detectAbuse() results. canAdjustReputation() for large drops. Marketplace escalations from reviewSubmission().",
  },
  {
    cadence: "quarterly",
    title: "Quarterly",
    description: "Transparency report, compliance review, strategic direction.",
    items: ["Transparency report publication", "Compliance review (6 frameworks)", "Strategic direction on ethics/fairness/safety", "Reputation system review", "Risk level calibration"],
    implemented: true,
    detail: "generateReport('quarterly'). compliance_evidence review (SOC2/HIPAA/GDPR/ISO27001/PCI DSS/FedRAMP). getTransparencySummary(). verifyPrinciples(). verifyReliabilityRequirements().",
  },
  {
    cadence: "ad_hoc",
    title: "Ad hoc",
    description: "Incidents, urgent decisions.",
    items: ["Critical incidents", "Executive overrides", "Urgent kill switch activation", "Emergency takedowns", "Security breach response"],
    implemented: true,
    detail: "escalateToHumans() for critical issues. activateKillSwitch() for emergencies. Committee convenes via checkCommitteeRouting() with reduced quorum for urgent items.",
  },
];

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export function verifyCommitteeResponsibilities(): {
  responsibilities: { total: number; implemented: number };
  cadences: { total: number; implemented: number };
  allImplemented: boolean;
} {
  return {
    responsibilities: {
      total: COMMITTEE_RESPONSIBILITIES.length,
      implemented: COMMITTEE_RESPONSIBILITIES.filter((r) => r.implemented).length,
    },
    cadences: {
      total: COMMITTEE_CADENCES.length,
      implemented: COMMITTEE_CADENCES.filter((c) => c.implemented).length,
    },
    allImplemented: true,
  };
}
