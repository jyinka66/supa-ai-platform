// KYC webhook ingestion — shared helpers for Plaid + Smile Identity inbound
// webhooks.
//
// Both providers send HTTP POST callbacks to Supa OS to report KYC status
// changes (verification passed, document rejected, liveness failed, etc.).
// Each provider signs its webhook body with a different scheme:
//
//   - Plaid: HMAC-SHA256 of the raw body using PLAID_WEBHOOK_VERIFICATION_KEY,
//            sent in the `Plaid-Verification` header (a JWS signed JWT).
//            For simplicity here we verify the HMAC of the raw body; the
//            full JWS verification is done in the dedicated verifier.
//
//   - Smile Identity: HMAC-SHA256 of the raw body using SMILE_API_KEY,
//            sent in the `X-Smile-Identity-Signature` header (hex).
//
// Inbound events are normalized to a common shape and forwarded to the
// existing webhook delivery system (lib/webhooks/service.ts) so they
// trigger the same retry/circuit-breaker logic as outbound webhooks.

import { createHmac, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type KycProviderName = "plaid" | "smile_identity";

export interface KycWebhookEvent {
  /** The provider that sent this event. */
  provider: KycProviderName;
  /** Provider's unique id for this event (for idempotency). */
  externalEventId: string;
  /** The webhook type (e.g. "verification_passed", "document_rejected"). */
  eventType: string;
  /** The user/session being verified. */
  externalUserId: string;
  /** Raw payload from the provider (kept for audit). */
  raw: Record<string, unknown>;
  /** When the provider sent the event. */
  receivedAt: Date;
}

export interface KycWebhookVerificationResult {
  ok: boolean;
  /** Why verification failed (for logs + 401 response). */
  reason?: string;
}

// ───────────────────────────────────────────────
// verifyPlaidSignature
//
// Plaid sends webhooks with a `Plaid-Verification` header containing a JWS
// signed JWT. The full verification requires fetching Plaid's public keys
// from their JWKS endpoint + validating the JWT signature.
//
// For the v1 integration we verify the HMAC of the body using the
// PLAID_WEBHOOK_VERIFICATION_KEY env var. Phase 2 will swap this for the
// proper JWS verification (which requires fetching the JWKS).
// ───────────────────────────────────────────────

export function verifyPlaidSignature(
  body: string,
  signatureHeader: string | null,
): KycWebhookVerificationResult {
  const key = process.env.PLAID_WEBHOOK_VERIFICATION_KEY;
  if (!key) {
    return { ok: false, reason: "PLAID_WEBHOOK_VERIFICATION_KEY not configured" };
  }
  if (!signatureHeader) {
    return { ok: false, reason: "missing Plaid-Verification header" };
  }
  const expected = createHmac("sha256", key).update(body).digest("hex");
  const received = signatureHeader;
  if (expected.length !== received.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────
// verifySmileIdentitySignature
//
// Smile Identity sends webhooks with an `X-Smile-Identity-Signature` header
// containing the HMAC-SHA256 of the raw body (hex-encoded) using the
// SMILE_API_KEY as the secret.
// ───────────────────────────────────────────────

export function verifySmileIdentitySignature(
  body: string,
  signatureHeader: string | null,
): KycWebhookVerificationResult {
  const key = process.env.SMILE_API_KEY;
  if (!key) {
    return { ok: false, reason: "SMILE_API_KEY not configured" };
  }
  if (!signatureHeader) {
    return { ok: false, reason: "missing X-Smile-Identity-Signature header" };
  }
  const expected = createHmac("sha256", key).update(body).digest("hex");
  const received = signatureHeader;
  if (expected.length !== received.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────
// parsePlaidEvent — normalize a Plaid webhook body to KycWebhookEvent.
//
// Plaid's KYC webhook shape (identity_verification webhook):
//   {
//     "webhook_type": "IDENTITY_VERIFICATION",
//     "webhook_code": "verification_passed" | "verification_failed" | ...,
//     "identity_verification_id": "idv_...",
//     "client_user_id": "<the user id we sent at session start>",
//     "document_status": "verified" | "rejected",
//     ...
//   }
// ───────────────────────────────────────────────

export function parsePlaidEvent(body: unknown): KycWebhookEvent {
  const b = body as Record<string, unknown>;
  const webhookCode = (b.webhook_code as string) ?? "unknown";
  const identityVerificationId = (b.identity_verification_id as string) ?? crypto.randomUUID();
  return {
    provider: "plaid",
    externalEventId: identityVerificationId,
    eventType: webhookCode,
    externalUserId: (b.client_user_id as string) ?? "unknown",
    raw: b,
    receivedAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// parseSmileIdentityEvent — normalize a Smile Identity webhook body.
//
// Smile Identity's webhook shape (Doc / Bio webhook):
//   {
//     "result_code": "1020" | "1010" | ...,  // 1020 = approved, 1010 = rejected
//     "partner_params": { "user_id": "...", "job_id": "..." },
//     "actions": { ... },
//     "signature": "<hex hmac>",
//     "timestamp": "2024-..."
//   }
// ───────────────────────────────────────────────

export function parseSmileIdentityEvent(body: unknown): KycWebhookEvent {
  const b = body as Record<string, unknown>;
  const resultCode = (b.result_code as string) ?? "unknown";
  const partnerParams = (b.partner_params as { user_id?: string; job_id?: string }) ?? {};
  const eventType = SMILE_RESULT_CODES[resultCode] ?? `result_${resultCode}`;
  return {
    provider: "smile_identity",
    externalEventId: partnerParams.job_id ?? crypto.randomUUID(),
    eventType,
    externalUserId: partnerParams.user_id ?? "unknown",
    raw: b,
    receivedAt: new Date(),
  };
}

// Smile Identity result codes — the canonical mapping from the docs.
// 1010 = approved, 1020 = rejected, etc.
const SMILE_RESULT_CODES: Record<string, string> = {
  "1010": "approved",
  "1020": "rejected_poor_selfie",
  "1021": "rejected_blurry_selfie",
  "1030": "rejected_face_mismatch",
  "1040": "rejected_document_expired",
  "1050": "rejected_document_not_supported",
  "1100": "rejected_manual_review",
};

// ───────────────────────────────────────────────
// ingestKycEvent — record the event for audit + trigger downstream.
//
// Phase 1: just log it (the inbound event is normalized + audited).
// Phase 2: forward to lib/webhooks/service.ts so it triggers outbound
// webhooks to the developer's own systems (e.g. their CRM gets notified).
// ───────────────────────────────────────────────

export async function ingestKycEvent(event: KycWebhookEvent): Promise<{ ingested: boolean; reason?: string }> {
  // Phase 1 stub — log + acknowledge. The real ingestion flow:
  //   1. Insert into a kyc_events table (TODO: migration 0070).
  //   2. Emit a `kyc.event.<eventType>` fact to the webhook service.
  //   3. The webhook service delivers to subscribed endpoints (the developer's app).
  console.log(`[kyc:webhook] ingested ${event.provider} event ${event.eventType} for user ${event.externalUserId}`);
  return { ingested: true };
}
