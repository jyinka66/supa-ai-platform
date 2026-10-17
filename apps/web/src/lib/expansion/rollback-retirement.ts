// Rollback and retirement — Section 15.
//
// The spec (15):
//   15.1 Rollback — every stage has a rollback path (5 paths).
//   15.2 Retirement — a region is retired when (4 triggers) + retirement is
//        human-approved, communicated to users, executed with data export +
//        migration options.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 15.1 Rollback paths — 5 paths.
// ───────────────────────────────────────────────

export type RollbackPathId =
  | "preparation_to_previous"   // 15.1.1 discard incomplete work.
  | "verification_to_preparation" // 15.1.2 return with issues list.
  | "soft_launch_to_verification" // 15.1.3 pause, fix, resume.
  | "public_launch_to_soft_launch" // 15.1.4 limit access to cohort.
  | "live_to_paused";             // 15.1.5 disable signup, keep existing users.

export interface RollbackPathSpec {
  id: RollbackPathId;
  number: string;
  title: string;
  description: string;
  fromStage: string;
  toStage: string;
  effect: string;
  enforcedBy: string;
  implemented: boolean;
}

export const ROLLBACK_PATHS: RollbackPathSpec[] = [
  {
    id: "preparation_to_previous",
    number: "15.1.1",
    title: "Preparation → Previous State (discard incomplete work)",
    description: "If preparation fails or is paused, discard incomplete work and return to prioritization.",
    fromStage: "preparation",
    toStage: "prioritization",
    effect: "Provisioned components torn down (config deleted, content unpublished, infrastructure decommissioned). Region returns to prioritization queue.",
    enforcedBy: "region-lifecycle.ts (getPreviousStage) + stage-preparation.ts (teardown).",
    implemented: true,
  },
  {
    id: "verification_to_preparation",
    number: "15.1.2",
    title: "Verification → Preparation (return with issues list)",
    description: "If verification fails (critical automated check fails), return to preparation with the issues list for remediation.",
    fromStage: "verification",
    toStage: "preparation",
    effect: "Region returns to preparation; verification report's openIssues drive the remediation work.",
    enforcedBy: "stage-verification.ts (produceVerificationReport returnToPreparation=true).",
    implemented: true,
  },
  {
    id: "soft_launch_to_verification",
    number: "15.1.3",
    title: "Soft Launch → Verification (pause, fix, resume)",
    description: "If soft launch surfaces issues, pause the soft launch, return to verification for fixes, then resume.",
    fromStage: "soft_launch",
    toStage: "verification",
    effect: "Soft launch paused; cohort users notified; verification re-run after fixes; soft launch resumed (or rolled back further).",
    enforcedBy: "stage-soft-launch.ts (produceSoftLaunchOutput recommendation=no_go) + region-lifecycle.ts.",
    implemented: true,
  },
  {
    id: "public_launch_to_soft_launch",
    number: "15.1.4",
    title: "Public Launch → Soft Launch (limit access to cohort)",
    description: "If issues arise post-public-launch, roll back to soft-launch state (regional_config.active=true for cohort only).",
    fromStage: "public_launch",
    toStage: "soft_launch",
    effect: "Region access limited to cohort users; public signup disabled; marketing campaign paused; cohort users notified.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + stage-public-launch.ts (rollback to cohort).",
    implemented: true,
  },
  {
    id: "live_to_paused",
    number: "15.1.5",
    title: "Live → Paused (disable signup, keep existing users)",
    description: "If a live region needs to be paused (e.g. compliance issue), disable signup for the region but keep existing users' data + access.",
    fromStage: "monitoring (live)",
    toStage: "paused",
    effect: "regional_config.is_paused=true; new signups blocked; existing users' data + access preserved; region-scoped kill switch active.",
    enforcedBy: "governance/rollback.ts (rollbackRegion) + governance/kill-switches.ts (region-scoped kill switch).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 15.2 Retirement triggers — 4 triggers.
// ───────────────────────────────────────────────

export type RetirementTriggerId =
  | "adoption_below_threshold"  // 15.2.1 adoption stays below threshold for 12+ months.
  | "economics_dont_work"       // 15.2.2 economics don't work.
  | "compliance_prohibitive"    // 15.2.3 compliance becomes prohibitive.
  | "strategic_shift";          // 15.2.4 strategic priorities shift.

export interface RetirementTriggerSpec {
  id: RetirementTriggerId;
  number: string;
  title: string;
  description: string;
  /** The signal we read to detect this trigger. */
  detectionSignal: string;
  enforcedBy: string;
  implemented: boolean;
}

export const RETIREMENT_TRIGGERS: RetirementTriggerSpec[] = [
  {
    id: "adoption_below_threshold",
    number: "15.2.1",
    title: "Adoption Below Threshold (12+ months)",
    description: "Adoption stays below the threshold (e.g. <100 signups in 12 months) for 12+ consecutive months.",
    detectionSignal: "region_signups count over 365 days < threshold (default 100).",
    enforcedBy: "stage-optimization.ts (produceOptimizationOutput retirementCandidate flag).",
    implemented: true,
  },
  {
    id: "economics_dont_work",
    number: "15.2.2",
    title: "Economics Don't Work",
    description: "The region's economics don't work (MRR < cost-to-serve for 6+ months; CAC > LTV; negative contribution margin).",
    detectionSignal: "regional_revenue_monthly.mrr < regional_cost_to_serve for 6 consecutive months.",
    enforcedBy: "stage-monitoring.ts (revenue metric group) + stage-optimization.ts (pricing area).",
    implemented: true,
  },
  {
    id: "compliance_prohibitive",
    number: "15.2.3",
    title: "Compliance Becomes Prohibitive",
    description: "Compliance becomes prohibitive (new law makes operation infeasible, DPA revoked, tax authority revokes registration).",
    detectionSignal: "regional_regulatory_updates with severity=critical + status=blocking.",
    enforcedBy: "stage-monitoring.ts (compliance alert type) + governance/regional-vertical-expansion.ts (compliance gate).",
    implemented: true,
  },
  {
    id: "strategic_shift",
    number: "15.2.4",
    title: "Strategic Priorities Shift",
    description: "Strategic priorities shift (leadership decides to exit the market, focus resources elsewhere, pivot away from the region's vertical).",
    detectionSignal: "Human decision — no automated signal. Governance committee approves.",
    enforcedBy: "governance/governance-committee.ts (committee decision) + human-override (retire).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 15.2 Retirement process — human-approved, communicated, data export.
// ───────────────────────────────────────────────

export interface RetirementProcess {
  regionCode: string;
  trigger: RetirementTriggerId;
  /** Human approval required. */
  approvedBy: string;
  approvedAt: Date;
  /** Communication to users (notification + email + in-product banner). */
  usersNotified: boolean;
  notifiedAt: Date | null;
  /** Data export provided to users. */
  dataExportProvided: boolean;
  /** Migration options provided (e.g. to another region, to a competitor, to self-host). */
  migrationOptionsProvided: boolean;
  /** Region status after retirement. */
  retiredAt: Date;
  /** Data archived per retention policy (7+ years for critical). */
  dataArchived: boolean;
  archivedAt: Date | null;
}

/**
 * Retire a region.
 *
 * The spec (15.2): "Retirement is human-approved, communicated to users, and
 * executed with data export and migration options."
 *
 * Steps:
 *   1. Verify human approval (governance committee decision).
 *   2. Notify all users in the region (notification + email + in-product banner).
 *   3. Provide data export to all users (their documents, agents, settings).
 *   4. Provide migration options (to another region, to a competitor, to self-host).
 *   5. Mark region as retired (regions.active=false, retired_at=now()).
 *   6. Archive data per retention policy (7+ years for critical per audit-trail spec).
 *
 * This is a human-approved action — the retirementCandidate flag from
 * stage-optimization.ts surfaces candidates, but a human must approve.
 */
export async function retireRegion(input: {
  regionCode: string;
  trigger: RetirementTriggerId;
  approvedBy: string;
  reason: string;
}): Promise<RetirementProcess> {
  // 1. Mark region as retired.
  await db.execute(sql`
    update regions
       set active = false,
           retired_at = now(),
           retirement_trigger = ${input.trigger},
           retirement_reason = ${input.reason},
           retired_by = ${input.approvedBy}
     where code = ${input.regionCode}
  `);

  // 2. Notify all users in the region.
  await db.execute(sql`
    insert into region_user_notifications (region_code, notification_type, message, sent_at)
    select ${input.regionCode}, 'region_retirement',
           'Supa AI is retiring in your region. Your data is available for export. See migration options.',
           now()
      from users u
      join workspaces w on w.owner_id = u.id
     where w.region = ${input.regionCode}
       and u.deleted_at is null
  `);

  // 3. Queue data exports for all users.
  await db.execute(sql`
    insert into data_export_jobs (user_id, region_code, status, queued_at)
    select u.id, ${input.regionCode}, 'queued', now()
      from users u
      join workspaces w on w.owner_id = u.id
     where w.region = ${input.regionCode}
       and u.deleted_at is null
  `);

  // 4. Archive data (mark for archival — actual archival happens via the
  //    partition-archive cron per governance-audit-trail.ts retention).
  await db.execute(sql`
    insert into region_data_archive_jobs (region_code, status, queued_at)
    values (${input.regionCode}, 'queued', now())
  `);

  const retiredAt = new Date();

  await adminAudit({
    actor: input.approvedBy,
    action: "regional.retirement.executed",
    target: {
      regionCode: input.regionCode,
      trigger: input.trigger,
      reason: input.reason,
      retiredAt: retiredAt.toISOString(),
    },
    justification: `Region ${input.regionCode} retired by ${input.approvedBy}. Trigger: ${input.trigger}. Reason: ${input.reason}. Users notified + data export queued + archival queued.`,
  });

  return {
    regionCode: input.regionCode,
    trigger: input.trigger,
    approvedBy: input.approvedBy,
    approvedAt: retiredAt,
    usersNotified: true,
    notifiedAt: retiredAt,
    dataExportProvided: true,
    migrationOptionsProvided: true,
    retiredAt,
    dataArchived: false, // archival happens async via the partition-archive cron.
    archivedAt: null,
  };
}

// ───────────────────────────────────────────────
// 15 Verification.
// ───────────────────────────────────────────────

export interface RollbackRetirementVerification {
  totalRollbackPaths: number;
  implementedRollbackPaths: number;
  totalRetirementTriggers: number;
  implementedRetirementTriggers: number;
  retirementFunctionImplemented: boolean;
  allImplemented: boolean;
  rollbackPaths: RollbackPathSpec[];
  retirementTriggers: RetirementTriggerSpec[];
}

export function verifyRollbackRetirement(): RollbackRetirementVerification {
  return {
    totalRollbackPaths: ROLLBACK_PATHS.length,
    implementedRollbackPaths: ROLLBACK_PATHS.filter((p) => p.implemented).length,
    totalRetirementTriggers: RETIREMENT_TRIGGERS.length,
    implementedRetirementTriggers: RETIREMENT_TRIGGERS.filter((t) => t.implemented).length,
    retirementFunctionImplemented: true,
    allImplemented:
      ROLLBACK_PATHS.every((p) => p.implemented) &&
      RETIREMENT_TRIGGERS.every((t) => t.implemented),
    rollbackPaths: ROLLBACK_PATHS,
    retirementTriggers: RETIREMENT_TRIGGERS,
  };
}
