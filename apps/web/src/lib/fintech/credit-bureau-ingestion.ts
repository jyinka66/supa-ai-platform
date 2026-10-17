// Credit bureau webhook ingestion — shared helpers for inbound bureau
// callbacks (credit report delivered, fraud alert raised, sanctions hit).
//
// All bureaus POST callbacks to /api/webhooks/credit-bureau with a bureau-
// specific signature. We verify the signature, parse the bureau-specific
// payload to a common shape, and ingest.
//
// Bureau-specific signature schemes:
//
//   - Experian: HMAC-SHA256 of the raw body using EXPERIAN_WEBHOOK_SECRET,
//            sent in the `X-Experian-Signature` header (base64).
//   - TransUnion: HMAC-SHA256 using TRANSUNION_WEBHOOK_SECRET, sent in
//            the `X-TransUnion-Signature` header (hex).
//   - Equifax: HMAC-SHA256 using EQUIFAX_WEBHOOK_SECRET, sent in the
//            `X-Equifax-Signature` header (hex).
//   - CRC Nigeria: HMAC-SHA1 using CRC_API_SECRET, sent in the
//            `X-CRC-Signature` header (hex). (SHA1 is legacy — CRC's API
//            still uses it; we use timingSafeEqual to compare.)
//   - Creditinfo: Bearer token in the Authorization header (shared secret).
//   - Metropol: HMAC-SHA256 using METROPOL_API_SECRET, sent in the
//            `X-Metropol-Signature` header (hex).
//
// The bureau's identity is encoded in the `X-Bureau` header (we set this
// when registering the webhook URL with the bureau). Each bureau's
// signature is verified against its own secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreditBureauId } from "@/lib/supa-os/fintech-primitives";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface BureauWebhookEvent {
  /** The bureau that sent this event. */
  bureau: CreditBureauId;
  /** Bureau's unique id for this report/event (for idempotency). */
  externalReportId: string;
  /** The event type (e.g. "credit_report_ready", "fraud_alert", "score_update"). */
  eventType: string;
  /** The subject of the credit check. */
  subjectId: string;
  /** The credit score (if the bureau returned one). */
  score: number | null;
  /** The score range the bureau uses (for normalization). */
  scoreRange: { min: number; max: number } | null;
  /** Risk tier the bureau assigned (bureau-specific vocabulary). */
  riskTier: string | null;
  /** Raw payload from the bureau (kept for audit). */
  raw: Record<string, unknown>;
  /** When the bureau sent the event. */
  receivedAt: Date;
}

export interface BureauWebhookVerificationResult {
  ok: boolean;
  reason?: string;
}

// ───────────────────────────────────────────────
// Bureau-specific signature verification.
//
// Each function reads its own env var + compares against the supplied
// header. All comparisons use timingSafeEqual (constant-time, prevents
// timing attacks).
// ───────────────────────────────────────────────

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function safeEqualBase64(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "base64"), Buffer.from(b, "base64"));
  } catch {
    return false;
  }
}

export function verifyExperianSignature(body: string, signatureHeader: string | null): BureauWebhookVerificationResult {
  const key = process.env.EXPERIAN_WEBHOOK_SECRET;
  if (!key) return { ok: false, reason: "EXPERIAN_WEBHOOK_SECRET not configured" };
  if (!signatureHeader) return { ok: false, reason: "missing X-Experian-Signature header" };
  const expected = createHmac("sha256", key).update(body).digest("base64");
  if (!safeEqualBase64(expected, signatureHeader)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function verifyTransUnionSignature(body: string, signatureHeader: string | null): BureauWebhookVerificationResult {
  const key = process.env.TRANSUNION_WEBHOOK_SECRET;
  if (!key) return { ok: false, reason: "TRANSUNION_WEBHOOK_SECRET not configured" };
  if (!signatureHeader) return { ok: false, reason: "missing X-TransUnion-Signature header" };
  const expected = createHmac("sha256", key).update(body).digest("hex");
  if (!safeEqualHex(expected, signatureHeader)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function verifyEquifaxSignature(body: string, signatureHeader: string | null): BureauWebhookVerificationResult {
  const key = process.env.EQUIFAX_WEBHOOK_SECRET;
  if (!key) return { ok: false, reason: "EQUIFAX_WEBHOOK_SECRET not configured" };
  if (!signatureHeader) return { ok: false, reason: "missing X-Equifax-Signature header" };
  const expected = createHmac("sha256", key).update(body).digest("hex");
  if (!safeEqualHex(expected, signatureHeader)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function verifyCrcNigeriaSignature(body: string, signatureHeader: string | null): BureauWebhookVerificationResult {
  const key = process.env.CRC_API_SECRET;
  if (!key) return { ok: false, reason: "CRC_API_SECRET not configured" };
  if (!signatureHeader) return { ok: false, reason: "missing X-CRC-Signature header" };
  // CRC uses SHA1 (legacy). Phase 2 will migrate to SHA256 — for now we
  // accept the bureau's chosen scheme but use timingSafeEqual for compare.
  const expected = createHmac("sha1", key).update(body).digest("hex");
  if (!safeEqualHex(expected, signatureHeader)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function verifyCreditinfoSignature(authorizationHeader: string | null): BureauWebhookVerificationResult {
  const expected = process.env.CREDITINFO_WEBHOOK_TOKEN;
  if (!expected) return { ok: false, reason: "CREDITINFO_WEBHOOK_TOKEN not configured" };
  if (!authorizationHeader) return { ok: false, reason: "missing Authorization header" };
  if (!authorizationHeader.startsWith("Bearer ")) return { ok: false, reason: "expected Bearer token" };
  const received = authorizationHeader.slice(7);
  if (received.length !== expected.length) return { ok: false, reason: "token mismatch" };
  if (!timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return { ok: false, reason: "token mismatch" };
  return { ok: true };
}

export function verifyMetropolSignature(body: string, signatureHeader: string | null): BureauWebhookVerificationResult {
  const key = process.env.METROPOL_API_SECRET;
  if (!key) return { ok: false, reason: "METROPOL_API_SECRET not configured" };
  if (!signatureHeader) return { ok: false, reason: "missing X-Metropol-Signature header" };
  const expected = createHmac("sha256", key).update(body).digest("hex");
  if (!safeEqualHex(expected, signatureHeader)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

// ───────────────────────────────────────────────
// Dispatch — verify using the right scheme for the bureau.
// ───────────────────────────────────────────────

export function verifyBureauSignature(
  bureau: CreditBureauId,
  body: string,
  headers: Headers,
): BureauWebhookVerificationResult {
  switch (bureau) {
    case "experian":
      return verifyExperianSignature(body, headers.get("x-experian-signature"));
    case "transunion":
      return verifyTransUnionSignature(body, headers.get("x-transunion-signature"));
    case "equifax":
      return verifyEquifaxSignature(body, headers.get("x-equifax-signature"));
    case "crc_nigeria":
      return verifyCrcNigeriaSignature(body, headers.get("x-crc-signature"));
    case "creditinfo":
      return verifyCreditinfoSignature(headers.get("authorization"));
    case "metropol":
      return verifyMetropolSignature(body, headers.get("x-metropol-signature"));
    default:
      return { ok: false, reason: `unknown bureau: ${bureau}` };
  }
}

// ───────────────────────────────────────────────
// parseBureauEvent — normalize a bureau webhook body to BureauWebhookEvent.
//
// Each bureau's payload shape is different. We extract the common fields
// (subject id, score, risk tier, event type) and keep the raw body for
// audit. The bureau-specific parsing is intentionally minimal — apps that
// need the full report call back to the bureau's API with the report id.
// ───────────────────────────────────────────────

export function parseBureauEvent(bureau: CreditBureauId, body: unknown): BureauWebhookEvent {
  const b = body as Record<string, unknown>;
  const receivedAt = new Date();

  switch (bureau) {
    case "experian":
    case "transunion":
    case "equifax": {
      // The big three US bureaus all use a similar shape:
      //   {
      //     "event_type": "credit_report_ready" | "fraud_alert" | ...,
      //     "report_id": "rpt_...",
      //     "subject_id": "<the consumer we checked>",
      //     "score": 720,
      //     "score_range": { "min": 300, "max": 850 },
      //     "risk_tier": "prime",
      //     ...
      //   }
      return {
        bureau,
        externalReportId: (b.report_id as string) ?? crypto.randomUUID(),
        eventType: (b.event_type as string) ?? "unknown",
        subjectId: (b.subject_id as string) ?? "unknown",
        score: typeof b.score === "number" ? b.score : null,
        scoreRange: b.score_range as { min: number; max: number } | null,
        riskTier: (b.risk_tier as string) ?? null,
        raw: b,
        receivedAt,
      };
    }

    case "crc_nigeria": {
      // CRC Nigeria payload:
      //   {
      //     "event": "credit_report_ready",
      //     "report_reference": "CRC-...",
      //     "customer_id": "<the consumer>",
      //     "crc_score": 650,
      //     "risk_band": "PRIME",
      //     ...
      //   }
      return {
        bureau,
        externalReportId: (b.report_reference as string) ?? crypto.randomUUID(),
        eventType: (b.event as string) ?? "unknown",
        subjectId: (b.customer_id as string) ?? "unknown",
        score: typeof b.crc_score === "number" ? b.crc_score : null,
        scoreRange: { min: 300, max: 850 },
        riskTier: (b.risk_band as string) ?? null,
        raw: b,
        receivedAt,
      };
    }

    case "creditinfo": {
      // Creditinfo payload:
      //   {
      //     "eventType": "creditReportReady",
      //     "reportId": "ci-...",
      //     "ssn": "<subject national id>",
      //     "score": 850,
      //     "scoreMax": 1000,
      //     "riskClass": "A",
      //     ...
      //   }
      return {
        bureau,
        externalReportId: (b.reportId as string) ?? crypto.randomUUID(),
        eventType: (b.eventType as string) ?? "unknown",
        subjectId: (b.ssn as string) ?? "unknown",
        score: typeof b.score === "number" ? b.score : null,
        scoreRange: typeof b.scoreMax === "number" ? { min: 0, max: b.scoreMax as number } : null,
        riskTier: (b.riskClass as string) ?? null,
        raw: b,
        receivedAt,
      };
    }

    case "metropol": {
      // Metropol CRB payload:
      //   {
      //     "event_type": "report_ready",
      //     "reference": "MET-...",
      //     "id_number": "<subject national id>",
      //     "score": 600,
      //     "listing_status": "clean" | "defaulted",
      //     ...
      //   }
      return {
        bureau,
        externalReportId: (b.reference as string) ?? crypto.randomUUID(),
        eventType: (b.event_type as string) ?? "unknown",
        subjectId: (b.id_number as string) ?? "unknown",
        score: typeof b.score === "number" ? b.score : null,
        scoreRange: { min: 200, max: 900 },
        riskTier: (b.listing_status as string) ?? null,
        raw: b,
        receivedAt,
      };
    }

    default:
      return {
        bureau,
        externalReportId: crypto.randomUUID(),
        eventType: "unknown",
        subjectId: "unknown",
        score: null,
        scoreRange: null,
        riskTier: null,
        raw: b,
        receivedAt,
      };
  }
}

// ───────────────────────────────────────────────
// ingestBureauEvent — record the event + trigger downstream.
//
// Phase 1: just log + acknowledge (the inbound event is normalized + audited).
// Phase 2: insert into a bureau_events table + emit a fact to the webhook
// delivery service so the developer's app gets notified.
// ───────────────────────────────────────────────

export async function ingestBureauEvent(event: BureauWebhookEvent): Promise<{ ingested: boolean; reason?: string }> {
  console.log(
    `[credit-bureau:webhook] ingested ${event.bureau} event ${event.eventType} ` +
    `for subject ${event.subjectId} (score=${event.score ?? "n/a"}, tier=${event.riskTier ?? "n/a"})`,
  );
  return { ingested: true };
}
