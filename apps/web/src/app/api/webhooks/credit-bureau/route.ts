// POST /api/webhooks/credit-bureau
//
// Inbound webhook from a credit bureau — credit report delivered, fraud
// alert raised, score updated.
//
// The bureau is identified by the `X-Bureau` header (set when we register
// the webhook URL with the bureau). Each bureau signs its webhook with a
// different scheme; we dispatch to the right verifier based on the bureau.
//
// Body shape: bureau-specific (see lib/fintech/credit-bureau-ingestion.ts
// for the per-bureau parsing).
//
// Auth: signature-based (not admin auth). The bureau's signature is
// verified before the body is parsed.

import { NextRequest, NextResponse } from "next/server";
import {
  verifyBureauSignature,
  parseBureauEvent,
  ingestBureauEvent,
} from "@/lib/fintech/credit-bureau-ingestion";
import type { CreditBureauId } from "@/lib/supa-os/fintech-primitives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_BUREAUS = new Set<CreditBureauId>([
  "experian", "transunion", "equifax",
  "crc_nigeria", "creditinfo", "metropol",
]);

export async function POST(req: NextRequest) {
  const bureauHeader = req.headers.get("x-bureau");
  if (!bureauHeader) {
    return NextResponse.json(
      { ok: false, error: "missing_bureau_header", reason: "X-Bureau header is required" },
      { status: 400 },
    );
  }
  const bureau = bureauHeader as CreditBureauId;
  if (!VALID_BUREAUS.has(bureau)) {
    return NextResponse.json(
      { ok: false, error: "unknown_bureau", reason: `Unknown bureau: ${bureauHeader}` },
      { status: 400 },
    );
  }

  // Read the raw body — bureaus sign the raw bytes, not the JSON-parsed form.
  const body = await req.text();
  const verification = verifyBureauSignature(bureau, body, req.headers);
  if (!verification.ok) {
    console.warn(`[webhooks/credit-bureau] ${bureau} signature verification failed:`, verification.reason);
    return NextResponse.json(
      { ok: false, error: "signature_verification_failed", reason: verification.reason },
      { status: 401 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn(`[webhooks/credit-bureau] ${bureau} invalid JSON body`);
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const event = parseBureauEvent(bureau, parsed);
  const result = await ingestBureauEvent(event);

  return NextResponse.json({
    ok: true,
    ingested: result.ingested,
    event: {
      bureau: event.bureau,
      type: event.eventType,
      subjectId: event.subjectId,
      score: event.score,
      riskTier: event.riskTier,
    },
  });
}
