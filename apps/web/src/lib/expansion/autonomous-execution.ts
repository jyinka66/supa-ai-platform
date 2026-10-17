// Autonomous execution — Section 14.
//
// The spec (14): "Every stage is executed autonomously with human checkpoints
// only where required."
//
//   14.1 Autonomous Execution — 9 stages with autonomy level:
//     - Detection: fully automatic.
//     - Evaluation: fully automatic.
//     - Prioritization: automatic, with human override.
//     - Preparation: automatic per workstream, with human sign-off at checkpoints.
//     - Verification: automatic, with human escalation.
//     - Soft Launch: automatic rollout, human monitoring.
//     - Public Launch: automatic rollout, human monitoring.
//     - Monitoring: fully automatic.
//     - Optimization: automatic proposals, human approval for material changes.
//
//   14.2 Human Checkpoints — 7 items humans approve:
//     - Legal documents per region.
//     - Tax setups per region.
//     - High-risk payment changes.
//     - Cultural considerations.
//     - Go / No-Go for public launch.
//     - Material pricing changes.
//     - Region retirement.
//
//   14.3 Human Override — 5 actions humans can take at any stage:
//     - Pause a region.
//     - Roll back a region.
//     - Prioritize a region.
//     - Deprioritize a region.
//     - Retire a region.

// ───────────────────────────────────────────────
// 14.1 Autonomous execution per stage — 9 stages.
// ───────────────────────────────────────────────

export type StageAutonomyLevel =
  | "fully_automatic"          // no human involvement required.
  | "automatic_with_override"   // automatic, but humans can override.
  | "automatic_with_signoff"    // automatic per workstream, human sign-off at checkpoints.
  | "automatic_with_escalation" // automatic, human escalation on failures.
  | "automatic_with_monitoring" // automatic rollout, human monitoring.
  | "automatic_with_approval";  // automatic proposals, human approval for material changes.

export interface StageAutonomySpec {
  stage: string;
  number: string;          // "14.1.1" etc.
  title: string;
  autonomy: StageAutonomyLevel;
  description: string;
  /** The human involvement required (null if fully automatic). */
  humanInvolvement: string | null;
  /** The module that implements this stage. */
  enforcedBy: string;
  implemented: boolean;
}

export const STAGE_AUTONOMY: StageAutonomySpec[] = [
  {
    stage: "detection",
    number: "14.1.1",
    title: "Detection",
    autonomy: "fully_automatic",
    description: "Fully automatic — demand signals collected + thresholds checked + region queued without human involvement.",
    humanInvolvement: null,
    enforcedBy: "stage-detection.ts (runDetectionCycle cron).",
    implemented: true,
  },
  {
    stage: "evaluation",
    number: "14.1.2",
    title: "Evaluation",
    autonomy: "fully_automatic",
    description: "Fully automatic — all 8 readiness dimensions evaluated + composite score computed + go/no-go recommendation produced.",
    humanInvolvement: null,
    enforcedBy: "stage-evaluation.ts (produceEvaluationOutput).",
    implemented: true,
  },
  {
    stage: "prioritization",
    number: "14.1.3",
    title: "Prioritization",
    autonomy: "automatic_with_override",
    description: "Automatic scoring + queue ranking, with human override (promote/demote/remove/add).",
    humanInvolvement: "Humans can override the queue (promote/demote/remove/add) with mandatory reasoning.",
    enforcedBy: "stage-prioritization.ts (getPriorityQueue + applyHumanOverride).",
    implemented: true,
  },
  {
    stage: "preparation",
    number: "14.1.4",
    title: "Preparation",
    autonomy: "automatic_with_signoff",
    description: "Automatic per workstream (9 workstreams run in parallel), with human sign-off at each workstream's checkpoint.",
    humanInvolvement: "Human sign-off at each workstream's checkpoint (language/content/legal/tax/payments/infrastructure/support/marketing/cultural).",
    enforcedBy: "stage-preparation.ts (runWorkstream + signOffWorkstreamCheckpoint).",
    implemented: true,
  },
  {
    stage: "verification",
    number: "14.1.5",
    title: "Verification",
    autonomy: "automatic_with_escalation",
    description: "Automatic (11 automated checks run in parallel), with human escalation for failures (6 human reviewers sign off).",
    humanInvolvement: "Human escalation: 6 reviewers (native speaker, legal counsel, tax advisor, payments advisor, support lead, marketing lead) sign off.",
    enforcedBy: "stage-verification.ts (runAllAutomatedChecks + checkHumanVerifications).",
    implemented: true,
  },
  {
    stage: "soft_launch",
    number: "14.1.6",
    title: "Soft Launch",
    autonomy: "automatic_with_monitoring",
    description: "Automatic rollout to cohort, human monitoring of 8 metrics.",
    humanInvolvement: "Human monitoring of activation/retention/conversion/payment/support/error/latency/NPS metrics.",
    enforcedBy: "stage-soft-launch.ts (designSoftLaunch + getSoftLaunchMetrics).",
    implemented: true,
  },
  {
    stage: "public_launch",
    number: "14.1.7",
    title: "Public Launch",
    autonomy: "automatic_with_monitoring",
    description: "Automatic rollout (8 actions in sequence), human monitoring with safeguards (circuit breakers, kill switch, rollback).",
    humanInvolvement: "Human monitoring with 4 safeguards active (circuit breakers, kill switch, rollback to soft launch, capacity buffer).",
    enforcedBy: "stage-public-launch.ts (executePublicLaunch).",
    implemented: true,
  },
  {
    stage: "monitoring",
    number: "14.1.8",
    title: "Monitoring",
    autonomy: "fully_automatic",
    description: "Fully automatic — 9 metric groups collected continuously + 5 alert types fired automatically + 4 report types generated on cadence.",
    humanInvolvement: null,
    enforcedBy: "stage-monitoring.ts (getRegionalMonitoringDashboard + raiseAlert).",
    implemented: true,
  },
  {
    stage: "optimization",
    number: "14.1.9",
    title: "Optimization",
    autonomy: "automatic_with_approval",
    description: "Automatic proposals (opportunities identified from monitoring data), human approval for material changes.",
    humanInvolvement: "Human approval for material changes (pricing, payment methods, product features).",
    enforcedBy: "stage-optimization.ts (identifyOptimizationOpportunities + implementOptimization).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 14.2 Human checkpoints — 7 items humans approve.
// ───────────────────────────────────────────────

export type HumanCheckpointId =
  | "legal_documents"          // 14.2.1 per region.
  | "tax_setups"                 // 14.2.2 per region.
  | "high_risk_payment_changes" // 14.2.3
  | "cultural_considerations"   // 14.2.4
  | "go_no_go_public_launch"   // 14.2.5
  | "material_pricing_changes"  // 14.2.6
  | "region_retirement";        // 14.2.7

export interface HumanCheckpointSpec {
  id: HumanCheckpointId;
  number: string;
  title: string;
  description: string;
  /** The role that approves. */
  approver: string;
  /** The stage this checkpoint belongs to. */
  stage: string;
  enforcedBy: string;
  implemented: boolean;
}

export const HUMAN_CHECKPOINTS: HumanCheckpointSpec[] = [
  {
    id: "legal_documents",
    number: "14.2.1",
    title: "Legal Documents per Region",
    description: "Humans approve the 5 legal documents (Privacy, ToS, Cookie, DPA, Refund) per region before public launch.",
    approver: "legal_counsel",
    stage: "preparation (8.3 Legal Workstream) + verification (9.2.2 legal_counsel)",
    enforcedBy: "stage-preparation.ts (8.3.HC) + stage-verification.ts (9.2.2).",
    implemented: true,
  },
  {
    id: "tax_setups",
    number: "14.2.2",
    title: "Tax Setups per Region",
    description: "Humans approve the tax configuration (registration, rules, invoices, reporting) per region before public launch.",
    approver: "tax_advisor",
    stage: "preparation (8.4 Tax Workstream) + verification (9.2.3 tax_advisor)",
    enforcedBy: "stage-preparation.ts (8.4.HC) + stage-verification.ts (9.2.3).",
    implemented: true,
  },
  {
    id: "high_risk_payment_changes",
    number: "14.2.3",
    title: "High-Risk Payment Changes",
    description: "Humans approve high-risk payment changes (new payment method, payout provider change, pricing model change) per region.",
    approver: "payments_advisor",
    stage: "preparation (8.5 Payments Workstream) + verification (9.2.4 payments_advisor) + optimization (13.1.2 payment methods)",
    enforcedBy: "stage-preparation.ts (8.5.HC) + stage-verification.ts (9.2.4) + stage-optimization.ts.",
    implemented: true,
  },
  {
    id: "cultural_considerations",
    number: "14.2.4",
    title: "Cultural Considerations",
    description: "Humans approve the cultural adaptation (imagery, examples, tone, formats, RTL, sensitivities) per region.",
    approver: "cultural_reviewer",
    stage: "preparation (8.9 Cultural Workstream) + verification (9.2.1 native_speaker_review)",
    enforcedBy: "stage-preparation.ts (8.9.HC) + stage-verification.ts (9.2.1).",
    implemented: true,
  },
  {
    id: "go_no_go_public_launch",
    number: "14.2.5",
    title: "Go / No-Go for Public Launch",
    description: "Humans approve the go/no-go decision for public launch (after soft launch + verification).",
    approver: "governance_committee",
    stage: "soft launch (10.3) → public launch (11.1)",
    enforcedBy: "stage-soft-launch.ts (produceSoftLaunchOutput recommendation) + governance-committee.ts.",
    implemented: true,
  },
  {
    id: "material_pricing_changes",
    number: "14.2.6",
    title: "Material Pricing Changes",
    description: "Humans approve material pricing changes (PPP factor adjustment, new tier, regional discount) per region.",
    approver: "governance_committee",
    stage: "optimization (13.1.1 pricing)",
    enforcedBy: "stage-optimization.ts (implementOptimization) + governance-committee.ts (R1 approve_policy_changes).",
    implemented: true,
  },
  {
    id: "region_retirement",
    number: "14.2.7",
    title: "Region Retirement",
    description: "Humans approve region retirement (adoption < threshold for 12+ months, economics don't work, compliance prohibitive, strategic shift).",
    approver: "governance_committee",
    stage: "optimization (13.2) → retirement (Section 15)",
    enforcedBy: "stage-optimization.ts (retirementCandidate flag) + Section 15 retirement process.",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 14.3 Human override — 5 actions at any stage.
// ───────────────────────────────────────────────

export type HumanOverrideAction =
  | "pause"          // 14.3.1 pause a region.
  | "rollback"       // 14.3.2 roll back a region.
  | "prioritize"     // 14.3.3 prioritize a region.
  | "deprioritize"   // 14.3.4 deprioritize a region.
  | "retire";        // 14.3.5 retire a region.

export interface HumanOverrideSpec {
  action: HumanOverrideAction;
  number: string;
  title: string;
  description: string;
  /** The stage(s) this override can be applied at. */
  applicableStages: string;
  /** The effect of the override. */
  effect: string;
  enforcedBy: string;
  implemented: boolean;
}

export const HUMAN_OVERRIDES: HumanOverrideSpec[] = [
  {
    action: "pause",
    number: "14.3.1",
    title: "Pause a Region",
    description: "Pause the region at its current stage — no new autonomous operations; existing users preserved.",
    applicableStages: "any stage",
    effect: "regional_config.is_paused=true; region-scoped kill switch active; existing user data preserved.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + governance/kill-switches.ts (region-scoped kill switch).",
    implemented: true,
  },
  {
    action: "rollback",
    number: "14.3.2",
    title: "Roll Back a Region",
    description: "Roll the region back to its previous stage (e.g. public launch → soft launch, soft launch → verification).",
    applicableStages: "any stage after detection",
    effect: "Region returns to the previous stage's state; blast radius contained to the region.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + region-lifecycle.ts (getPreviousStage).",
    implemented: true,
  },
  {
    action: "prioritize",
    number: "14.3.3",
    title: "Prioritize a Region",
    description: "Fast-track a region in the prioritization queue (move to top of queue).",
    applicableStages: "prioritization stage (and re-prioritization at any later stage)",
    effect: "Region moved to top of priority queue; prepared next.",
    enforcedBy: "stage-prioritization.ts (promoteRegion).",
    implemented: true,
  },
  {
    action: "deprioritize",
    number: "14.3.4",
    title: "Deprioritize a Region",
    description: "Defer a region in the prioritization queue (move to bottom).",
    applicableStages: "prioritization stage (and re-prioritization at any later stage)",
    effect: "Region moved to bottom of priority queue; deferred.",
    enforcedBy: "stage-prioritization.ts (demoteRegion).",
    implemented: true,
  },
  {
    action: "retire",
    number: "14.3.5",
    title: "Retire a Region",
    description: "Retire the region permanently — users migrated out, data archived per retention policy.",
    applicableStages: "any stage (typically after optimization flags retirement candidate)",
    effect: "regional_config.active=false + retired_at=now(); users given migration path + data export; data archived 7+ years.",
    enforcedBy: "Section 15 retirement process (retireRegion + migrateUsers + archiveData).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 14 Verification.
// ───────────────────────────────────────────────

export interface AutonomousExecutionVerification {
  totalStages: number;
  implementedStages: number;
  fullyAutomaticStages: number;
  stagesWithHumanInvolvement: number;
  totalHumanCheckpoints: number;
  implementedHumanCheckpoints: number;
  totalHumanOverrides: number;
  implementedHumanOverrides: number;
  allImplemented: boolean;
  stages: StageAutonomySpec[];
  checkpoints: HumanCheckpointSpec[];
  overrides: HumanOverrideSpec[];
}

export function verifyAutonomousExecution(): AutonomousExecutionVerification {
  const fullyAutomatic = STAGE_AUTONOMY.filter((s) => s.autonomy === "fully_automatic").length;
  const withHuman = STAGE_AUTONOMY.filter((s) => s.autonomy !== "fully_automatic").length;

  return {
    totalStages: STAGE_AUTONOMY.length,
    implementedStages: STAGE_AUTONOMY.filter((s) => s.implemented).length,
    fullyAutomaticStages: fullyAutomatic,
    stagesWithHumanInvolvement: withHuman,
    totalHumanCheckpoints: HUMAN_CHECKPOINTS.length,
    implementedHumanCheckpoints: HUMAN_CHECKPOINTS.filter((c) => c.implemented).length,
    totalHumanOverrides: HUMAN_OVERRIDES.length,
    implementedHumanOverrides: HUMAN_OVERRIDES.filter((o) => o.implemented).length,
    allImplemented:
      STAGE_AUTONOMY.every((s) => s.implemented) &&
      HUMAN_CHECKPOINTS.every((c) => c.implemented) &&
      HUMAN_OVERRIDES.every((o) => o.implemented),
    stages: STAGE_AUTONOMY,
    checkpoints: HUMAN_CHECKPOINTS,
    overrides: HUMAN_OVERRIDES,
  };
}
