// Seat limit enforcement — plan-based seat caps.
//
//   checkSeatLimit(wsId) — throws ApiError(402) if the workspace is at or
//     above its plan's seat cap. Uses the `active_seat_count` security-definer
//     function (migration 0035) for the count.
//
// SEAT_CAPS per plan:
//   free: 5, pro: 50, business: 500, enterprise: Infinity (custom).
//
// The count includes BOTH active AND invited memberships (the function counts
// `status in ('active', 'invited')`). This means pending invites reserve a
// seat — a workspace can't exceed its cap by inviting more users than allowed,
// then having them all accept simultaneously.
//
// Called by the invite flow (before creating an invite) + the accept flow
// (re-checked at accept time — the cap may have changed since the invite
// was created).

import { db } from "@supa/db";
import { workspaces } from "@supa/db/schema";
import { eq, sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Plan = "free" | "pro" | "business" | "enterprise";

// ───────────────────────────────────────────────
// SEAT_CAPS — per-plan seat limits
// ───────────────────────────────────────────────

export const SEAT_CAPS: Record<Plan, number> = {
  free: 5,
  pro: 50,
  business: 500,
  enterprise: Infinity, // custom (no cap — enterprise manages seats externally).
};

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

/**
 * Get the workspace's plan.
 */
export async function getPlan(wsId: string): Promise<Plan> {
  const rows = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  return (rows[0]?.plan as Plan) ?? "free";
}

/**
 * Count active + invited seats for a workspace.
 * Uses the `active_seat_count` security-definer function (migration 0035).
 */
export async function countSeats(wsId: string): Promise<number> {
  const result = await db.execute(sql`
    select active_seat_count(${wsId}::uuid) as count
  `);
  const rows = result as unknown as { rows: { count: number }[] };
  return Number(rows.rows[0]?.count ?? 0);
}

// ───────────────────────────────────────────────
// checkSeatLimit — the gate
// ───────────────────────────────────────────────

/**
 * Check if the workspace is within its plan's seat cap. Throws ApiError(402)
 * if at or above the cap.
 *
 * The count includes active + invited memberships (pending invites reserve a
 * seat — prevents exceeding the cap by mass-inviting then accepting).
 *
 * Enterprise (Infinity) has no cap — seats are managed externally (the
 * billing provider's contract specifies the seat count; the workspace can
 * invite as many as the contract allows).
 *
 * USAGE:
 *   ```
 *   await checkSeatLimit(wsId);  // before creating an invite
 *   await checkSeatLimit(wsId);  // re-check at accept time (cap may have changed)
 *   ```
 */
export async function checkSeatLimit(wsId: string): Promise<void> {
  const [plan, seats] = await Promise.all([getPlan(wsId), countSeats(wsId)]);
  const cap = SEAT_CAPS[plan];

  if (cap !== Infinity && seats >= cap) {
    throw new ApiError("seat_limit", 402, {
      plan,
      cap,
      current: seats,
      message: `Workspace is at its ${plan} plan seat cap of ${cap}.`,
    });
  }
}
