// POST /api/webhooks/smile
//
// Inbound webhook from Smile Identity — KYC status updates for African
// markets (Nigeria, Ghana, Kenya, South Africa, Egypt).
//
// Smile Identity signs webhooks with an `X-Smile-Identity-Signature`
// header containing the HMAC-SHA256 of the raw body (hex-encoded) using
// SMILE_API_KEY as the secret.
//
// Body shape (Smile Identity Doc/Bio webhook):
//   {
//     "result_code": "1010" | "1020" | "1030" | ...,
//     "partner_params": { "user_id": "...", "job_id": "..." },
//     "actions": { ... },
//     "signature": "<hex hmac>",  // duplicates the header
//     "timestamp": "2024-..."
//   }
//
// Result code reference (full mapping in lib/kyc/webhook-ingestion.ts):
//   1010 = approved
//   1020 = rejected (poor selfie)
//   1030 = rejected (face mismatch)
//   1040 = rejected (document expired)
//   1100 = rejected (manual review)
//
// Auth: signature-based (not admin auth). No Authorization header required.

import { NextRequest, NextResponse } from "next/server";
import {
  verifySmileIdentitySignature,
  parseSmileIdentityEvent,
  ingestKycEvent,
} from "@/lib/kyc/webhook-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signatureHeader = req.headers.get("x-smile-identity-signature");

  const verification = verifySmileIdentitySignature(body, signatureHeader);
  if (!verification.ok) {
    console.warn("[webhooks/smile] signature verification failed:", verification.reason);
    return NextResponse.json(
      { ok: false, error: "signature_verification_failed", reason: verification.reason },
      { status: 401 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn("[webhooks/smile] invalid JSON body");
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const event = parseSmileIdentityEvent(parsed);
  const result = await ingestKycEvent(event);

  return NextResponse.json({ ok: true, ingested: result.ingested, event: { type: event.eventType, userId: event.externalUserId } });
}
