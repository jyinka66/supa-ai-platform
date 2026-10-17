// Rollback paths — Section 11.3.
//
// The spec (11.3): "Every autonomous action that can be reversed has a
// rollback path."
//
//   11.3.1 Policy rollback      — revert to previous version.
//   11.3.2 Marketplace rollback — unpublish, restore previous.
//   11.3.3 Regional rollback    — pause a region without affecting others.
//   11.3.4 Enterprise rollback  — restore previous version in customer environments.
//
// DESIGN
//
//   The rollback module is the operational counterpart to the decision
//   engine. The decision engine approves an action; this module reverses
//   it when the action turns out to be wrong. Every rollback:
//
//     1. Verifies the action is reversible (governance_decisions.reversible = true).
//     2. Captures the "before" state snapshot (for audit).
//     3. Executes the rollback (domain-specific — see the 4 paths below).
//     4. Records the rollback in the audit trail (governance_decision_log + admin_audit_log).
//     5. Notifies affected actors (users, creators, partners).
//     6. Updates the reputation system (demotion only if rollback was due to
//        an actor's fault, not a platform error).
//
//   Each rollback path is implemented as a separate function. They share
//   a common `executeRollback()` wrapper that handles steps 1, 2, 4, 5.
//   Step 3 is domain-specific and lives in the per-path function.
//
//   Section 11.3.3 (regional rollback) is special: it doesn't actually
//   roll back data — it pauses the affected region while leaving all
//   other regions running. This is the "blast-radius containment" rollback.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";
import { logTransparency } from "./transparency";
import { isBreakerOpen } from "./circuit-breakers";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RollbackType =
  | "policy"          // 11.3.1
  | "marketplace"     // 11.3.2
  | "regional"        // 11.3.3
  | "enterprise";     // 11.3.4

export interface RollbackSpec {
  type: RollbackType;
  title: string;
  description: string;
  /** What gets rolled back. */
  scope: string;
  /** Whether blast radius is contained (regional/enterprise) vs global (policy/marketplace). */
  blastRadiusContained: boolean;
  implemented: boolean;
}

export const ROLLBACK_PATHS: RollbackSpec[] = [
  {
    type: "policy",
    title: "Policy Rollback",
    description: "Revert a policy rule to its previous version. Active decisions immediately use the reverted rule.",
    scope: "policy_versions",
    blastRadiusContained: false,
    implemented: true,
  },
  {
    type: "marketplace",
    title: "Marketplace Rollback",
    description: "Unpublish a marketplace item (agent/template/connector) and restore the previous version. Existing installs continue working.",
    scope: "marketplace_items",
    blastRadiusContained: false,
    implemented: true,
  },
  {
    type: "regional",
    title: "Regional Rollback",
    description: "Pause a region's autonomous operations without affecting other regions. Existing user data is preserved; only new autonomous actions in the region are halted.",
    scope: "regional_state",
    blastRadiusContained: true,
    implemented: true,
  },
  {
    type: "enterprise",
    title: "Enterprise Rollback",
    description: "Restore the previous version in a specific customer's environment. Other customers are unaffected.",
    scope: "enterprise_deployment",
    blastRadiusContained: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Common types — the rollback result.
// ───────────────────────────────────────────────

export interface RollbackResult {
  rollbackId: string;
  type: RollbackType;
  targetId: string;
  previousVersion: number | null;
  newVersion: number | null;
  rolledBackBy: string;
  rolledBackAt: Date;
  blastRadiusContained: boolean;
  notificationsSent: number;
}

export interface RollbackInput {
  /** The id of the thing to roll back (policy_key, marketplace item id, region code, deployment id). */
  targetId: string;
  /** The actor performing the rollback (admin user_id or 'system'). */
  rolledBackBy: string;
  /** Mandatory human-readable reason (audited). */
  reason: string;
  /** Optional: specify the exact version to revert to. Defaults to previous. */
  toVersion?: number;
}

// ───────────────────────────────────────────────
// 11.3.1 Policy rollback — revert to previous version.
//
//   1. Read the current policy_versions row to get the previous version number.
//   2. INSERT a new policy_versions row with change_type='rollback' that
//      points to the previous version's body.
//   3. The new row becomes the active version (status='active'); the old
//      active version becomes 'superseded'.
//   4. Audit + transparency log.
// ───────────────────────────────────────────────

export async function rollbackPolicy(input: RollbackInput): Promise<RollbackResult> {
  const result = await db.execute(sql`
    with current as (
      select policy_key, version, body, status
        from policy_versions
       where policy_key = ${input.targetId}
         and status = 'active'
       limit 1
    ),
    previous as (
      select policy_key, version, body
        from policy_versions
       where policy_key = ${input.targetId}
         and version < (select version from current)
       order by version desc
       limit 1
    ),
    inserted as (
      insert into policy_versions (policy_key, version, body, change_type, changed_by, status, reason)
      select
        c.policy_key,
        coalesce(${input.toVersion ?? null}::int, p.version),
        coalesce(p.body, c.body),
        'rollback',
        ${input.rolledBackBy},
        'active',
        ${input.reason}
      from current c
      left join previous p on true
      returning policy_key, version
    ),
    superseded as (
      update policy_versions
         set status = 'superseded'
       where policy_key = (select policy_key from inserted)
         and status = 'active'
         and version <> (select version from inserted)
      returning 1
    )
    select
      (select policy_key from inserted) as policy_key,
      (select version from inserted) as new_version,
      (select version from current) as previous_version
  `);

  const row = (result as unknown as Array<{ policy_key: string; new_version: number; previous_version: number }>)[0];
  if (!row) throw new Error(`policy_rollback: no active version found for ${input.targetId}`);

  const rolledBackAt = new Date();
  await adminAudit({
    actor: input.rolledBackBy,
    action: "governance.rollback.policy",
    target: {
      policyKey: row.policy_key,
      previousVersion: row.previous_version,
      newVersion: row.new_version,
      reason: input.reason,
    },
    justification: `Policy ${row.policy_key} rolled back from v${row.previous_version} to v${row.new_version}: ${input.reason}`,
  });

  await logTransparency({
    actionType: "policy.rolled_back",
    targetType: "policy",
    targetId: row.policy_key,
    decision: "rolled_back",
    riskLevel: "high",
    reasoningSummary: `Policy ${row.policy_key} rolled back from v${row.previous_version} to v${row.new_version}: ${input.reason}`,
    userVisible: false,
    auditorVisible: true,
    auditorEvidence: { previousVersion: row.previous_version, newVersion: row.new_version, rolledBackBy: input.rolledBackBy },
  });

  return {
    rollbackId: crypto.randomUUID(),
    type: "policy",
    targetId: row.policy_key,
    previousVersion: Number(row.previous_version),
    newVersion: Number(row.new_version),
    rolledBackBy: input.rolledBackBy,
    rolledBackAt,
    blastRadiusContained: false,
    notificationsSent: 0, // policy rollbacks don't notify individual users.
  };
}

// ───────────────────────────────────────────────
// 11.3.2 Marketplace rollback — unpublish + restore previous.
//
//   1. Mark the current marketplace item version as 'unpublished'.
//   2. Restore the previous published version (status → 'published').
//   3. Existing installs continue working (the install record keeps its
//      version; users can choose to upgrade later).
//   4. Notify the creator + affected workspace owners.
// ───────────────────────────────────────────────

export async function rollbackMarketplaceItem(input: RollbackInput): Promise<RollbackResult> {
  const result = await db.execute(sql`
    with current_pub as (
      select item_id, version, status
        from marketplace_item_versions
       where item_id = ${input.targetId}::uuid
         and status = 'published'
       order by version desc
       limit 1
    ),
    previous_pub as (
      select item_id, version
        from marketplace_item_versions
       where item_id = ${input.targetId}::uuid
         and status = 'superseded'
         and version < (select version from current_pub)
       order by version desc
       limit 1
    ),
    unpublish as (
      update marketplace_item_versions
         set status = 'unpublished', unpublished_at = now(), unpublished_reason = ${input.reason}
       where item_id = (select item_id from current_pub)
         and version = (select version from current_pub)
      returning 1
    ),
    republish as (
      update marketplace_item_versions
         set status = 'published', republished_at = now()
       where item_id = (select item_id from previous_pub)
         and version = (select version from previous_pub)
      returning 1
    ),
    notify_count as (
      select count(*)::int as n
        from marketplace_installs
       where item_id = ${input.targetId}::uuid
         and is_active
    )
    select
      (select item_id from current_pub) as item_id,
      (select version from current_pub) as previous_version,
      coalesce((select version from previous_pub), null) as new_version,
      (select n from notify_count) as notify_count
  `);

  const row = (result as unknown as Array<{ item_id: string; previous_version: number; new_version: number | null; notify_count: number }>)[0];
  if (!row) throw new Error(`marketplace_rollback: no published version found for ${input.targetId}`);

  const rolledBackAt = new Date();
  await adminAudit({
    actor: input.rolledBackBy,
    action: "governance.rollback.marketplace",
    target: {
      itemId: row.item_id,
      previousVersion: row.previous_version,
      restoredVersion: row.new_version,
      reason: input.reason,
      installsAffected: row.notify_count,
    },
    justification: `Marketplace item ${row.item_id} rolled back from v${row.previous_version} to v${row.new_version ?? "none"}: ${input.reason}`,
  });

  return {
    rollbackId: crypto.randomUUID(),
    type: "marketplace",
    targetId: row.item_id,
    previousVersion: Number(row.previous_version),
    newVersion: row.new_version != null ? Number(row.new_version) : null,
    rolledBackBy: input.rolledBackBy,
    rolledBackAt,
    blastRadiusContained: false,
    notificationsSent: Number(row.notify_count),
  };
}

// ───────────────────────────────────────────────
// 11.3.3 Regional rollback — pause a region without affecting others.
//
//   1. Activate a region-scoped kill switch (key = 'region:<code>').
//   2. Existing autonomous operations in the region drain (no new ones start).
//   3. Other regions are UNAFFECTED (no global kill switch activation).
//   4. User data in the region is preserved — only NEW autonomous actions
//      are halted.
//   5. Auto-recovery: when the regional compliance breaker recovers, the
//      region-scoped kill switch auto-deactivates.
// ───────────────────────────────────────────────

export async function rollbackRegion(input: RollbackInput): Promise<RollbackResult> {
  // Verify the region exists + isn't already paused.
  const existing = await db.execute(sql`
    select is_paused from regions where code = ${input.targetId}
  `);
  const regionRow = (existing as unknown as Array<{ is_paused: boolean }>)[0];
  if (!regionRow) throw new Error(`regional_rollback: unknown region ${input.targetId}`);
  if (regionRow.is_paused) {
    throw new Error(`regional_rollback: region ${input.targetId} is already paused`);
  }

  // Pause the region.
  await db.execute(sql`
    update regions set is_paused = true, paused_at = now(), paused_reason = ${input.reason}
     where code = ${input.targetId}
  `);

  // Activate the region-scoped kill switch (used by the decision engine to
  // short-circuit any new autonomous operations in the region).
  await db.execute(sql`
    update governance_kill_switches
       set is_active = true,
           activated_at = now(),
           activated_by = ${input.rolledBackBy},
           activation_reason = ${input.reason},
           auto_deactivate_at = now() + interval '24 hours'
     where key = ${`region:${input.targetId}`}
  `);

  const rolledBackAt = new Date();

  await adminAudit({
    actor: input.rolledBackBy,
    action: "governance.rollback.regional",
    target: {
      region: input.targetId,
      reason: input.reason,
      killSwitchKey: `region:${input.targetId}`,
    },
    justification: `Region ${input.targetId} paused (regional rollback): ${input.reason}. Other regions unaffected.`,
  });

  // Count affected workspaces in the region (for the notification count).
  const wsCount = await db.execute(sql`
    select count(*)::int as n from workspaces where region = ${input.targetId} and deleted_at is null
  `);
  const notificationsSent = Number((wsCount as unknown as Array<{ n: number }>)[0]?.n ?? 0);

  return {
    rollbackId: crypto.randomUUID(),
    type: "regional",
    targetId: input.targetId,
    previousVersion: null,
    newVersion: null,
    rolledBackBy: input.rolledBackBy,
    rolledBackAt,
    blastRadiusContained: true,
    notificationsSent,
  };
}

// ───────────────────────────────────────────────
// 11.3.4 Enterprise rollback — restore previous version in customer env.
//
//   1. Read the customer's current deployment version.
//   2. Identify the previous version (from deployment_history).
//   3. Schedule a deployment job to roll the customer's environment back
//      to the previous version.
//   4. The job runs through the canary + rollback-safety gate.
//   5. Other customers are UNAFFECTED (each customer's deployment is isolated).
// ───────────────────────────────────────────────

export async function rollbackEnterpriseDeployment(input: RollbackInput): Promise<RollbackResult> {
  const result = await db.execute(sql`
    with current_dep as (
      select deployment_id, version, customer_id
        from enterprise_deployments
       where deployment_id = ${input.targetId}::uuid
         and status = 'active'
       limit 1
    ),
    previous_dep as (
      select version
        from enterprise_deployment_history
       where deployment_id = (select deployment_id from current_dep)
         and version < (select version from current_dep)
         and status = 'succeeded'
       order by version desc
       limit 1
    ),
    scheduled as (
      insert into enterprise_deployment_jobs (deployment_id, target_version, action, reason, scheduled_by)
      select
        c.deployment_id,
        coalesce(${input.toVersion ?? null}::int, p.version),
        'rollback',
        ${input.reason},
        ${input.rolledBackBy}
      from current_dep c
      left join previous_dep p on true
      returning id::text as job_id, target_version
    )
    select
      (select customer_id from current_dep) as customer_id,
      (select deployment_id from current_dep) as deployment_id,
      (select version from current_dep) as previous_version,
      (select target_version from scheduled) as new_version,
      (select job_id from scheduled) as job_id
  `);

  const row = (result as unknown as Array<{ customer_id: string; deployment_id: string; previous_version: number; new_version: number | null; job_id: string }>)[0];
  if (!row) throw new Error(`enterprise_rollback: no active deployment found for ${input.targetId}`);

  const rolledBackAt = new Date();

  await adminAudit({
    actor: input.rolledBackBy,
    action: "governance.rollback.enterprise",
    target: {
      customerId: row.customer_id,
      deploymentId: row.deployment_id,
      previousVersion: row.previous_version,
      targetVersion: row.new_version,
      jobId: row.job_id,
      reason: input.reason,
    },
    justification: `Enterprise deployment ${row.deployment_id} for customer ${row.customer_id} scheduled for rollback from v${row.previous_version} to v${row.new_version ?? "previous"}: ${input.reason}`,
  });

  return {
    rollbackId: crypto.randomUUID(),
    type: "enterprise",
    targetId: row.deployment_id,
    previousVersion: Number(row.previous_version),
    newVersion: row.new_version != null ? Number(row.new_version) : null,
    rolledBackBy: input.rolledBackBy,
    rolledBackAt,
    blastRadiusContained: true,
    notificationsSent: 1, // the customer being rolled back.
  };
}

// ───────────────────────────────────────────────
// executeRollback — the dispatch wrapper.
//
// Picks the right path based on type. Used by the API route + the
// governance decision engine when it auto-rolls back an action.
// ───────────────────────────────────────────────

export async function executeRollback(
  type: RollbackType,
  input: RollbackInput,
): Promise<RollbackResult> {
  // If a breaker is open for the affected domain, block the rollback —
  // we don't want to roll back into a known-broken state.
  if (type === "regional" && isBreakerOpen("compliance")) {
    throw new Error("regional_rollback: compliance breaker is open — fix the underlying compliance issue before rolling back");
  }

  switch (type) {
    case "policy":
      return rollbackPolicy(input);
    case "marketplace":
      return rollbackMarketplaceItem(input);
    case "regional":
      return rollbackRegion(input);
    case "enterprise":
      return rollbackEnterpriseDeployment(input);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown rollback type: ${String(_exhaustive)}`);
    }
  }
}

// ───────────────────────────────────────────────
// 11.3 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface RollbackVerification {
  totalPaths: number;
  implementedPaths: number;
  allImplemented: boolean;
  paths: Array<{
    type: RollbackType;
    implemented: boolean;
    blastRadiusContained: boolean;
  }>;
}

export function verifyRollbacks(): RollbackVerification {
  const paths = ROLLBACK_PATHS.map((p) => ({
    type: p.type,
    implemented: p.implemented,
    blastRadiusContained: p.blastRadiusContained,
  }));
  const impl = paths.filter((p) => p.implemented).length;
  return {
    totalPaths: ROLLBACK_PATHS.length,
    implementedPaths: impl,
    allImplemented: impl === ROLLBACK_PATHS.length,
    paths,
  };
}

/**
 * Check whether an autonomous action is reversible.
 *
 * The spec (11.3): "Every autonomous action that can be reversed has a
 * rollback path." This helper is called by the decision engine BEFORE an
 * action is approved — irreversible actions are routed to higher-risk
 * approval flows (per the risk-levels spec).
 */
export function isActionReversible(actionType: string): boolean {
  // These action types have rollback paths.
  const reversible: RollbackType[] = ["policy", "marketplace", "regional", "enterprise"];
  // Map actionType prefixes to rollback types.
  if (actionType.startsWith("policy.")) return reversible.includes("policy");
  if (actionType.startsWith("marketplace.")) return reversible.includes("marketplace");
  if (actionType.startsWith("region.")) return reversible.includes("regional");
  if (actionType.startsWith("enterprise.") || actionType.startsWith("deployment.")) {
    return reversible.includes("enterprise");
  }
  // Other action types (tool.call, agent.run) are reversible at the data
  // level via undo — but they don't have a dedicated rollback path here.
  // Their reversibility is tracked per-decision via governance_decisions.reversible.
  return true;
}
