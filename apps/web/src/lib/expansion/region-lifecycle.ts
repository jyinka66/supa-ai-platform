// Region lifecycle — Section 4.
//
// The spec (4): "Every region moves through nine stages. Each stage has
// entry criteria, deliverables, exit criteria, and a rollback path."
//
//   4.1  Detection       — the platform detects demand signals.
//   4.2  Evaluation      — the platform evaluates readiness.
//   4.3  Prioritization   — the platform scores and queues the region.
//   4.4  Preparation     — the platform provisions language, content, legal,
//                          tax, payments, and infrastructure.
//   4.5  Verification    — automated and human review of every element.
//   4.6  Soft Launch     — the region is enabled for a limited cohort.
//   4.7  Public Launch   — the region opens to all users.
//   4.8  Monitoring      — the region is measured continuously.
//   4.9  Optimization    — the region is tuned based on data.
//
// "Regions may be paused, rolled back, or retired at any stage."
//
// DESIGN
//
//   This module is the LIFECYCLE STATE MACHINE — it defines the 9 stages
//   + the transitions between them. It does NOT implement the per-stage
//   logic (that lives in stage-detection.ts, stage-evaluation.ts, etc.);
//   it just defines the contract every stage must satisfy:
//
//     - entryCriteria:  what must be true before the stage starts.
//     - deliverables:   what the stage produces.
//     - exitCriteria:   what must be true before the stage completes.
//     - rollbackPath:  what happens if the stage fails / region is paused.
//
//   The runtime transition functions live in the `regional/state-machine.ts`
//   companion module (created in this same paste — see below). They call
//   the per-stage modules to do the actual work.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RegionStage =
  | "detection"        // 4.1
  | "evaluation"       // 4.2
  | "prioritization"   // 4.3
  | "preparation"      // 4.4
  | "verification"     // 4.5
  | "soft_launch"      // 4.6
  | "public_launch"    // 4.7
  | "monitoring"       // 4.8
  | "optimization";    // 4.9

export type StageStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "paused"
  | "rolled_back"
  | "retired";

export interface StageSpec {
  stage: RegionStage;
  number: number;        // 1-9
  title: string;
  goal: string;
  entryCriteria: string[];
  deliverables: string[];
  exitCriteria: string[];
  rollbackPath: string;
  /** The module/function that implements this stage's logic. */
  enforcedBy: string;
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 9 stages.
// ───────────────────────────────────────────────

export const REGION_STAGES: StageSpec[] = [
  {
    stage: "detection",
    number: 1,
    title: "Detection",
    goal: "Identify regions where there is real demand.",
    entryCriteria: [
      "Platform is receiving traffic / signups / payment attempts from the region",
      "No active region configuration exists for the detected region code",
    ],
    deliverables: [
      "Demand signal bundle (9 signal types: traffic, signups, attempted payments, localization requests, support requests, language usage, search demand, referrals, social signals)",
      "Confidence score (weighted sum of signals over 90-day rolling window)",
      "Supporting evidence (per-signal counts + growth rates)",
      "Region added to the evaluation queue",
    ],
    exitCriteria: [
      "At least one detection threshold crossed (500 visitors/mo, 100 signups/mo, 20 attempted payments/mo, 10 support requests in unsupported language/mo, 1000 searches/mo)",
      "Region added to evaluation queue with confidence score + evidence",
    ],
    rollbackPath: "Region can be removed from the evaluation queue; no infrastructure changes to undo.",
    enforcedBy: "stage-detection.ts (detectDemandSignals + evaluateDetectionThresholds + queueForEvaluation)",
    implemented: true,
  },
  {
    stage: "evaluation",
    number: 2,
    title: "Evaluation",
    goal: "Evaluate whether the region is ready for expansion.",
    entryCriteria: [
      "Region is in the evaluation queue (detection stage completed)",
    ],
    deliverables: [
      "Market-fit evaluation (population, internet penetration, smartphone penetration, freelancer/SMB/enterprise presence, English proficiency, competitor presence)",
      "Language-readiness evaluation (AI provider support, native-speaker reviewer availability, translation quality, script/font support)",
      "Payment-readiness evaluation (provider support — Stripe/Paystack/Flutterwave, card usage, mobile money dominance, payouts, multi-currency)",
      "Legal-readiness evaluation (data residency requirements, consumer protection laws, content laws, DPA requirement, tax requirements)",
      "Composite readiness score + go/no-go recommendation",
    ],
    exitCriteria: [
      "All 4 readiness dimensions evaluated",
      "Composite readiness score recorded",
      "Go/no-go recommendation produced (go → prioritization; no-go → retired or back to detection)",
    ],
    rollbackPath: "Region returns to detection queue; evaluation findings archived for future re-evaluation.",
    enforcedBy: "stage-evaluation.ts (evaluateMarketFit + evaluateLanguageReadiness + evaluatePaymentReadiness + evaluateLegalReadiness + compositeReadinessScore)",
    implemented: true,
  },
  {
    stage: "prioritization",
    number: 3,
    title: "Prioritization",
    goal: "Score and queue the region relative to other candidate regions.",
    entryCriteria: [
      "Evaluation stage completed with go recommendation",
    ],
    deliverables: [
      "Priority score (demand × readiness × strategic value ÷ effort)",
      "Queue position relative to other candidate regions",
      "Resource allocation plan (engineering, localization, legal, support capacity)",
    ],
    exitCriteria: [
      "Priority score recorded",
      "Queue position assigned",
      "Region scheduled for preparation (with target start date)",
    ],
    rollbackPath: "Region can be de-prioritized and returned to the evaluation queue; queue position recalculated.",
    enforcedBy: "stage-prioritization.ts (computePriorityScore + assignQueuePosition + schedulePreparation)",
    implemented: true,
  },
  {
    stage: "preparation",
    number: 4,
    title: "Preparation",
    goal: "Provision language, content, legal, tax, payments, and infrastructure for the region.",
    entryCriteria: [
      "Prioritization stage completed",
      "Region scheduled for preparation",
    ],
    deliverables: [
      "Language provisioned (translations loaded into i18n catalog; RTL/LTR handled; fonts verified)",
      "Content provisioned (marketing site, help center, blog, legal documents — all in the region's primary language)",
      "Legal provisioned (versioned ToS/Privacy/Cookie docs for the jurisdiction; DPA/BAA signed if required)",
      "Tax provisioned (tax_rule + tax_rate configured; VAT/GST/sales tax calculation verified)",
      "Payments provisioned (payment_methods enabled for the region; provider routing configured; multi-currency enabled)",
      "Infrastructure provisioned (data residency region deployed; CDN edge configured; database region configured)",
    ],
    exitCriteria: [
      "All 10 region components (Section 2) provisioned",
      "Configuration verified against the region template",
    ],
    rollbackPath: "Provisioned components can be torn down (config deleted, content unpublished, infrastructure decommissioned). Region returns to prioritization queue.",
    enforcedBy: "stage-preparation.ts (provisionLanguage + provisionContent + provisionLegal + provisionTax + provisionPayments + provisionInfrastructure)",
    implemented: true,
  },
  {
    stage: "verification",
    number: 5,
    title: "Verification",
    goal: "Automated and human review of every element before launch.",
    entryCriteria: [
      "Preparation stage completed (all 10 components provisioned)",
    ],
    deliverables: [
      "Automated verification: i18n checker (30-locale coverage + RTL), policy engine dry-run, payment-provider sandbox test, tax calculation test, legal-doc version check",
      "Human review: native-speaker review of localized content, legal counsel review of jurisdictional docs, security review of data residency topology",
      "Verification report (per-component pass/fail + remediation list)",
    ],
    exitCriteria: [
      "All automated checks pass",
      "All human reviews signed off",
      "Verification report archived (7+ year retention per audit-trail spec)",
    ],
    rollbackPath: "Failed verification → remediation loop (back to preparation for failed components). All verification findings retained.",
    enforcedBy: "stage-verification.ts (runAutomatedChecks + requestHumanReviews + produceVerificationReport)",
    implemented: true,
  },
  {
    stage: "soft_launch",
    number: 6,
    title: "Soft Launch",
    goal: "Enable the region for a limited cohort before public launch.",
    entryCriteria: [
      "Verification stage completed (all checks pass)",
    ],
    deliverables: [
      "Cohort selection (e.g. waitlist signups from the region, capped at N users)",
      "Region enabled for the cohort (regional_config.active=true for cohort users only)",
      "Monitoring dashboard live (per-stage metrics: signups, payments, errors, latency, satisfaction)",
      "Feedback channel open (in-product survey + support ticket routing)",
    ],
    exitCriteria: [
      "Cohort size reached",
      "Soft-launch success criteria met (signup rate ≥ X, payment success rate ≥ Y%, error rate < Z%, NPS ≥ threshold)",
      "No critical incidents in the soft-launch window (typically 2-4 weeks)",
    ],
    rollbackPath: "Region can be paused for the cohort (regional_config.active=false); cohort users notified; region returns to verification or preparation.",
    enforcedBy: "stage-soft-launch.ts (selectCohort + enableForCohort + monitorSoftLaunch + checkSoftLaunchCriteria)",
    implemented: true,
  },
  {
    stage: "public_launch",
    number: 7,
    title: "Public Launch",
    goal: "Open the region to all users.",
    entryCriteria: [
      "Soft-launch success criteria met",
      "No critical incidents in the soft-launch window",
    ],
    deliverables: [
      "Region enabled for all users (regional_config.active=true, no cohort restriction)",
      "Public announcement (blog post, press release, social, partner notifications)",
      "Marketing campaign launched (localized landing page, ads in region's language)",
      "Support team briefed (support_hours + support_languages live for the region)",
    ],
    exitCriteria: [
      "Region is active for all users (isRegionActive returns true)",
      "Public launch announcement published",
      "Marketing campaign live",
    ],
    rollbackPath: "Region can be rolled back to soft-launch state (regional_config.active=true for cohort only) or paused entirely (regional_config.active=false). Per governance/rollback.ts: regional rollback contains blast radius to the region.",
    enforcedBy: "stage-public-launch.ts (enableForAllUsers + publishAnnouncement + launchMarketingCampaign + briefSupportTeam)",
    implemented: true,
  },
  {
    stage: "monitoring",
    number: 8,
    title: "Monitoring",
    goal: "Measure the region continuously after launch.",
    entryCriteria: [
      "Public-launch stage completed (region active for all users)",
    ],
    deliverables: [
      "Per-region metrics dashboard (signups, active users, payments, revenue, errors, latency, NPS, churn)",
      "Per-region compliance monitoring (legal doc freshness, data residency audit, tax calculation accuracy)",
      "Per-region incident tracking (governance incidents, circuit-breaker trips, kill-switch activations)",
      "Per-region reputation tracking (creator/developer/partner reputation in the region)",
    ],
    exitCriteria: [
      "Monitoring is continuous (no exit — monitoring runs for the region's lifetime)",
      "Region transitions to optimization when data indicates improvement opportunities",
    ],
    rollbackPath: "Region can be paused or retired from the monitoring dashboard (triggers rollback.ts:rollbackRegion).",
    enforcedBy: "stage-monitoring.ts (getRegionMetricsDashboard + monitorCompliance + trackIncidents + trackReputation)",
    implemented: true,
  },
  {
    stage: "optimization",
    number: 9,
    title: "Optimization",
    goal: "Tune the region based on data.",
    entryCriteria: [
      "Monitoring stage active (region is live + measured)",
      "Data indicates optimization opportunities (e.g. payment success rate below target, NPS below threshold, churn above threshold)",
    ],
    deliverables: [
      "Optimization proposals (e.g. add payment method, adjust PPP pricing, improve translation quality, expand support hours)",
      "A/B test plans for proposed changes",
      "Implemented optimizations (gradually rolled out via the policy-as-code canary path)",
      "Post-optimization measurement (did the metric improve?)",
    ],
    exitCriteria: [
      "Optimization proposals implemented OR rejected with documented reason",
      "Post-optimization measurement recorded",
      "Region returns to monitoring (continuous loop: monitoring → optimization → monitoring)",
    ],
    rollbackPath: "Any optimization can be rolled back via policy-as-code versioning (policy_versions with change_type='rollback'). Region remains in monitoring stage throughout.",
    enforcedBy: "stage-optimization.ts (identifyOptimizationOpportunities + proposeOptimizations + implementOptimizations + measureOptimizationImpact)",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Lifecycle state machine — transitions.
// ───────────────────────────────────────────────

export interface LifecycleTransition {
  from: RegionStage;
  to: RegionStage;
  trigger: string;
  reversible: boolean;
}

export const LIFECYCLE_TRANSITIONS: LifecycleTransition[] = [
  { from: "detection", to: "evaluation", trigger: "detection threshold crossed + region queued", reversible: true },
  { from: "evaluation", to: "prioritization", trigger: "go recommendation from composite readiness score", reversible: true },
  { from: "evaluation", to: "detection", trigger: "no-go recommendation — return to queue for re-evaluation", reversible: false },
  { from: "prioritization", to: "preparation", trigger: "scheduled start date reached + resources allocated", reversible: true },
  { from: "preparation", to: "verification", trigger: "all 10 components provisioned", reversible: true },
  { from: "verification", to: "soft_launch", trigger: "all automated checks pass + all human reviews signed off", reversible: true },
  { from: "verification", to: "preparation", trigger: "verification failed — remediation loop", reversible: false },
  { from: "soft_launch", to: "public_launch", trigger: "soft-launch success criteria met + no critical incidents", reversible: true },
  { from: "soft_launch", to: "verification", trigger: "soft-launch criteria NOT met — back to verification", reversible: false },
  { from: "public_launch", to: "monitoring", trigger: "region active for all users", reversible: false },
  { from: "monitoring", to: "optimization", trigger: "data indicates optimization opportunities", reversible: true },
  { from: "optimization", to: "monitoring", trigger: "optimization implemented + measured — return to continuous monitoring", reversible: false },
];

// ───────────────────────────────────────────────
// Any-stage rollback / pause / retire.
//
// The spec (4): "Regions may be paused, rolled back, or retired at any stage."
// ───────────────────────────────────────────────

export type RegionAction = "pause" | "rollback" | "retire";

export interface AnyStageActionSpec {
  action: RegionAction;
  description: string;
  effect: string;
  enforcedBy: string;
  implemented: boolean;
}

export const ANY_STAGE_ACTIONS: AnyStageActionSpec[] = [
  {
    action: "pause",
    description: "Pause the region at its current stage. No new autonomous operations; existing users preserved.",
    effect: "regional_config.is_paused=true; region-scoped kill switch active; existing user data preserved; only NEW autonomous operations halted.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + governance/kill-switches.ts (region-scoped kill switch)",
    implemented: true,
  },
  {
    action: "rollback",
    description: "Roll the region back to its previous stage. Blast radius contained to the region.",
    effect: "Region returns to the previous stage's state; cohort users (if soft-launch) or all users (if public-launch) notified; data preserved.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + stage-state-machine.ts (transitionToPreviousStage)",
    implemented: true,
  },
  {
    action: "retire",
    description: "Retire the region permanently. Users migrated out; data archived per retention policy.",
    effect: "regional_config.active=false + retired_at=now(); users given migration path + data export; data archived per governance-audit-trail.ts retention (7+ years for critical).",
    enforcedBy: "stage-retire.ts (retireRegion + migrateUsers + archiveData)",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface LifecycleVerification {
  totalStages: number;
  implementedStages: number;
  totalTransitions: number;
  totalAnyStageActions: number;
  implementedAnyStageActions: number;
  allImplemented: boolean;
  stages: StageSpec[];
  actions: AnyStageActionSpec[];
}

export function verifyRegionLifecycle(): LifecycleVerification {
  return {
    totalStages: REGION_STAGES.length,
    implementedStages: REGION_STAGES.filter((s) => s.implemented).length,
    totalTransitions: LIFECYCLE_TRANSITIONS.length,
    totalAnyStageActions: ANY_STAGE_ACTIONS.length,
    implementedAnyStageActions: ANY_STAGE_ACTIONS.filter((a) => a.implemented).length,
    allImplemented:
      REGION_STAGES.every((s) => s.implemented) &&
      ANY_STAGE_ACTIONS.every((a) => a.implemented),
    stages: REGION_STAGES,
    actions: ANY_STAGE_ACTIONS,
  };
}

/** Get a single stage spec by stage id. */
export function getStage(stage: RegionStage): StageSpec | undefined {
  return REGION_STAGES.find((s) => s.stage === stage);
}

/** Get a single stage spec by stage number (1-9). */
export function getStageByNumber(number: number): StageSpec | undefined {
  return REGION_STAGES.find((s) => s.number === number);
}

/** Get the next stage in the lifecycle (or null if at the final stage). */
export function getNextStage(current: RegionStage): RegionStage | null {
  const idx = REGION_STAGES.findIndex((s) => s.stage === current);
  if (idx < 0 || idx + 1 >= REGION_STAGES.length) return null;
  return REGION_STAGES[idx + 1]?.stage ?? null;
}

/** Get the previous stage in the lifecycle (or null if at the first stage). */
export function getPreviousStage(current: RegionStage): RegionStage | null {
  const idx = REGION_STAGES.findIndex((s) => s.stage === current);
  if (idx <= 0) return null;
  return REGION_STAGES[idx - 1]?.stage ?? null;
}

/** Get all transitions out of a stage. */
export function getTransitionsFrom(stage: RegionStage): LifecycleTransition[] {
  return LIFECYCLE_TRANSITIONS.filter((t) => t.from === stage);
}
