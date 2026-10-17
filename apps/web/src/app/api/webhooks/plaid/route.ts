// POST /api/webhooks/plaid
//
// Inbound webhook from Plaid — KYC status updates (verification passed,
// document rejected, etc.).
//
// Plaid signs webhooks with a `Plaid-Verification` header (HMAC-SHA256 of
// the raw body using PLAID_WEBHOOK_VERIFICATION_KEY). We verify the
// signature before parsing the body.
//
// Body shape (Plaid identity_verification webhook):
//   {
//     "webhook_type": "IDENTITY_VERIFICATION",
//     "webhook_code": "verification_passed" | "verification_failed",
//     "identity_verification_id": "idv_...",
//     "client_user_id": "<user id>",
//     ...
//   }
//
// Auth: signature-based (not admin auth). No Authorization header required.

import { NextRequest, NextResponse } from "next/server";
import {
  verifyPlaidSignature,
  parsePlaidEvent,
  ingestKycEvent,
} from "@/lib/kyc/webhook-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Plaid sends the body as raw JSON. Read it as text so we can verify the
  // signature over the exact bytes (not the JSON-parsed form).
  const body = await req.text();
  const signatureHeader = req.headers.get("plaid-verification");

  const verification = verifyPlaidSignature(body, signatureHeader);
  if (!verification.ok) {
    console.warn("[webhooks/plaid] signature verification failed:", verification.reason);
    return NextResponse.json(
      { ok: false, error: "signature_verification_failed", reason: verification.reason },
      { status: 401 },
    );
  }

  // Parse the body as JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn("[webhooks/plaid] invalid JSON body");
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  // Normalize to our common shape + ingest.
  const event = parsePlaidEvent(parsed);
  const result = await ingestKycEvent(event);

  // Plaid expects a 200 to acknowledge the webhook. If we don't ack, Plaid
  // retries with exponential backoff (1min, 5min, 30min, 2h, 12h — max 5).
  return NextResponse.json({ ok: true, ingested: result.ingested, event: { type: event.eventType, userId: event.externalUserId } });
}
