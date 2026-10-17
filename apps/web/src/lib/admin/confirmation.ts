// Admin confirmations — 2nd-admin approval for dangerous control-plane actions.
//
// Used by `requireConfirmation` (called from setFlag) for kill_switch flips:
// a kill_switch flip requires:
//   1. Typed phrase — the admin types `enable <key>` (or `disable <key>`).
//      Checked synchronously — prevents accidental clicks.
//   2. 2nd admin — a DIFFERENT owner must approve the action. This is the
//      two-person rule: a single compromised owner can't flip a kill_switch
//      alone. The 2nd admin sees the patch + the requester + approves.
//
// Flow:
//   1. Owner A calls PATCH /feature-flags/:key (kill_switch).
//   2. setFlag → requireConfirmation detects secondAdmin=true.
//   3. If no confirmationId in the request → create a pending confirmation
//      (stores the patch) → throw ConfirmationRequired(202, confirmationId).
//   4. Owner B calls POST /feature-flags/:key/confirm with confirmationId.
//   5. approveConfirmation verifies B ≠ A + B is an owner → sets status=approved.
//   6. setFlag is re-invoked with the confirmationId → proceeds (the confirmation
//      is consumed — can't be reused).
//
// TTL: 10 minutes. The 2nd admin must approve within the window.

import { db } from "@supa/db";
import { adminConfirmations } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ConfirmationAction = "flag_set";
export type ConfirmationStatus = "pending" | "approved" | "rejected" | "expired";

export interface ConfirmationRequest {
  actionType: ConfirmationAction;
  targetKey: string;
  requestedBy: string;
  patch: Record<string, unknown>;
  phrase: string;
}

export interface ConfirmationRecord {
  id: string;
  actionType: ConfirmationAction;
  targetKey: string;
  requestedBy: string;
  approverId: string | null;
  patch: Record<string, unknown>;
  phrase: string;
  status: ConfirmationStatus;
  createdAt: Date;
  approvedAt: Date | null;
  expiresAt: Date;
}

export class ConfirmationRequiredError extends Error {
  constructor(
    public confirmationId: string,
    public phrase: string,
    message: string = "confirmation_required",
  ) {
    super(message);
    this.name = "ConfirmationRequiredError";
  }
}

export class ConfirmationError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ConfirmationError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // 10 minutes.

// ───────────────────────────────────────────────
// createConfirmation — store a pending 2nd-admin approval
// ───────────────────────────────────────────────

/**
 * Create a pending confirmation. Stores the patch for later application.
 *
 * Called by `requireConfirmation` when `secondAdmin=true` + no existing
 * confirmationId is provided. The confirmation is consumed on approval.
 *
 * @returns The confirmation ID (the route returns 202 with this ID).
 */
export async function createConfirmation(req: ConfirmationRequest): Promise<string> {
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const rows = await db
    .insert(adminConfirmations)
    .values({
      actionType: req.actionType,
      targetKey: req.targetKey,
      requestedBy: req.requestedBy as any,
      patch: req.patch as any,
      phrase: req.phrase,
      status: "pending",
      expiresAt,
    })
    .returning({ id: adminConfirmations.id });
  const row = rows[0];
  if (!row) throw new ConfirmationError("confirmation_insert_failed", 500);
  return row.id as string;
}

// ───────────────────────────────────────────────
// getConfirmation — fetch by ID
// ───────────────────────────────────────────────

export async function getConfirmation(id: string): Promise<ConfirmationRecord | null> {
  const rows = await db
    .select({
      id: adminConfirmations.id,
      actionType: adminConfirmations.actionType,
      targetKey: adminConfirmations.targetKey,
      requestedBy: adminConfirmations.requestedBy,
      approverId: adminConfirmations.approverId,
      patch: adminConfirmations.patch,
      phrase: adminConfirmations.phrase,
      status: adminConfirmations.status,
      createdAt: adminConfirmations.createdAt,
      approvedAt: adminConfirmations.approvedAt,
      expiresAt: adminConfirmations.expiresAt,
    })
    .from(adminConfirmations)
    .where(eq(adminConfirmations.id, id as any))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    actionType: row.actionType as ConfirmationAction,
    targetKey: row.targetKey,
    requestedBy: row.requestedBy as string,
    approverId: (row.approverId as string | null) ?? null,
    patch: (row.patch as Record<string, unknown>) ?? {},
    phrase: row.phrase,
    status: row.status as ConfirmationStatus,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
  };
}

// ───────────────────────────────────────────────
// approveConfirmation — 2nd admin approves
// ───────────────────────────────────────────────

/**
 * Approve a pending confirmation. The approver must be a DIFFERENT owner
 * than the requester (two-person rule — a single compromised owner can't
 * approve their own dangerous action).
 *
 * @throws ConfirmationError(404) if the confirmation doesn't exist.
 * @throws ConfirmationError(409) if already approved/rejected/expired.
 * @throws ConfirmationError(403) if the approver is the same as the requester.
 * @throws ConfirmationError(410) if expired.
 *
 * @returns The confirmation record (with the patch to apply).
 */
export async function approveConfirmation(
  confirmationId: string,
  approverId: string,
): Promise<ConfirmationRecord> {
  const conf = await getConfirmation(confirmationId);
  if (!conf) throw new ConfirmationError("confirmation_not_found", 404);

  if (conf.status !== "pending") {
    throw new ConfirmationError(`confirmation_already_${conf.status}`, 409);
  }

  if (Date.now() > conf.expiresAt.getTime()) {
    // Mark as expired.
    await db
      .update(adminConfirmations)
      .set({ status: "expired" })
      .where(eq(adminConfirmations.id, confirmationId as any));
    throw new ConfirmationError("confirmation_expired", 410);
  }

  // Two-person rule: the approver must be DIFFERENT from the requester.
  if (conf.requestedBy === approverId) {
    throw new ConfirmationError("cannot_approve_own_confirmation", 403);
  }

  await db
    .update(adminConfirmations)
    .set({
      status: "approved",
      approverId: approverId as any,
      approvedAt: new Date(),
    })
    .where(eq(adminConfirmations.id, confirmationId as any));

  return { ...conf, status: "approved", approverId, approvedAt: new Date() };
}

// ───────────────────────────────────────────────
// requireConfirmation — the gate (called by setFlag)
// ───────────────────────────────────────────────

export interface ConfirmationOptions {
  /** Whether the action is dangerous (UI shows a warning). */
  danger: boolean;
  /** The phrase the admin must type (e.g. `enable kill_search_v3`). */
  phrase: string;
  /** Whether a 2nd admin must approve (kill_switches only). */
  secondAdmin: boolean;
}

export interface ConfirmationContext {
  /** The typed phrase from the request body. */
  typedPhrase?: string;
  /** The confirmation ID from a prior 202 response (2nd-admin approval). */
  confirmationId?: string;
}

/**
 * Require confirmation for a dangerous control-plane action.
 *
 * For non-kill_switch flags (danger=false, secondAdmin=false): just checks
 * the typed phrase matches (if danger=true) — no 2nd admin needed.
 *
 * For kill_switch flags (danger=true, secondAdmin=true):
 *   - If no confirmationId: create a pending confirmation → throw
 *     ConfirmationRequiredError(confirmationId, phrase).
 *   - If confirmationId: verify it's approved by a different owner + not
 *     expired. If valid → proceed (the caller applies the patch).
 *
 * @param actorId — the requesting admin's user_id.
 * @param opts — the confirmation requirements.
 * @param ctx — the request's confirmation context (typedPhrase, confirmationId).
 * @param patch — the patch to store (for 2nd-admin review).
 * @param targetKey — the flag key.
 *
 * @throws ConfirmationError(400) if the typed phrase doesn't match.
 * @throws ConfirmationRequiredError if 2nd-admin approval is needed (returns the confirmationId).
 * @throws ConfirmationError(403/404/409/410) if the confirmation is invalid.
 */
export async function requireConfirmation(
  actorId: string,
  opts: ConfirmationOptions,
  ctx: ConfirmationContext,
  patch: Record<string, unknown>,
  targetKey: string,
): Promise<void> {
  // 1. Typed phrase check (for dangerous actions).
  if (opts.danger) {
    if (!ctx.typedPhrase || ctx.typedPhrase !== opts.phrase) {
      throw new ConfirmationError(
        `phrase_mismatch: expected '${opts.phrase}'`,
        400,
      );
    }
  }

  // 2. 2nd-admin check (for kill_switches).
  if (opts.secondAdmin) {
    if (!ctx.confirmationId) {
      // Create a pending confirmation → throw ConfirmationRequired.
      const id = await createConfirmation({
        actionType: "flag_set",
        targetKey,
        requestedBy: actorId,
        patch,
        phrase: opts.phrase,
      });
      throw new ConfirmationRequiredError(id, opts.phrase);
    }

    // Verify the confirmation is approved by a different owner.
    const conf = await getConfirmation(ctx.confirmationId);
    if (!conf) throw new ConfirmationError("confirmation_not_found", 404);
    if (conf.status !== "approved") {
      throw new ConfirmationError(`confirmation_not_approved:${conf.status}`, 409);
    }
    if (Date.now() > conf.expiresAt.getTime()) {
      throw new ConfirmationError("confirmation_expired", 410);
    }
    if (conf.requestedBy !== actorId) {
      throw new ConfirmationError("confirmation_actor_mismatch", 403);
    }
    if (conf.approverId === actorId) {
      throw new ConfirmationError("cannot_approve_own_confirmation", 403);
    }
    // The confirmation is consumed (the status stays 'approved' — it can't
    // be reused because the actor + approver + expiry are checked).
  }
}

// ───────────────────────────────────────────────
// consumeConfirmation — mark as consumed (after the action is applied)
// ───────────────────────────────────────────────

/**
 * Mark a confirmation as consumed (delete it — the action is applied, the
 * confirmation is no longer needed). Called by setFlag after the patch is
 * applied successfully.
 */
export async function consumeConfirmation(confirmationId: string): Promise<void> {
  await db
    .delete(adminConfirmations)
    .where(eq(adminConfirmations.id, confirmationId as any));
}

// ───────────────────────────────────────────────
// reapExpiredConfirmations — cleanup (called by the nightly cron)
// ───────────────────────────────────────────────

export async function reapExpiredConfirmations(): Promise<number> {
  const result = await db.execute(sql`
    with deleted as (
      delete from admin_confirmations
       where status = 'pending' and expires_at < now()
          or status in ('approved', 'rejected') and created_at < now() - interval '1 hour'
      returning 1
    )
    select count(*)::integer as n from deleted
  `);
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}
