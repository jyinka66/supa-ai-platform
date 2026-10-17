// Billing gate — subscription enforcement + billing hooks.
//
// Feature gates checked at API layer AND UI layer:
//   - `gate(wsId, feature)` — throws ApiError(402) if the workspace's plan
//     doesn't include the feature. Called by API routes before the handler.
//   - `checkLimit(wsId, feature, current)` — for features with limits (e.g.
//     agents: free=3, pro=20, business=100, enterprise=custom). Throws 402
//     if the current count >= the limit.
//
// Grace & dunning flow:
//   1. Card fails → `handleInvoiceFailed`: billing_state='grace', lockout_at =
//      now + 7d. Features stay ON during grace (the user gets a chance to fix
//      the card). Owners notified.
//   2. After 7d grace → `applyLockouts` (nightly cron): billing_state='locked'.
//      The workspace becomes read-only (writes blocked by `requireActiveBilling`).
//   3. After 60d locked → downgrade to 'free' (data intact — no purge, just
//      plan downgrade). The user can upgrade again to regain features.
//
// The 60-day data preservation window is the safety net: even if the user
// abandons the workspace, the data isn't purged for 60 days (gives them
// time to recover the account or export data). After 60d locked, the
// downgrade to free keeps the data (free plan just restricts features).

import { db } from "@supa/db";
import { workspaces, memberships, agents } from "@supa/db/schema";
import { eq, and, sql, isNotNull } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Plan = "free" | "pro" | "business" | "enterprise";
export type BillingState = "active" | "grace" | "locked" | "canceled";

export interface PlanGate {
  /** The feature name (e.g. "sso_saml", "agents"). */
  feature: string;
  /** Plans that include this feature. If set, the workspace's plan must be in this list. */
  plans?: Plan[];
  /** If true, all plans include this feature (but with different limits). */
  all?: boolean;
  /** Per-plan limits (e.g. { free: 3, pro: 20 }). "custom" = unlimited. */
  limits?: Partial<Record<Plan, number | "custom">>;
  /** Per-plan minimum values (e.g. audit_retention_y: { business: 1, enterprise: 10 } years). */
  min?: Partial<Record<Plan, number>>;
}

export interface BillingStateResult {
  billingState: BillingState;
  lockoutAt: Date | null;
  downgradeAt: Date | null;
  plan: Plan;
}

// ───────────────────────────────────────────────
// PLAN_GATES — the feature → plan requirements table
// ───────────────────────────────────────────────

export const PLAN_GATES: PlanGate[] = [
  { feature: "sso_saml", plans: ["business", "enterprise"] },
  { feature: "scim", plans: ["business", "enterprise"] },
  { feature: "domain_auto_join", plans: ["enterprise"] },
  { feature: "audit_retention_y", min: { business: 1, enterprise: 10 } },
  { feature: "data_residency", plans: ["enterprise"] },
  { feature: "legal_hold", plans: ["enterprise"] },
  { feature: "api_access", plans: ["business", "enterprise"] },
  { feature: "agents", all: true, limits: { free: 3, pro: 20, business: 100, enterprise: "custom" } },
];

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const GRACE_DAYS = 7;
const LOCKED_DOWNGRADE_DAYS = 60;

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status + optional extra. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

/** Append to the enterprise audit log. */
async function audit(
  wsId: string,
  actorType: "user" | "system",
  actorId: string,
  action: string,
  target?: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${actorType},
      ${actorId},
      ${action},
      ${target ?? null}::jsonb,
      null::inet,
      null::text
    )
  `);
}

/** Get the workspace's plan. */
export async function getPlan(wsId: string): Promise<Plan> {
  const rows = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  return (rows[0]?.plan as Plan) ?? "free";
}

/**
 * Get the workspace's billing state (active/grace/locked/canceled) + key dates.
 * Uses the dedicated `billing_state` / `lockout_at` / `downgrade_at` columns
 * (migration 0031) for query performance. The `billing` JSONB column (migration
 * 0029) is kept for provider-specific metadata.
 */
export async function getBillingState(wsId: string): Promise<BillingStateResult> {
  const rows = await db
    .select({
      plan: workspaces.plan,
      billingState: workspaces.billingState,
      lockoutAt: workspaces.lockoutAt,
      downgradeAt: workspaces.downgradeAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  const ws = rows[0];
  if (!ws) throw new ApiError("workspace_not_found", 404);

  return {
    billingState: (ws.billingState as BillingState) ?? "active",
    lockoutAt: ws.lockoutAt ?? null,
    downgradeAt: ws.downgradeAt ?? null,
    plan: (ws.plan as Plan) ?? "free",
  };
}

/** Notify workspace owners (via the notify matrix). */
async function notifyOwners(wsId: string, kind: string, data?: Record<string, unknown>): Promise<void> {
  // Find all owners of the workspace.
  const owners = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.role, "owner"),
        eq(memberships.status, "active"),
      ),
    );

  // The real impl uses @supa/agents/platform notify.send. For now, stub.
  for (const owner of owners) {
    console.log(`[notify] ${kind} → user ${owner.userId} (ws ${wsId})`, data);
  }
}

// ───────────────────────────────────────────────
// gate — feature gate check (API + UI layer)
// ───────────────────────────────────────────────

/**
 * Check if the workspace's plan includes a feature. Throws ApiError(402) if not.
 *
 * Called by API routes before the handler:
 *   ```
 *   await gate(wsId, "sso_saml");
 *   // ... route logic ...
 *   ```
 *
 * Also called by the UI layer (via a server component) to show/hide features.
 *
 * For features with `plans`: the workspace's plan must be in the list.
 * For features with `all: true`: all plans include the feature (but with
 * different limits — use `checkLimit` for the count check).
 * For features with `min`: the workspace's plan must have a minimum value
 * (e.g. audit_retention_y: business=1, enterprise=10 years). If the plan
 * isn't in the min map, the feature is not available.
 */
export async function gate(wsId: string, feature: string): Promise<void> {
  const plan = await getPlan(wsId);
  const g = PLAN_GATES.find((x) => x.feature === feature);
  if (!g) return; // No gate defined → feature is available to all.

  // Plans check.
  if (g.plans && !g.plans.includes(plan)) {
    throw new ApiError("plan_required", 402, { feature, requiredPlans: g.plans, currentPlan: plan });
  }

  // Min check (the plan must be in the min map).
  if (g.min && g.min[plan] === undefined) {
    throw new ApiError("plan_required", 402, { feature, requiredPlans: Object.keys(g.min) as Plan[], currentPlan: plan });
  }
}

/**
 * Check a feature limit (e.g. agents: free=3, pro=20). Throws ApiError(402)
 * if the current count >= the plan's limit.
 *
 * For "custom" limits (enterprise): unlimited (no check).
 *
 * Usage:
 *   ```
 *   await gate(wsId, "agents");          // all plans have agents
 *   const count = await countAgents(wsId);
 *   await checkLimit(wsId, "agents", count);  // but with limits
 *   ```
 */
export async function checkLimit(
  wsId: string,
  feature: string,
  currentCount: number,
): Promise<void> {
  const plan = await getPlan(wsId);
  const g = PLAN_GATES.find((x) => x.feature === feature);
  if (!g?.limits) return;

  const limit = g.limits[plan];
  if (limit === undefined) {
    // No limit defined for this plan → feature not available (gate would have caught it).
    return;
  }
  if (limit === "custom") {
    // Unlimited (enterprise).
    return;
  }
  if (typeof limit === "number" && currentCount >= limit) {
    throw new ApiError("limit_exceeded", 402, {
      feature,
      plan,
      limit,
      current: currentCount,
    });
  }
}

/**
 * Count the active agents for a workspace (for the `agents` feature limit).
 */
export async function countAgents(wsId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, wsId as any),
        sql`${agents.status} not in ('killed')`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

// ───────────────────────────────────────────────
// requireActiveBilling — block writes if locked
// ───────────────────────────────────────────────

/**
 * Require that the workspace's billing is active (not locked). Throws 402 if
 * the workspace is in `billing_state='locked'`.
 *
 * Called by write API routes (POST/PUT/DELETE) to enforce the read-only
 * lockout during billing lock. Read routes (GET) don't call this — locked
 * workspaces can still be read (the user can view + export their data).
 */
export async function requireActiveBilling(wsId: string): Promise<void> {
  const state = await getBillingState(wsId);
  if (state.billingState === "locked") {
    throw new ApiError("workspace_locked", 402, {
      billingState: state.billingState,
      downgradeAt: state.downgradeAt?.toISOString(),
    });
  }
}

// ───────────────────────────────────────────────
// Dunning — grace, lockout, downgrade
// ───────────────────────────────────────────────

/**
 * Handle an invoice failed event (from the billing provider's webhook).
 * Sets `billing_state='grace'` + `lockout_at = now + 7d`. Features stay ON
 * during grace (the user gets a chance to fix the card). Owners notified.
 *
 * The `billing` JSONB column is updated with `{ state, lockoutAt, downgradeAt }`.
 */
export async function handleInvoiceFailed(wsId: string): Promise<void> {
  const lockoutAt = new Date(Date.now() + GRACE_DAYS * 86400000);

  await db
    .update(workspaces)
    .set({
      billingState: "grace",
      lockoutAt,
    })
    .where(eq(workspaces.id, wsId as any));

  await notifyOwners(wsId, "billing.grace_started", { lockoutAt: lockoutAt.toISOString() });

  await audit(wsId, "system", "billing-webhook", "billing.grace.started", {
    lockoutAt: lockoutAt.toISOString(),
  });
}

/**
 * Handle an invoice paid event (from the billing provider's webhook).
 * Clears the billing state (back to active). If the workspace was locked,
 * it's unlocked (writes allowed again).
 */
export async function handleInvoicePaid(wsId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({
      billingState: "active",
      lockoutAt: null,
      downgradeAt: null,
    })
    .where(eq(workspaces.id, wsId as any));

  await notifyOwners(wsId, "billing.recovered");

  await audit(wsId, "system", "billing-webhook", "billing.recovered", {});
}

/**
 * Nightly job: apply lockouts. Finds workspaces in `billing_state='grace'`
 * where `lockout_at <= now()` and transitions them to `billing_state='locked'`.
 * Sets `downgrade_at = now + 60d` (the 60-day data preservation window).
 *
 * Locked workspaces are read-only (writes blocked by `requireActiveBilling`).
 * After 60d locked, `downgradeLockedWorkspaces` downgrades to free.
 */
export async function applyLockouts(): Promise<{ locked: number }> {
  // Find workspaces in grace past their lockout_at (indexed column).
  const expiredGrace = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.billingState, "grace"),
        sql`${workspaces.lockoutAt} <= now()`,
      ),
    );

  const downgradeAt = new Date(Date.now() + LOCKED_DOWNGRADE_DAYS * 86400000);

  for (const ws of expiredGrace) {
    await db
      .update(workspaces)
      .set({
        billingState: "locked",
        downgradeAt,
      })
      .where(eq(workspaces.id, ws.id as any));

    await notifyOwners(ws.id as string, "billing.locked", {
      downgradeAt: downgradeAt.toISOString(),
    });

    await audit(ws.id as string, "system", "billing-cron", "billing.locked", {
      downgradeAt: downgradeAt.toISOString(),
    });
  }

  return { locked: expiredGrace.length };
}

/**
 * Nightly job: downgrade locked workspaces past their 60d window to 'free'.
 * Data is NOT purged — the plan just downgrades (features restricted to free
 * tier limits). The user can upgrade again to regain features.
 *
 * After downgrade, the billing state is cleared (back to active, on the free
 * plan). The data is intact.
 */
export async function downgradeLockedWorkspaces(): Promise<{ downgraded: number }> {
  // Find locked workspaces past their downgrade_at (indexed column).
  const expiredLocked = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.billingState, "locked"),
        sql`${workspaces.downgradeAt} <= now()`,
      ),
    );

  for (const ws of expiredLocked) {
    // Downgrade to free + clear billing state.
    await db
      .update(workspaces)
      .set({
        plan: "free",
        billingState: "active",
        lockoutAt: null,
        downgradeAt: null,
      })
      .where(eq(workspaces.id, ws.id as any));

    await notifyOwners(ws.id as string, "billing.downgraded", { newPlan: "free" });

    await audit(ws.id as string, "system", "billing-cron", "billing.downgraded", {
      newPlan: "free",
      dataPreserved: true,
    });
  }

  return { downgraded: expiredLocked.length };
}

// ───────────────────────────────────────────────
// updatePlan — upgrade/downgrade (from billing provider)
// ───────────────────────────────────────────────

/**
 * Update the workspace's plan (from the billing provider's webhook —
 * subscription created/updated). Clears any billing state (the plan change
 * is immediate; no grace/lockout).
 */
export async function updatePlan(wsId: string, newPlan: Plan): Promise<void> {
  await db
    .update(workspaces)
    .set({
      plan: newPlan,
      billingState: "active",
      lockoutAt: null,
      downgradeAt: null,
    })
    .where(eq(workspaces.id, wsId as any));

  await notifyOwners(wsId, "plan.updated", { newPlan });

  await audit(wsId, "system", "billing-webhook", "plan.updated", { newPlan });
}
