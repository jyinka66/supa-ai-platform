/**
 * Tests for the Plaid + Smile Identity KYC webhook ingestion.
 *
 * Verifies:
 *   1. Signature verification accepts valid HMACs.
 *   2. Signature verification rejects invalid HMACs (timing-safe comparison).
 *   3. Signature verification rejects missing headers / env vars.
 *   4. Event parsing normalizes provider-specific shapes to KycWebhookEvent.
 *   5. The route handlers return 200 for valid webhooks + 401 for invalid signatures.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

// Set the env vars the verifier needs — before any imports touch them.
beforeAll(() => {
  vi.stubEnv("PLAID_WEBHOOK_VERIFICATION_KEY", "test_plaid_secret");
  vi.stubEnv("SMILE_API_KEY", "test_smile_secret");
});

import {
  verifyPlaidSignature,
  verifySmileIdentitySignature,
  parsePlaidEvent,
  parseSmileIdentityEvent,
  ingestKycEvent,
  type KycWebhookEvent,
} from "@/lib/kyc/webhook-ingestion";

// ───────────────────────────────────────────────
// Plaid signature verification
// ───────────────────────────────────────────────

describe("verifyPlaidSignature", () => {
  it("accepts a valid HMAC-SHA256 signature", () => {
    const body = JSON.stringify({ webhook_code: "verification_passed" });
    const sig = createHmac("sha256", "test_plaid_secret").update(body).digest("hex");
    const result = verifyPlaidSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ webhook_code: "verification_passed" });
    const result = verifyPlaidSignature(body, "deadbeef" + "0".repeat(56));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects when the header is missing", () => {
    const result = verifyPlaidSignature("{}", null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing Plaid-Verification header");
  });

  it("rejects when PLAID_WEBHOOK_VERIFICATION_KEY is not set", () => {
    const previous = process.env.PLAID_WEBHOOK_VERIFICATION_KEY;
    vi.stubEnv("PLAID_WEBHOOK_VERIFICATION_KEY", "");
    const result = verifyPlaidSignature("{}", "any-sig");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("PLAID_WEBHOOK_VERIFICATION_KEY not configured");
    // Restore for subsequent tests.
    vi.stubEnv("PLAID_WEBHOOK_VERIFICATION_KEY", previous ?? "test_plaid_secret");
  });
});

// ───────────────────────────────────────────────
// Smile Identity signature verification
// ───────────────────────────────────────────────

describe("verifySmileIdentitySignature", () => {
  it("accepts a valid HMAC-SHA256 signature", () => {
    const body = JSON.stringify({ result_code: "1010" });
    const sig = createHmac("sha256", "test_smile_secret").update(body).digest("hex");
    const result = verifySmileIdentitySignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ result_code: "1010" });
    const result = verifySmileIdentitySignature(body, "0".repeat(64));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects when the header is missing", () => {
    const result = verifySmileIdentitySignature("{}", null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing X-Smile-Identity-Signature header");
  });
});

// ───────────────────────────────────────────────
// Plaid event parsing
// ───────────────────────────────────────────────

describe("parsePlaidEvent", () => {
  it("normalizes a verification_passed webhook", () => {
    const event = parsePlaidEvent({
      webhook_type: "IDENTITY_VERIFICATION",
      webhook_code: "verification_passed",
      identity_verification_id: "idv_abc123",
      client_user_id: "user_001",
      document_status: "verified",
    });
    expect(event.provider).toBe("plaid");
    expect(event.eventType).toBe("verification_passed");
    expect(event.externalEventId).toBe("idv_abc123");
    expect(event.externalUserId).toBe("user_001");
    expect(event.raw).toHaveProperty("document_status", "verified");
  });

  it("uses a generated UUID when identity_verification_id is missing", () => {
    const event = parsePlaidEvent({ webhook_code: "verification_failed" });
    expect(event.externalEventId).toBeTruthy();
    expect(event.externalEventId.length).toBeGreaterThan(10);
  });

  it("falls back to 'unknown' for missing webhook_code", () => {
    const event = parsePlaidEvent({});
    expect(event.eventType).toBe("unknown");
  });
});

// ───────────────────────────────────────────────
// Smile Identity event parsing
// ───────────────────────────────────────────────

describe("parseSmileIdentityEvent", () => {
  it("normalizes an approved (1010) webhook", () => {
    const event = parseSmileIdentityEvent({
      result_code: "1010",
      partner_params: { user_id: "user_001", job_id: "job_abc" },
      timestamp: "2024-01-01T00:00:00Z",
    });
    expect(event.provider).toBe("smile_identity");
    expect(event.eventType).toBe("approved");
    expect(event.externalEventId).toBe("job_abc");
    expect(event.externalUserId).toBe("user_001");
  });

  it("maps known result codes to human-readable event types", () => {
    const cases = [
      { code: "1010", expected: "approved" },
      { code: "1020", expected: "rejected_poor_selfie" },
      { code: "1030", expected: "rejected_face_mismatch" },
      { code: "1040", expected: "rejected_document_expired" },
      { code: "1100", expected: "rejected_manual_review" },
    ];
    for (const { code, expected } of cases) {
      const event = parseSmileIdentityEvent({ result_code: code });
      expect(event.eventType).toBe(expected);
    }
  });

  it("falls back to result_<code> for unknown result codes", () => {
    const event = parseSmileIdentityEvent({ result_code: "9999" });
    expect(event.eventType).toBe("result_9999");
  });

  it("uses a generated UUID when job_id is missing", () => {
    const event = parseSmileIdentityEvent({
      result_code: "1010",
      partner_params: { user_id: "user_001" },
    });
    expect(event.externalEventId).toBeTruthy();
  });
});

// ───────────────────────────────────────────────
// ingestKycEvent
// ───────────────────────────────────────────────

describe("ingestKycEvent", () => {
  it("returns ingested: true (Phase 1 stub)", async () => {
    const event: KycWebhookEvent = {
      provider: "plaid",
      externalEventId: "idv_001",
      eventType: "verification_passed",
      externalUserId: "user_001",
      raw: {},
      receivedAt: new Date(),
    };
    const result = await ingestKycEvent(event);
    expect(result.ingested).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Route handlers
// ───────────────────────────────────────────────

describe("POST /api/webhooks/plaid", () => {
  it("returns 200 + ingested: true for a valid signed webhook", async () => {
    const body = JSON.stringify({
      webhook_code: "verification_passed",
      identity_verification_id: "idv_test_001",
      client_user_id: "user_001",
    });
    const sig = createHmac("sha256", "test_plaid_secret").update(body).digest("hex");
    const req = new NextRequest("https://example.com/api/webhooks/plaid", {
      method: "POST",
      body,
      headers: { "plaid-verification": sig, "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/plaid/route");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.ingested).toBe(true);
    expect(json.event.type).toBe("verification_passed");
  });

  it("returns 401 when the signature is invalid", async () => {
    const body = JSON.stringify({ webhook_code: "verification_passed" });
    const req = new NextRequest("https://example.com/api/webhooks/plaid", {
      method: "POST",
      body,
      headers: { "plaid-verification": "invalid_signature", "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/plaid/route");
    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("signature_verification_failed");
  });

  it("returns 401 when the signature header is missing", async () => {
    const body = JSON.stringify({ webhook_code: "verification_passed" });
    const req = new NextRequest("https://example.com/api/webhooks/plaid", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/plaid/route");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const body = "not valid json";
    const sig = createHmac("sha256", "test_plaid_secret").update(body).digest("hex");
    const req = new NextRequest("https://example.com/api/webhooks/plaid", {
      method: "POST",
      body,
      headers: { "plaid-verification": sig, "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/plaid/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/webhooks/smile", () => {
  it("returns 200 + ingested: true for a valid signed webhook", async () => {
    const body = JSON.stringify({
      result_code: "1010",
      partner_params: { user_id: "user_001", job_id: "job_abc" },
    });
    const sig = createHmac("sha256", "test_smile_secret").update(body).digest("hex");
    const req = new NextRequest("https://example.com/api/webhooks/smile", {
      method: "POST",
      body,
      headers: { "x-smile-identity-signature": sig, "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/smile/route");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.event.type).toBe("approved");
  });

  it("returns 401 when the signature is invalid", async () => {
    const body = JSON.stringify({ result_code: "1010" });
    const req = new NextRequest("https://example.com/api/webhooks/smile", {
      method: "POST",
      body,
      headers: { "x-smile-identity-signature": "0".repeat(64), "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/smile/route");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────
// Cleanup — keep env vars stubbed for the duration of the file (the
// route handlers + verifier both depend on them).
// ───────────────────────────────────────────────

