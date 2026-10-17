// PSP (Payment Service Provider) webhook handler — Stripe-compatible.
//
// Billing state machine: trialing → active → past_due → locked → purged
//                                          ↘ canceled (active until period end) ↗
//
// Transitions driven by webhook events from the PSP (Stripe), NEVER by client
// claims. The client can't change billing state — only the PSP can (via
// signed webhook events).
//
// The webhook:
//   1. Receives the raw body (NOT parsed JSON — the signature is over the
//      raw bytes, so the body must be preserved before parsing).
//   2. Verifies the PSP signature (Stripe-Signature header — HMAC-SHA256
//      with the webhook signing secret).
//   3. Deduplicates by event id (idempotency — if the PSP retries, the same
//      event isn't processed twice).
//   4. Dispatches to the state machine handler based on event type.
//   5. Returns 200 (always — even on errors, to prevent PSP retries for
//      unrecoverable failures. Errors are logged + alerted).
//
// Event types (strict allowlist):
//   invoice.payment_failed    → markPastDue (grace period starts).
//   invoice.payment_failed_2  → lockWorkspace (grace expired → read-only).
//   invoice.paid              → reactivate (back to active).
//   subscription.deleted      → schedulePurge (cancel → 30d → purge).
//   customer.subscription.updated → updatePlan (upgrade/downgrade).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { workspaces } from "@supa/db/schema";
import { eq, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type BillingState =
  | "trialing"
  | "active"
  | "past_due"
  | "locked"
  | "purged"
  | "canceled";

export interface PspEvent {
  id: string; // event id (for dedup).
  type: string; // event type (strict allowlist).
  data: {
    object: {
      customer?: string; // Stripe customer id.
      subscription?: string; // Stripe subscription id.
      // Custom metadata: the workspace id (set when the subscription was created).
      metadata?: {
        workspace_id?: string;
      };
    };
  };
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const GRACE_DAYS = 7; // past_due → grace period (features stay on).
const LOCKED_DOWNGRADE_DAYS = 60; // locked → 60d → downgrade to free.
const PURGE_DELAY_DAYS = 30; // canceled → 30d → purge.

/** Strict allowlist of PSP event types we handle. */
const ALLOWED_EVENT_TYPES = new Set([
  "invoice.payment_failed",
  "invoice.payment_failed_2",
  "invoice.paid",
  "subscription.deleted",
  "customer.subscription.updated",
]);

// ───────────────────────────────────────────────
// Event dedup (idempotency)
// ───────────────────────────────────────────────

const processedEvents = new Map<string, number>(); // eventId → processedAt (epoch ms).
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h (Stripe retries up to 3 days, but 24h is sufficient — events are processed within minutes).

/**
 * Deduplicate by event id. If the event was already processed (within 24h),
 * return false (skip). Otherwise, mark as processed + return true (process).
 *
 * In production, this would be a DB table or Redis set (survives restarts).
 * The in-memory map is sufficient for single-node deployments.
 */
async function dedupe(eventId: string): Promise<boolean> {
  const now = Date.now();

  // Periodic cleanup (prevent unbounded growth).
  if (processedEvents.size > 10000) {
    for (const [id, ts] of processedEvents) {
      if (now - ts > DEDUP_TTL_MS) {
        processedEvents.delete(id);
      }
    }
  }

  if (processedEvents.has(eventId)) {
    return false; // already processed.
  }
  processedEvents.set(eventId, now);
  return true;
}

// ───────────────────────────────────────────────
// PSP signature verification (Stripe-compatible)
// ───────────────────────────────────────────────

/**
 * Verify the Stripe webhook signature.
 *
 * Stripe-Signature header format: `t=<timestamp>, v1=<signature>`.
 * The signature is HMAC-SHA256 of `<timestamp>.<raw_body>` using the
 * webhook signing secret.
 *
 * The timestamp must be within 5 minutes (replay defense — Stripe sends
 * events in real-time; a stale timestamp is a replayed event).
 */
export function verifyPspSignature(
  signatureHeader: string,
  rawBody: string,
  secret: string,
  maxAgeSeconds: number = 300,
): boolean {
  // Parse: t=<timestamp>, v1=<signature>.
  const parts = signatureHeader.split(",");
  let timestamp: string | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value ?? null;
    if (key === "v1") signature = value ?? null;
  }

  if (!timestamp || !signature) return false;

  // Check timestamp freshness.
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxAgeSeconds) return false;

  // Compute expected signature: HMAC-SHA256(secret, timestamp + "." + rawBody).
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  // Constant-time compare.
  if (expectedSignature.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// State machine transitions
// ───────────────────────────────────────────────

/**
 * Extract the workspace id from the PSP event.
 * The workspace id is in the subscription/customer metadata (set when the
 * subscription was created via the billing portal).
 */
function extractWorkspaceId(event: PspEvent): string | null {
  return event.data?.object?.metadata?.workspace_id ?? null;
}

/**
 * markPastDue — invoice.payment_failed.
 *
 * Sets billing_state='grace', lockout_at = now + 7d. Features stay ON during
 * grace (the user gets a chance to fix the card).
 */
async function markPastDue(wsId: string): Promise<void> {
  const lockoutAt = new Date(Date.now() + GRACE_DAYS * 86400000);
  await db
    .update(workspaces)
    .set({
      billingState: "past_due",
      lockoutAt,
    })
    .where(eq(workspaces.id, wsId as any));

  await auditBilling(wsId, "billing.marked_past_due", { lockoutAt: lockoutAt.toISOString() });
}

/**
 * lockWorkspace — invoice.payment_failed_2 (second failure = grace expired).
 *
 * Sets billing_state='locked'. The workspace becomes read-only (writes blocked
 * by requireActiveBilling). downgrade_at = now + 60d.
 */
async function lockWorkspace(wsId: string): Promise<void> {
  const downgradeAt = new Date(Date.now() + LOCKED_DOWNGRADE_DAYS * 86400000);
  await db
    .update(workspaces)
    .set({
      billingState: "locked",
      downgradeAt,
    })
    .where(eq(workspaces.id, wsId as any));

  await auditBilling(wsId, "billing.locked", { downgradeAt: downgradeAt.toISOString() });
}

/**
 * reactivate — invoice.paid.
 *
 * Clears the billing state (back to active). If the workspace was locked,
 * it's unlocked (writes allowed again). Clears lockout_at + downgrade_at.
 */
async function reactivate(wsId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({
      billingState: "active",
      lockoutAt: null,
      downgradeAt: null,
    })
    .where(eq(workspaces.id, wsId as any));

  await auditBilling(wsId, "billing.reactivated", {});
}

/**
 * schedulePurge — subscription.deleted (canceled).
 *
 * Sets billing_state='canceled', purge_at = now + 30d. The workspace is
 * soft-deleted + scheduled for hard purge in 30 days. The user can cancel
 * the deletion within the 30-day window (cancelWorkspaceDeletion).
 */
async function schedulePurge(wsId: string): Promise<void> {
  const purgeAt = new Date(Date.now() + PURGE_DELAY_DAYS * 86400000);
  await db
    .update(workspaces)
    .set({
      billingState: "canceled",
      deletedAt: new Date(),
      purgeAt,
    })
    .where(eq(workspaces.id, wsId as any));

  await auditBilling(wsId, "billing.scheduled_purge", {
    purgeAt: purgeAt.toISOString(),
    purgeDelayDays: PURGE_DELAY_DAYS,
  });
}

/**
 * updatePlan — customer.subscription.updated.
 *
 * Updates the workspace's plan based on the subscription's price/tier.
 * Clears any billing state (the plan change is immediate — no grace/lockout).
 */
async function updatePlan(wsId: string, newPlan: string): Promise<void> {
  await db
    .update(workspaces)
    .set({
      plan: newPlan,
      billingState: "active",
      lockoutAt: null,
      downgradeAt: null,
    })
    .where(eq(workspaces.id, wsId as any));

  await auditBilling(wsId, "billing.plan_updated", { newPlan });
}

// ───────────────────────────────────────────────
// Audit helper
// ───────────────────────────────────────────────

async function auditBilling(wsId: string, action: string, target: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'system', 'psp-webhook', ${action},
      ${target}::jsonb, null::inet, null::text
    )
  `);
}

// ───────────────────────────────────────────────
// handlePspWebhook — the main handler
// ───────────────────────────────────────────────

/**
 * Handle a PSP (Stripe) webhook event.
 *
 * Called by the webhook route (POST /v1/billing/webhook). The route:
 *   1. Reads the raw body (not parsed JSON — signature is over raw bytes).
 *   2. Verifies the Stripe signature.
 *   3. Parses the JSON body.
 *   4. Deduplicates by event id.
 *   5. Dispatches to the state machine handler.
 *
 * Returns 200 on success (or on dedup skip — the PSP doesn't need to retry).
 * Returns 400 on signature verification failure (the PSP should not retry
 * — the signature is wrong, retrying won't help).
 * Returns 200 on unknown event type (logged, but not retried — we don't
 * handle every Stripe event type, just the billing state transitions).
 *
 * The handler NEVER throws to the caller — all errors are caught + logged +
 * the response is 200 (prevents PSP retries for unrecoverable failures).
 */
export async function handlePspWebhook(
  rawBody: string,
  signatureHeader: string,
): Promise<{ status: number; message: string }> {
  // 1. Verify signature.
  const secret = process.env.PSP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[billing] PSP_WEBHOOK_SECRET not set — webhook rejected.");
    return { status: 500, message: "webhook_secret_not_configured" };
  }

  if (!verifyPspSignature(signatureHeader, rawBody, secret)) {
    return { status: 400, message: "invalid_signature" };
  }

  // 2. Parse the body.
  let event: PspEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "invalid_json" };
  }

  // 3. Deduplicate by event id.
  const shouldProcess = await dedupe(event.id);
  if (!shouldProcess) {
    return { status: 200, message: "duplicate_event" };
  }

  // 4. Check event type allowlist.
  if (!ALLOWED_EVENT_TYPES.has(event.type)) {
    // Unknown event type — log + 200 (don't retry).
    console.log(`[billing] unhandled PSP event type: ${event.type}`);
    return { status: 200, message: "unhandled_event_type" };
  }

  // 5. Extract workspace id.
  const wsId = extractWorkspaceId(event);
  if (!wsId) {
    console.error(`[billing] PSP event ${event.id} has no workspace_id in metadata`);
    return { status: 200, message: "no_workspace_id" };
  }

  // 6. Dispatch to state machine handler.
  try {
    switch (event.type) {
      case "invoice.payment_failed":
        await markPastDue(wsId);
        break;
      case "invoice.payment_failed_2":
        await lockWorkspace(wsId);
        break;
      case "invoice.paid":
        await reactivate(wsId);
        break;
      case "subscription.deleted":
        await schedulePurge(wsId);
        break;
      case "customer.subscription.updated":
        // The plan is derived from the subscription's price/tier — the event
        // payload carries this. For now, use a stub (the real impl would
        // parse the price id → plan mapping).
        await updatePlan(wsId, "pro"); // stub — real impl parses from event.
        break;
    }
  } catch (err) {
    // Log + 200 (don't retry — the error is likely a DB issue that a retry
    // won't fix. Alerting should catch this.)
    console.error(`[billing] PSP event ${event.id} handler error:`, err);
    return { status: 200, message: "handler_error" };
  }

  return { status: 200, message: "ok" };
}
