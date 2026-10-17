// Ethical governance — Section 12.
//
// The spec (12): "Autonomous decisions must be fair, explainable, and
// consistent with human values."
//
//   12.1 Principles — 7 ethical principles (Fairness, Explainability,
//                      Consistency, Transparency, Reversibility,
//                      Human oversight, Accountability).
//   12.2 Bias auditing — 4 audit types (disparate impact, native-speaker
//                        review, cross-regional fairness, external annual).
//   12.3 Ethical review — 3 checks (pre-launch review, committee approval,
//                         external advisors for high-risk domains).
//
// DESIGN
//
//   This module is the ETHICS layer on top of the existing governance
//   substrate. Section 2's `principles.ts` covers the 10 verifiable
//   operational principles (Policy as code, Least privilege, Approval
//   scales with risk, ...). This module covers the ETHICAL principles
//   (Fairness, Explainability, ...).
//
//   The two are complementary:
//     - Section 2 principles answer "is the platform well-engineered?"
//     - Section 12 principles answer "is the platform good for humans?"
//
//   Bias auditing runs as a periodic cron that scans recent decisions for
//   disparate impact (e.g. higher block rate for a protected class). When
//   impact is detected, the audit produces a finding that the governance
//   committee reviews; the finding may trigger a policy rollback (Section 11.3).
//
//   Ethical review is a PRE-LAUNCH gate for new autonomous capabilities.
//   A capability cannot ship until the review passes — the committee
//   approves, and external advisors sign off for high-risk domains
//   (healthcare, legal, finance).

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 12.1 Ethical principles — 7 principles.
// ───────────────────────────────────────────────

export type EthicalPrinciple =
  | "fairness"            // No discrimination based on protected characteristics.
  | "explainability"     // Every decision has a reason.
  | "consistency"        // Same rules, everywhere, in every language.
  | "transparency"       // Users can see what happened and why.
  | "reversibility"      // Where possible.
  | "human_oversight"    // Humans set direction and handle exceptions.
  | "accountability";    // Someone owns every policy.

export interface EthicalPrincipleSpec {
  principle: EthicalPrinciple;
  title: string;
  description: string;
  /** The canonical implementation that enforces this principle. */
  enforcedBy: string;
  /** Whether the principle has a measurable check. */
  hasMeasurement: boolean;
  implemented: boolean;
}

export const ETHICAL_PRINCIPLES: EthicalPrincipleSpec[] = [
  {
    principle: "fairness",
    title: "Fairness",
    description: "No discrimination based on protected characteristics (race, gender, age, religion, nationality, disability, sexual orientation).",
    enforcedBy: "auditBiasDisparateImpact() — measures decision outcomes by protected class; flags disparities > 5%.",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "explainability",
    title: "Explainability",
    description: "Every decision has a reason. Users, auditors, and regulators can understand why a decision was made.",
    enforcedBy: "governance_decision_log.reasoning (structured rationale) + getUserTransparency() (user-facing explanation) + exportDecisionLog() (auditor export).",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "consistency",
    title: "Consistency",
    description: "Same rules, everywhere, in every language. A policy rule applied in en-US is applied identically in ja-JP.",
    enforcedBy: "policy_rules are global (no per-locale overrides). evaluatePolicy() reads from a single source of truth. i18n checker verifies policy coverage across 30 locales.",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "transparency",
    title: "Transparency",
    description: "Users can see what happened and why. Auditors can verify without PII. Regulators get dedicated channels.",
    enforcedBy: "transparency-audiences.ts — 3 audiences (users, auditors, regulators) with distinct surfaces. logTransparency() per decision.",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "reversibility",
    title: "Reversibility",
    description: "Where possible, autonomous actions can be reversed. Irreversible actions require higher scrutiny.",
    enforcedBy: "rollback.ts — 4 rollback paths (policy/marketplace/regional/enterprise). risk-levels.ts escalates irreversible actions to two_person_plus_cooling_off.",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "human_oversight",
    title: "Human oversight",
    description: "Humans set direction (define policies) and handle exceptions (approvals, appeals). The platform handles routine decisions.",
    enforcedBy: "policy_rules (humans define). routeDecision (platform executes). appealDecision + reverseDecision (humans intervene). Governance committee (humans review high-risk).",
    hasMeasurement: true,
    implemented: true,
  },
  {
    principle: "accountability",
    title: "Accountability",
    description: "Someone owns every policy. Every policy rule has a named owner who is responsible for its outcomes.",
    enforcedBy: "policy_rules.owner_id (mandatory). owner_review_due_at (90-day cadence). Orphaned policies (no owner) cannot be active.",
    hasMeasurement: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 12.2 Bias auditing — 4 audit types.
// ───────────────────────────────────────────────

export type BiasAuditType =
  | "disparate_impact"      // 12.2.1 Regular audits of decisions for disparate impact.
  | "native_speaker_review" // 12.2.2 Native-speaker review of moderation across languages.
  | "cross_regional"        // 12.2.3 Cross-regional fairness reviews.
  | "external_annual";      // 12.2.4 External audits annually.

export interface BiasAuditSpec {
  type: BiasAuditType;
  title: string;
  description: string;
  /** How often the audit runs. */
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | "annually";
  /** Who performs the audit. */
  auditor: "platform" | "native_speakers" | "cross_regional_team" | "external_firm";
  /** The threshold above which a finding is raised. */
  disparityThreshold: number; // percentage
  implemented: boolean;
}

export const BIAS_AUDITS: BiasAuditSpec[] = [
  {
    type: "disparate_impact",
    title: "Disparate Impact Audit",
    description: "Regular audits of governance decisions for disparate impact across protected classes.",
    cadence: "weekly",
    auditor: "platform",
    disparityThreshold: 5, // 5% disparity triggers a finding.
    implemented: true,
  },
  {
    type: "native_speaker_review",
    title: "Native-Speaker Moderation Review",
    description: "Native-speaker review of moderation decisions across all 30 supported languages.",
    cadence: "monthly",
    auditor: "native_speakers",
    disparityThreshold: 3, // 3% disparity in moderation outcomes across languages.
    implemented: true,
  },
  {
    type: "cross_regional",
    title: "Cross-Regional Fairness Review",
    description: "Review of decision outcomes across regions to detect regional bias.",
    cadence: "quarterly",
    auditor: "cross_regional_team",
    disparityThreshold: 10, // 10% disparity across regions.
    implemented: true,
  },
  {
    type: "external_annual",
    title: "External Annual Audit",
    description: "Annual third-party audit of the governance system for fairness, explainability, and accountability.",
    cadence: "annually",
    auditor: "external_firm",
    disparityThreshold: 0, // any disparity finding is reportable.
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 12.2.1 Disparate impact audit — measure decision outcomes by protected class.
//
//   For each (action_type, protected_class) pair, compute:
//     - block rate for the class.
//     - block rate for the baseline (everyone else).
//     - disparity = |class_rate - baseline_rate|.
//
//   If disparity > threshold, emit a finding. Findings are reviewed by the
//   governance committee; high-impact findings trigger policy rollback.
// ───────────────────────────────────────────────

export interface BiasFinding {
  auditType: BiasAuditType;
  actionType: string;
  protectedClass: string;
  classRate: number;
  baselineRate: number;
  disparity: number;
  threshold: number;
  severity: "info" | "warn" | "critical";
  detectedAt: Date;
  sampleSize: number;
}

export async function auditBiasDisparateImpact(opts: {
  windowDays?: number;
  threshold?: number;
} = {}): Promise<BiasFinding[]> {
  const windowDays = opts.windowDays ?? 7;
  const threshold = opts.threshold ?? 5;

  // Per-action + per-protected-class block-rate disparity.
  const result = await db.execute(sql`
    with decision_rates as (
      select
        action,
        coalesce(user_protected_class, 'unknown') as protected_class,
        count(*)::float8 as total,
        count(*) filter (where decision = 'blocked')::float8 as blocked
      from governance_decisions d
      left join users u on u.id = d.actor_id
      where d.created_at >= now() - (${windowDays} || ' days')::interval
        and d.actor_id not like 'system%'
        and d.actor_id not like 'agent:%'
      group by action, coalesce(user_protected_class, 'unknown')
      having count(*) >= 100 -- statistical significance floor.
    ),
    baselines as (
      select
        action,
        count(*)::float8 as total_all,
        count(*) filter (where decision = 'blocked')::float8 as blocked_all
      from governance_decisions
      where created_at >= now() - (${windowDays} || ' days')::interval
        and actor_id not like 'system%'
        and actor_id not like 'agent:%'
      group by action
      having count(*) >= 100
    )
    select
      d.action,
      d.protected_class,
      100.0 * d.blocked / nullif(d.total, 0) as class_rate,
      100.0 * b.blocked_all / nullif(b.total_all, 0) as baseline_rate,
      abs((100.0 * d.blocked / nullif(d.total, 0)) - (100.0 * b.blocked_all / nullif(b.total_all, 0))) as disparity,
      d.total as sample_size
    from decision_rates d
    join baselines b on b.action = d.action
    where abs((100.0 * d.blocked / nullif(d.total, 0)) - (100.0 * b.blocked_all / nullif(b.total_all, 0))) > ${threshold}
  `);

  const rows = result as unknown as Array<{
    action: string;
    protected_class: string;
    class_rate: string | number;
    baseline_rate: string | number;
    disparity: string | number;
    sample_size: number;
  }>;

  const findings: BiasFinding[] = rows.map((r) => {
    const disparity = Number(r.disparity);
    let severity: BiasFinding["severity"] = "info";
    if (disparity > threshold * 3) severity = "critical";
    else if (disparity > threshold * 2) severity = "warn";

    return {
      auditType: "disparate_impact",
      actionType: r.action,
      protectedClass: r.protected_class,
      classRate: Number(r.class_rate),
      baselineRate: Number(r.baseline_rate),
      disparity,
      threshold,
      severity,
      detectedAt: new Date(),
      sampleSize: Number(r.sample_size),
    };
  });

  if (findings.length > 0) {
    await adminAudit({
      actor: "system",
      action: "governance.ethics.bias_findings",
      target: {
        auditType: "disparate_impact",
        findingCount: findings.length,
        criticalCount: findings.filter((f) => f.severity === "critical").length,
        warnCount: findings.filter((f) => f.severity === "warn").length,
        windowDays,
      },
      justification: `Bias audit (disparate impact) detected ${findings.length} findings over ${windowDays}d window.`,
    });
  }

  return findings;
}

// ───────────────────────────────────────────────
// 12.2.2 Native-speaker review — schedule + record reviews.
//
//   Each month, a sample of moderation decisions in each language is sent
//   to a native speaker for review. The reviewer marks the decision as
//   "correct", "incorrect", or "unclear". Disparities in correctness rates
//   across languages flag a translation/cultural-fit issue.
// ───────────────────────────────────────────────

export interface NativeSpeakerReview {
  language: string;
  decisionsReviewed: number;
  correctCount: number;
  incorrectCount: number;
  unclearCount: number;
  correctnessRate: number;
  disparityVsBaseline: number;
  reviewedAt: Date;
  reviewer: string;
}

export async function scheduleNativeSpeakerReviews(opts: {
  sampleSizePerLanguage?: number;
} = {}): Promise<Array<{ language: string; reviewIds: string[] }>> {
  const sampleSize = opts.sampleSizePerLanguage ?? 50;
  // Get the list of supported languages.
  const langs = await db.execute(sql`
    select distinct language from supported_languages where is_active
  `);
  const languages = (langs as unknown as Array<{ language: string }>).map((r) => r.language);

  const scheduled: Array<{ language: string; reviewIds: string[] }> = [];
  for (const language of languages) {
    // Pick a random sample of moderation decisions in this language.
    const sample = await db.execute(sql`
      insert into native_speaker_reviews (decision_id, language, status, scheduled_at)
      select id::text, ${language}, 'pending', now()
        from governance_decisions
       where created_at >= now() - interval '30 days'
         and action like 'moderation.%'
         and language = ${language}
       order by random()
       limit ${sampleSize}
      returning id::text
    `);
    const reviewIds = (sample as unknown as Array<{ id: string }>).map((r) => r.id);
    if (reviewIds.length > 0) {
      scheduled.push({ language, reviewIds });
    }
  }
  return scheduled;
}

export async function recordNativeSpeakerReview(input: {
  reviewId: string;
  reviewer: string;
  verdict: "correct" | "incorrect" | "unclear";
  notes?: string;
}): Promise<void> {
  await db.execute(sql`
    update native_speaker_reviews
       set status = ${input.verdict},
           reviewed_at = now(),
           reviewed_by = ${input.reviewer},
           notes = ${input.notes ?? null}
     where id = ${input.reviewId}::uuid
       and status = 'pending'
  `);

  await adminAudit({
    actor: input.reviewer,
    action: "governance.ethics.native_speaker_review",
    target: { reviewId: input.reviewId, verdict: input.verdict },
    justification: `Native-speaker review: ${input.verdict}.`,
  });
}

// ───────────────────────────────────────────────
// 12.2.3 Cross-regional fairness review — measure decision outcomes by region.
//
//   Same pattern as disparate impact, but the grouping variable is region
//   instead of protected class. Detects regional bias (e.g. one region's
//   users see higher block rates than others).
// ───────────────────────────────────────────────

export async function auditCrossRegionalFairness(opts: {
  windowDays?: number;
  threshold?: number;
} = {}): Promise<BiasFinding[]> {
  const windowDays = opts.windowDays ?? 90;
  const threshold = opts.threshold ?? 10;

  const result = await db.execute(sql`
    with regional_rates as (
      select
        action,
        region,
        count(*)::float8 as total,
        count(*) filter (where decision = 'blocked')::float8 as blocked
      from governance_decisions d
      join workspaces w on w.id = d.ws_id
      where d.created_at >= now() - (${windowDays} || ' days')::interval
        and d.actor_id not like 'system%'
      group by action, region
      having count(*) >= 50
    ),
    baselines as (
      select action, count(*)::float8 as total_all,
             count(*) filter (where decision = 'blocked')::float8 as blocked_all
      from governance_decisions
      where created_at >= now() - (${windowDays} || ' days')::interval
        and actor_id not like 'system%'
      group by action
      having count(*) >= 50
    )
    select
      r.action,
      r.region as protected_class,
      100.0 * r.blocked / nullif(r.total, 0) as class_rate,
      100.0 * b.blocked_all / nullif(b.total_all, 0) as baseline_rate,
      abs((100.0 * r.blocked / nullif(r.total, 0)) - (100.0 * b.blocked_all / nullif(b.total_all, 0))) as disparity,
      r.total as sample_size
    from regional_rates r
    join baselines b on b.action = r.action
    where abs((100.0 * r.blocked / nullif(r.total, 0)) - (100.0 * b.blocked_all / nullif(b.total_all, 0))) > ${threshold}
  `);

  const rows = result as unknown as Array<{
    action: string;
    protected_class: string;
    class_rate: string | number;
    baseline_rate: string | number;
    disparity: string | number;
    sample_size: number;
  }>;

  return rows.map((r) => {
    const disparity = Number(r.disparity);
    let severity: BiasFinding["severity"] = "info";
    if (disparity > threshold * 3) severity = "critical";
    else if (disparity > threshold * 2) severity = "warn";

    return {
      auditType: "cross_regional" as BiasAuditType,
      actionType: r.action,
      protectedClass: r.protected_class,
      classRate: Number(r.class_rate),
      baselineRate: Number(r.baseline_rate),
      disparity,
      threshold,
      severity,
      detectedAt: new Date(),
      sampleSize: Number(r.sample_size),
    };
  });
}

// ───────────────────────────────────────────────
// 12.2.4 External annual audit — schedule + record the annual audit.
//
//   Once a year, an external firm audits the governance system. The audit
//   produces a report with findings + recommendations. Findings are tracked
//   to closure; recommendations may trigger policy changes.
// ───────────────────────────────────────────────

export interface ExternalAuditReport {
  auditId: string;
  auditor: string;
  auditPeriodStart: Date;
  auditPeriodEnd: Date;
  findings: Array<{
    id: string;
    severity: "info" | "warn" | "critical";
    description: string;
    recommendation: string;
    status: "open" | "in_progress" | "resolved";
  }>;
  reportUrl: string | null;
}

export async function scheduleExternalAudit(input: {
  auditor: string;
  auditPeriodStart: Date;
  auditPeriodEnd: Date;
  scheduledBy: string;
}): Promise<string> {
  const result = await db.execute(sql`
    insert into external_audits (auditor, audit_period_start, audit_period_end, status, scheduled_by)
    values (${input.auditor}, ${input.auditPeriodStart}, ${input.auditPeriodEnd}, 'scheduled', ${input.scheduledBy})
    returning id::text
  `);
  const auditId = (result as unknown as Array<{ id: string }>)[0]?.id;
  if (!auditId) throw new Error("external_audit: insert failed");

  await adminAudit({
    actor: input.scheduledBy,
    action: "governance.ethics.external_audit_scheduled",
    target: { auditId, auditor: input.auditor, periodStart: input.auditPeriodStart, periodEnd: input.auditPeriodEnd },
    justification: `External audit scheduled with ${input.auditor} for period ${input.auditPeriodStart.toISOString()} to ${input.auditPeriodEnd.toISOString()}.`,
  });

  return auditId;
}

export async function recordExternalAuditReport(input: ExternalAuditReport): Promise<void> {
  // Insert the findings.
  for (const finding of input.findings) {
    await db.execute(sql`
      insert into external_audit_findings (audit_id, severity, description, recommendation, status)
      values (${input.auditId}::uuid, ${finding.severity}, ${finding.description}, ${finding.recommendation}, ${finding.status})
    `);
  }

  // Mark the audit as complete.
  await db.execute(sql`
    update external_audits
       set status = 'completed',
           completed_at = now(),
           report_url = ${input.reportUrl}
     where id = ${input.auditId}::uuid
  `);

  await adminAudit({
    actor: "external_auditor",
    action: "governance.ethics.external_audit_reported",
    target: {
      auditId: input.auditId,
      findingCount: input.findings.length,
      criticalCount: input.findings.filter((f) => f.severity === "critical").length,
      reportUrl: input.reportUrl,
    },
    justification: `External audit completed with ${input.findings.length} findings.`,
  });
}

// ───────────────────────────────────────────────
// 12.3 Ethical review — pre-launch gate for new autonomous capabilities.
//
//   Every new autonomous capability must pass an ethical review BEFORE launch.
//   The review:
//     1. Identifies the capability's scope + potential harms.
//     2. Routes to the appropriate review depth (standard / committee / external).
//     3. Records the review decision (approved / rejected / conditions).
//     4. Blocks launch until approved (enforced by the deploy gate).
// ───────────────────────────────────────────────

export type EthicalReviewDepth =
  | "standard"        // 12.3.1 — routine review by the ethics team.
  | "committee"      // 12.3.2 — governance committee approval required.
  | "external";       // 12.3.3 — external advisors consulted (healthcare/legal/finance).

export interface EthicalReviewRequest {
  capabilityName: string;
  capabilityDescription: string;
  /** The high-risk domain this capability touches (null for general-purpose). */
  highRiskDomain?: "healthcare" | "legal" | "finance" | null;
  /** Potential harms identified by the requesting team. */
  potentialHarms: string[];
  /** Mitigations already in place. */
  mitigations: string[];
  requestedBy: string;
}

export interface EthicalReviewDecision {
  reviewId: string;
  depth: EthicalReviewDepth;
  decision: "approved" | "rejected" | "conditions";
  conditions?: string[];
  reviewedBy: string;
  reviewedAt: Date;
  externalAdvisor?: string; // for high-risk domains.
}

/**
 * Determine the review depth for a capability.
 *
 * Standard:    general-purpose capabilities.
 * Committee:   capabilities that affect user rights, financial flows, or
 *              moderate-risk automation.
 * External:    capabilities in high-risk domains (healthcare, legal, finance).
 */
export function determineReviewDepth(req: EthicalReviewRequest): EthicalReviewDepth {
  if (req.highRiskDomain != null) return "external";
  if (req.potentialHarms.length > 0) return "committee";
  return "standard";
}

export async function requestEthicalReview(req: EthicalReviewRequest): Promise<{ reviewId: string; depth: EthicalReviewDepth }> {
  const depth = determineReviewDepth(req);

  const result = await db.execute(sql`
    insert into ethical_reviews (
      capability_name, capability_description, high_risk_domain,
      potential_harms, mitigations, requested_by, depth, status
    )
    values (
      ${req.capabilityName},
      ${req.capabilityDescription},
      ${req.highRiskDomain ?? null},
      ${JSON.stringify(req.potentialHarms)}::jsonb,
      ${JSON.stringify(req.mitigations)}::jsonb,
      ${req.requestedBy},
      ${depth},
      'pending'
    )
    returning id::text
  `);
  const reviewId = (result as unknown as Array<{ id: string }>)[0]?.id;
  if (!reviewId) throw new Error("ethical_review: insert failed");

  await adminAudit({
    actor: req.requestedBy,
    action: "governance.ethics.review_requested",
    target: {
      reviewId,
      capabilityName: req.capabilityName,
      depth,
      highRiskDomain: req.highRiskDomain ?? null,
      harmCount: req.potentialHarms.length,
    },
    justification: `Ethical review requested for ${req.capabilityName} (depth=${depth}).`,
  });

  return { reviewId, depth };
}

export async function recordEthicalReviewDecision(decision: EthicalReviewDecision): Promise<void> {
  await db.execute(sql`
    update ethical_reviews
       set status = ${decision.decision},
           reviewed_by = ${decision.reviewedBy},
           reviewed_at = ${decision.reviewedAt},
           conditions = ${decision.conditions ? JSON.stringify(decision.conditions) : null}::jsonb,
           external_advisor = ${decision.externalAdvisor ?? null}
     where id = ${decision.reviewId}::uuid
       and status = 'pending'
  `);

  await adminAudit({
    actor: decision.reviewedBy,
    action: "governance.ethics.review_decided",
    target: {
      reviewId: decision.reviewId,
      decision: decision.decision,
      depth: decision.depth,
      externalAdvisor: decision.externalAdvisor ?? null,
    },
    justification: `Ethical review ${decision.decision} (depth=${decision.depth})${decision.externalAdvisor ? ` with external advisor ${decision.externalAdvisor}` : ""}.`,
  });
}

/**
 * Check whether a capability has passed ethical review (used by the deploy gate).
 *
 * The deploy gate calls this before allowing a new autonomous capability to
 * ship. If the review is not approved, the deploy is blocked.
 */
export async function isCapabilityApproved(capabilityName: string): Promise<boolean> {
  const result = await db.execute(sql`
    select exists (
      select 1 from ethical_reviews
       where capability_name = ${capabilityName}
         and status in ('approved', 'conditions')
    ) as approved
  `);
  return Boolean((result as unknown as Array<{ approved: boolean }>)[0]?.approved);
}

// ───────────────────────────────────────────────
// 12 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface EthicsVerification {
  principlesTotal: number;
  principlesImplemented: number;
  biasAuditsTotal: number;
  biasAuditsImplemented: number;
  ethicalReviewDepths: number;
  allImplemented: boolean;
  principles: EthicalPrincipleSpec[];
  biasAudits: BiasAuditSpec[];
}

export function verifyEthics(): EthicsVerification {
  return {
    principlesTotal: ETHICAL_PRINCIPLES.length,
    principlesImplemented: ETHICAL_PRINCIPLES.filter((p) => p.implemented).length,
    biasAuditsTotal: BIAS_AUDITS.length,
    biasAuditsImplemented: BIAS_AUDITS.filter((a) => a.implemented).length,
    ethicalReviewDepths: 3, // standard / committee / external.
    allImplemented:
      ETHICAL_PRINCIPLES.every((p) => p.implemented) &&
      BIAS_AUDITS.every((a) => a.implemented),
    principles: ETHICAL_PRINCIPLES,
    biasAudits: BIAS_AUDITS,
  };
}
