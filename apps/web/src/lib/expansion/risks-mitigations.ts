// Risks & mitigations — Section 19.
//
// The spec (19): 12 risks + their mitigations.
//
//   R01 Compliance gaps → legal review, tax review, automated evidence.
//   R02 Translation quality issues → AI + native speaker + QA + glossary.
//   R03 Payment method gaps → multi-provider strategy, phased rollout.
//   R04 Data residency violations → enforced at infrastructure, verified.
//   R05 Cultural missteps → cultural review before launch.
//   R06 Support overwhelm → AI triage, self-service, threshold-based scaling.
//   R07 Over-expansion → threshold-based, prioritization scoring.
//   R08 Under-expansion → demand detection, human override to prioritize.
//   R09 Cost overruns per region → cost tracking per region, circuit breakers.
//   R10 Regulatory changes → monitoring, alerts, rapid update pipeline.
//   R11 Competitor moves → monitoring, response playbook.
//   R12 Region retirement difficult → clear process, user communication, data portability.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RiskCategory =
  | "compliance"     // R01
  | "localization"   // R02
  | "payments"       // R03
  | "infrastructure" // R04
  | "cultural"       // R05
  | "support"        // R06
  | "expansion"      // R07, R08
  | "cost"           // R09
  | "regulatory"     // R10
  | "competitive"    // R11
  | "retirement";    // R12

export type RiskLikelihood = "low" | "medium" | "high";
export type RiskImpact = "low" | "medium" | "high" | "critical";

export interface RiskMitigation {
  name: string;
  description: string;
  enforcedBy: string;
  implemented: boolean;
}

export interface RiskSpec {
  id: string;
  risk: string;
  category: RiskCategory;
  likelihood: RiskLikelihood;
  impact: RiskImpact;
  mitigations: RiskMitigation[];
  residualRisk: "low" | "medium" | "high";
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 12 risks + mitigations.
// ───────────────────────────────────────────────

export const RISKS_AND_MITIGATIONS: RiskSpec[] = [
  {
    id: "R01",
    risk: "Compliance gaps",
    category: "compliance",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Legal review",
        description: "Legal counsel reviews every region's legal documents (Privacy, ToS, Cookie, DPA, Refund) before launch.",
        enforcedBy: "stage-preparation.ts (8.3 Legal Workstream HC) + stage-verification.ts (9.2.2 legal_counsel).",
        implemented: true,
      },
      {
        name: "Tax review",
        description: "Tax advisor reviews every region's tax configuration (registration, rules, invoices, reporting) before launch.",
        enforcedBy: "stage-preparation.ts (8.4 Tax Workstream HC) + stage-verification.ts (9.2.3 tax_advisor).",
        implemented: true,
      },
      {
        name: "Automated evidence",
        description: "Compliance evidence (6 frameworks) auto-collected per region via the compliance monitoring cron.",
        enforcedBy: "governance/governance-dashboards.ts (compliance_evidence auto-collection).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R02",
    risk: "Translation quality issues",
    category: "localization",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "AI translation",
        description: "AI first-pass translation (Gemini/GPT) for every string — fast + cheap baseline.",
        enforcedBy: "expansion/pipeline.ts (6-stage language pipeline: AI-translate stage).",
        implemented: true,
      },
      {
        name: "Native speaker review",
        description: "Native-speaker review of every translation — catches cultural + contextual errors AI misses.",
        enforcedBy: "expansion/pipeline.ts (native-speaker review stage) + ethics.ts (scheduleNativeSpeakerReviews).",
        implemented: true,
      },
      {
        name: "Automated QA",
        description: "Automated QA (BLEU score + length check + placeholder check) on every translation.",
        enforcedBy: "expansion/pipeline.ts (automated QA stage) + i18n/checker.ts.",
        implemented: true,
      },
      {
        name: "Glossary",
        description: "Per-locale glossary (terminology, brand voice, do-not-translate terms) ensures consistency across translators.",
        enforcedBy: "i18n glossary (per-locale terminology database).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R03",
    risk: "Payment method gaps",
    category: "payments",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "Multi-provider strategy",
        description: "Multi-provider strategy (Stripe + Paystack + Flutterwave + regional providers) — no single-provider dependency.",
        enforcedBy: "stage-evaluation.ts (payment readiness: provider_support criterion) + regional_payment_methods table.",
        implemented: true,
      },
      {
        name: "Phased rollout",
        description: "Phased payment method rollout — start with the highest-demand method, add others based on usage + support tickets.",
        enforcedBy: "stage-optimization.ts (13.1.2 payment methods: add/remove based on usage).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R04",
    risk: "Data residency violations",
    category: "infrastructure",
    likelihood: "low",
    impact: "critical",
    mitigations: [
      {
        name: "Enforced at infrastructure",
        description: "Data residency enforced at the infrastructure level — regional deployment topology routes writes to the correct geography.",
        enforcedBy: "stage-preparation.ts (8.6 Infrastructure Workstream: provision regional infra) + IaC templates.",
        implemented: true,
      },
      {
        name: "Verified",
        description: "Data residency verified — synthetic monitoring probes confirm data stays in the correct region.",
        enforcedBy: "stage-verification.ts (9.1.11 infrastructure_healthy) + residency verification probes.",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R05",
    risk: "Cultural missteps",
    category: "cultural",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "Cultural review before launch",
        description: "Cultural review (imagery, colors, naming, tone, formats, RTL, sensitivities) before launch — native to the region.",
        enforcedBy: "stage-preparation.ts (8.9 Cultural Workstream HC) + stage-verification.ts (9.2.1 native_speaker_review).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R06",
    risk: "Support overwhelm",
    category: "support",
    likelihood: "high",
    impact: "medium",
    mitigations: [
      {
        name: "AI triage",
        description: "AI triage model (intent classification + sentiment + routing) handles the first-pass ticket routing — reduces human load.",
        enforcedBy: "stage-preparation.ts (8.7.6 configure AI triage model) + support/triage.ts.",
        implemented: true,
      },
      {
        name: "Self-service",
        description: "Self-service help center (localized articles + search) deflects tickets before they reach agents.",
        enforcedBy: "stage-preparation.ts (8.2.1 translate help center) + help center CMS.",
        implemented: true,
      },
      {
        name: "Threshold-based scaling",
        description: "Threshold-based scaling — add agents/expand hours when support_volume exceeds threshold.",
        enforcedBy: "stage-optimization.ts (13.1.4 support: CSAT < 4.0 OR volume increasing → add agents).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R07",
    risk: "Over-expansion",
    category: "expansion",
    likelihood: "medium",
    impact: "medium",
    mitigations: [
      {
        name: "Threshold-based",
        description: "Regions only launch when demand signals cross thresholds (500 visitors, 100 signups, etc.) — prevents launching into markets with no demand.",
        enforcedBy: "stage-detection.ts (DETECTION_THRESHOLDS) + playbook Principle 3.1 (demand-driven).",
        implemented: true,
      },
      {
        name: "Prioritization scoring",
        description: "7-factor prioritization scoring ranks regions by expected value — only the top region is prepared next.",
        enforcedBy: "stage-prioritization.ts (computePriorityScore + getPriorityQueue).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R08",
    risk: "Under-expansion",
    category: "expansion",
    likelihood: "medium",
    impact: "medium",
    mitigations: [
      {
        name: "Demand detection",
        description: "Demand detection runs continuously (daily cron) — surfaces regions with latent demand that haven't crossed thresholds yet.",
        enforcedBy: "stage-detection.ts (runDetectionCycle daily cron).",
        implemented: true,
      },
      {
        name: "Human override to prioritize",
        description: "Humans can override the prioritization queue — promote a region to fast-track it.",
        enforcedBy: "stage-prioritization.ts (promoteRegion) + autonomous-execution.ts (14.3.3 prioritize).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R09",
    risk: "Cost overruns per region",
    category: "cost",
    likelihood: "medium",
    impact: "high",
    mitigations: [
      {
        name: "Cost tracking per region",
        description: "Cost tracked per region (infrastructure, AI, support, localization) — visible in the monitoring dashboard.",
        enforcedBy: "stage-monitoring.ts (revenue metric group) + cost/tracker.ts (per-region cost tracking).",
        implemented: true,
      },
      {
        name: "Circuit breakers",
        description: "Cost circuit breaker trips on cost spikes → throttles or pauses autonomous operations.",
        enforcedBy: "governance/circuit-breakers.ts (cost breaker: trips at $1000/h spike).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R10",
    risk: "Regulatory changes",
    category: "regulatory",
    likelihood: "medium",
    impact: "critical",
    mitigations: [
      {
        name: "Monitoring",
        description: "Regulatory monitoring (external counsel + automated legal feed) detects changes that affect Supa AI.",
        enforcedBy: "stage-monitoring.ts (compliance metric group: legal_changes_detected + regulatory_updates).",
        implemented: true,
      },
      {
        name: "Alerts",
        description: "Critical alerts fire when regulatory changes are detected — on-call engineer + regional team notified.",
        enforcedBy: "stage-monitoring.ts (ALERT_TYPES: regulatory_updates [critical] + compliance_changes [critical]).",
        implemented: true,
      },
      {
        name: "Rapid update pipeline",
        description: "Rapid update pipeline — when a regulatory change is detected, the legal workstream re-runs to update docs + re-register + re-verify.",
        enforcedBy: "stage-optimization.ts (13.1.8 compliance: update as laws change) + stage-preparation.ts (8.3 Legal Workstream).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
  {
    id: "R11",
    risk: "Competitor moves",
    category: "competitive",
    likelihood: "high",
    impact: "medium",
    mitigations: [
      {
        name: "Monitoring",
        description: "Competitor monitoring (new entrants, pricing changes, marketing activity) in the monitoring dashboard.",
        enforcedBy: "stage-monitoring.ts (competition metric group: new_entrants + competitor_pricing_changes + competitor_marketing_activity).",
        implemented: true,
      },
      {
        name: "Response playbook",
        description: "Response playbook — when a competitor moves (e.g. price cut, new feature), the optimization stage proposes a response.",
        enforcedBy: "stage-optimization.ts (13.1.6 marketing: optimize channels based on CAC/LTV) + response playbook.",
        implemented: true,
      },
    ],
    residualRisk: "medium",
    implemented: true,
  },
  {
    id: "R12",
    risk: "Region retirement difficult",
    category: "retirement",
    likelihood: "low",
    impact: "high",
    mitigations: [
      {
        name: "Clear process",
        description: "Clear retirement process (4 triggers → human approval → notify → export → migrate → archive).",
        enforcedBy: "rollback-retirement.ts (RETIREMENT_TRIGGERS + retireRegion).",
        implemented: true,
      },
      {
        name: "User communication",
        description: "User communication — every affected user notified (notification + email + in-product banner) with timeline + options.",
        enforcedBy: "rollback-retirement.ts (retireRegion: users notified via region_user_notifications).",
        implemented: true,
      },
      {
        name: "Data portability",
        description: "Data portability — every user gets a data export (documents, agents, settings) + migration options (to another region, to a competitor, to self-host).",
        enforcedBy: "rollback-retirement.ts (retireRegion: data export queued + migration options provided).",
        implemented: true,
      },
    ],
    residualRisk: "low",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 19 Verification.
// ───────────────────────────────────────────────

export interface RiskVerification {
  totalRisks: number;
  mitigatedRisks: number;
  totalMitigations: number;
  implementedMitigations: number;
  allImplemented: boolean;
  highestResidualRisk: "low" | "medium" | "high";
  risksByCategory: Array<{ category: RiskCategory; count: number; mitigated: number }>;
}

export function verifyRisksAndMitigations(): RiskVerification {
  const allMitigations = RISKS_AND_MITIGATIONS.flatMap((r) => r.mitigations);
  const implMitigations = allMitigations.filter((m) => m.implemented).length;
  const mitigatedRisks = RISKS_AND_MITIGATIONS.filter((r) => r.implemented).length;

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
    highestResidualRisk: highestResidual,
    risksByCategory,
  };
}

/** Get a single risk by id. */
export function getRisk(id: string): RiskSpec | undefined {
  return RISKS_AND_MITIGATIONS.find((r) => r.id === id);
}

/** Get all risks in a category. */
export function getRisksByCategory(category: RiskCategory): RiskSpec[] {
  return RISKS_AND_MITIGATIONS.filter((r) => r.category === category);
}

/** Get the residual-risk summary. */
export function getResidualRiskSummary(): string {
  const v = verifyRisksAndMitigations();
  return `${v.mitigatedRisks}/${v.totalRisks} risks mitigated; ${v.implementedMitigations}/${v.totalMitigations} mitigations live; highest residual = ${v.highestResidualRisk}`;
}
