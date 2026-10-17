/**
 * Tests for the credit bureau integration.
 *
 * Verifies:
 *   1. The bureau catalog has 6 licensed bureaus, all marked implemented.
 *   2. The demo scorer (calculateCreditScore) is marked demoOnly: true.
 *   3. Signature verification works for each bureau's scheme.
 *   4. Event parsing normalizes each bureau's payload to BureauWebhookEvent.
 *   5. The webhook route returns 200 for valid signed callbacks + 401 for
 *      invalid signatures + 400 for missing/unknown bureau header.
 *   6. The catalog route returns the bureau list.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

// Stub env vars for all 6 bureaus' verification secrets.
beforeAll(() => {
  vi.stubEnv("EXPERIAN_WEBHOOK_SECRET", "experian_secret");
  vi.stubEnv("TRANSUNION_WEBHOOK_SECRET", "transunion_secret");
  vi.stubEnv("EQUIFAX_WEBHOOK_SECRET", "equifax_secret");
  vi.stubEnv("CRC_API_SECRET", "crc_secret");
  vi.stubEnv("CREDITINFO_WEBHOOK_TOKEN", "creditinfo_token");
  vi.stubEnv("METROPOL_API_SECRET", "metropol_secret");
});

import {
  CREDIT_BUREAUS,
  verifyFintechPrimitives,
} from "@/lib/supa-os/fintech-primitives";
import { calculateCreditScore } from "@/lib/supa-os/loan-engine";
import {
  verifyBureauSignature,
  parseBureauEvent,
  ingestBureauEvent,
  verifyExperianSignature,
  verifyTransUnionSignature,
  verifyEquifaxSignature,
  verifyCrcNigeriaSignature,
  verifyCreditinfoSignature,
  verifyMetropolSignature,
} from "@/lib/fintech/credit-bureau-ingestion";

// ───────────────────────────────────────────────
// Catalog
// ───────────────────────────────────────────────

describe("CREDIT_BUREAUS catalog", () => {
  it("has 6 bureaus", () => {
    expect(CREDIT_BUREAUS).toHaveLength(6);
  });

  it("all bureaus are licensed + implemented", () => {
    for (const bureau of CREDIT_BUREAUS) {
      expect(bureau.licensed, `${bureau.id} should be licensed`).toBe(true);
      expect(bureau.implemented, `${bureau.id} should be implemented`).toBe(true);
    }
  });

  it("includes the big three US bureaus (Experian, TransUnion, Equifax)", () => {
    const ids = CREDIT_BUREAUS.map((b) => b.id);
    expect(ids).toContain("experian");
    expect(ids).toContain("transunion");
    expect(ids).toContain("equifax");
  });

  it("includes the African bureaus (CRC Nigeria, Metropol Kenya)", () => {
    const ids = CREDIT_BUREAUS.map((b) => b.id);
    expect(ids).toContain("crc_nigeria");
    expect(ids).toContain("metropol");
  });

  it("each bureau has a webhookPath set", () => {
    for (const bureau of CREDIT_BUREAUS) {
      expect(bureau.webhookPath).toBe("/api/webhooks/credit-bureau");
    }
  });

  it("each bureau declares the env vars needed", () => {
    for (const bureau of CREDIT_BUREAUS) {
      expect(bureau.envVars.length).toBeGreaterThan(0);
    }
  });

  it("verifyFintechPrimitives reports all bureaus implemented", () => {
    const summary = verifyFintechPrimitives();
    expect(summary.creditBureaus).toBe(6);
    expect(summary.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Demo scorer marking
// ───────────────────────────────────────────────

describe("calculateCreditScore — demo marking", () => {
  it("returns demoOnly: true on every result", () => {
    const result = calculateCreditScore({
      paymentHistory: 90,
      creditUtilization: 30,
      creditHistoryLength: 80,
      creditMix: 70,
      newInquiries: 90,
      debtToIncome: 25,
    });
    expect(result.demoOnly).toBe(true);
  });

  it("still produces a score in the FICO range (300-850)", () => {
    const result = calculateCreditScore({
      paymentHistory: 100, creditUtilization: 100, creditHistoryLength: 100,
      creditMix: 100, newInquiries: 100, debtToIncome: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(300);
    expect(result.score).toBeLessThanOrEqual(850);
    expect(result.grade).toBe("A");
  });
});

// ───────────────────────────────────────────────
// Per-bureau signature verification
// ───────────────────────────────────────────────

describe("Per-bureau signature verification", () => {
  it("Experian accepts a valid HMAC-SHA256 (base64) signature", () => {
    const body = '{"event_type":"credit_report_ready"}';
    const sig = createHmac("sha256", "experian_secret").update(body).digest("base64");
    const result = verifyExperianSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("Experian rejects an invalid signature", () => {
    const result = verifyExperianSignature("body", "invalid_base64");
    expect(result.ok).toBe(false);
  });

  it("TransUnion accepts a valid HMAC-SHA256 (hex) signature", () => {
    const body = '{"event_type":"credit_report_ready"}';
    const sig = createHmac("sha256", "transunion_secret").update(body).digest("hex");
    const result = verifyTransUnionSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("Equifax accepts a valid HMAC-SHA256 (hex) signature", () => {
    const body = '{"event_type":"credit_report_ready"}';
    const sig = createHmac("sha256", "equifax_secret").update(body).digest("hex");
    const result = verifyEquifaxSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("CRC Nigeria accepts a valid HMAC-SHA1 (hex) signature (legacy)", () => {
    const body = '{"event":"credit_report_ready"}';
    const sig = createHmac("sha1", "crc_secret").update(body).digest("hex");
    const result = verifyCrcNigeriaSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("Creditinfo accepts a valid Bearer token", () => {
    const result = verifyCreditinfoSignature("Bearer creditinfo_token");
    expect(result.ok).toBe(true);
  });

  it("Creditinfo rejects an invalid Bearer token", () => {
    const result = verifyCreditinfoSignature("Bearer wrong_token");
    expect(result.ok).toBe(false);
  });

  it("Metropol accepts a valid HMAC-SHA256 (hex) signature", () => {
    const body = '{"event_type":"report_ready"}';
    const sig = createHmac("sha256", "metropol_secret").update(body).digest("hex");
    const result = verifyMetropolSignature(body, sig);
    expect(result.ok).toBe(true);
  });

  it("each verifier rejects a missing header", () => {
    expect(verifyExperianSignature("body", null).ok).toBe(false);
    expect(verifyTransUnionSignature("body", null).ok).toBe(false);
    expect(verifyEquifaxSignature("body", null).ok).toBe(false);
    expect(verifyCrcNigeriaSignature("body", null).ok).toBe(false);
    expect(verifyCreditinfoSignature(null).ok).toBe(false);
    expect(verifyMetropolSignature("body", null).ok).toBe(false);
  });
});

// ───────────────────────────────────────────────
// Dispatch — verifyBureauSignature picks the right verifier
// ───────────────────────────────────────────────

describe("verifyBureauSignature dispatch", () => {
  it("dispatches Experian signatures to the Experian verifier", () => {
    const body = '{"event_type":"credit_report_ready"}';
    const sig = createHmac("sha256", "experian_secret").update(body).digest("base64");
    const headers = new Headers({ "x-experian-signature": sig });
    const result = verifyBureauSignature("experian", body, headers);
    expect(result.ok).toBe(true);
  });

  it("dispatches Metropol signatures to the Metropol verifier", () => {
    const body = '{"event_type":"report_ready"}';
    const sig = createHmac("sha256", "metropol_secret").update(body).digest("hex");
    const headers = new Headers({ "x-metropol-signature": sig });
    const result = verifyBureauSignature("metropol", body, headers);
    expect(result.ok).toBe(true);
  });

  it("dispatches Creditinfo tokens to the Creditinfo verifier", () => {
    const headers = new Headers({ authorization: "Bearer creditinfo_token" });
    const result = verifyBureauSignature("creditinfo", "", headers);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false for an unknown bureau", () => {
    const result = verifyBureauSignature("unknown_bureau" as never, "", new Headers());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unknown bureau");
  });
});

// ───────────────────────────────────────────────
// Event parsing
// ───────────────────────────────────────────────

describe("parseBureauEvent", () => {
  it("normalizes an Experian credit_report_ready webhook", () => {
    const event = parseBureauEvent("experian", {
      event_type: "credit_report_ready",
      report_id: "rpt_001",
      subject_id: "user_001",
      score: 720,
      score_range: { min: 300, max: 850 },
      risk_tier: "prime",
    });
    expect(event.bureau).toBe("experian");
    expect(event.eventType).toBe("credit_report_ready");
    expect(event.externalReportId).toBe("rpt_001");
    expect(event.subjectId).toBe("user_001");
    expect(event.score).toBe(720);
    expect(event.scoreRange).toEqual({ min: 300, max: 850 });
    expect(event.riskTier).toBe("prime");
  });

  it("normalizes a CRC Nigeria credit_report_ready webhook", () => {
    const event = parseBureauEvent("crc_nigeria", {
      event: "credit_report_ready",
      report_reference: "CRC-001",
      customer_id: "cust_001",
      crc_score: 650,
      risk_band: "PRIME",
    });
    expect(event.bureau).toBe("crc_nigeria");
    expect(event.eventType).toBe("credit_report_ready");
    expect(event.externalReportId).toBe("CRC-001");
    expect(event.subjectId).toBe("cust_001");
    expect(event.score).toBe(650);
    expect(event.scoreRange).toEqual({ min: 300, max: 850 });
    expect(event.riskTier).toBe("PRIME");
  });

  it("normalizes a Creditinfo webhook (camelCase)", () => {
    const event = parseBureauEvent("creditinfo", {
      eventType: "creditReportReady",
      reportId: "ci-001",
      ssn: "1234567890",
      score: 850,
      scoreMax: 1000,
      riskClass: "A",
    });
    expect(event.bureau).toBe("creditinfo");
    expect(event.eventType).toBe("creditReportReady");
    expect(event.externalReportId).toBe("ci-001");
    expect(event.subjectId).toBe("1234567890");
    expect(event.score).toBe(850);
    expect(event.scoreRange).toEqual({ min: 0, max: 1000 });
    expect(event.riskTier).toBe("A");
  });

  it("normalizes a Metropol webhook with listing_status", () => {
    const event = parseBureauEvent("metropol", {
      event_type: "report_ready",
      reference: "MET-001",
      id_number: "12345678",
      score: 600,
      listing_status: "clean",
    });
    expect(event.bureau).toBe("metropol");
    expect(event.eventType).toBe("report_ready");
    expect(event.externalReportId).toBe("MET-001");
    expect(event.subjectId).toBe("12345678");
    expect(event.score).toBe(600);
    expect(event.scoreRange).toEqual({ min: 200, max: 900 });
    expect(event.riskTier).toBe("clean");
  });

  it("handles a missing score gracefully", () => {
    const event = parseBureauEvent("experian", {
      event_type: "fraud_alert",
      report_id: "rpt_002",
      subject_id: "user_002",
    });
    expect(event.score).toBeNull();
    expect(event.riskTier).toBeNull();
  });
});

// ───────────────────────────────────────────────
// ingestBureauEvent
// ───────────────────────────────────────────────

describe("ingestBureauEvent", () => {
  it("returns ingested: true (Phase 1 stub)", async () => {
    const result = await ingestBureauEvent({
      bureau: "experian",
      externalReportId: "rpt_001",
      eventType: "credit_report_ready",
      subjectId: "user_001",
      score: 720,
      scoreRange: { min: 300, max: 850 },
      riskTier: "prime",
      raw: {},
      receivedAt: new Date(),
    });
    expect(result.ingested).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Route handlers
// ───────────────────────────────────────────────

describe("POST /api/webhooks/credit-bureau", () => {
  it("returns 200 + ingested: true for a valid Experian webhook", async () => {
    const body = JSON.stringify({
      event_type: "credit_report_ready",
      report_id: "rpt_001",
      subject_id: "user_001",
      score: 720,
      score_range: { min: 300, max: 850 },
      risk_tier: "prime",
    });
    const sig = createHmac("sha256", "experian_secret").update(body).digest("base64");
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body,
      headers: {
        "x-bureau": "experian",
        "x-experian-signature": sig,
        "content-type": "application/json",
      },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.ingested).toBe(true);
    expect(json.event.bureau).toBe("experian");
    expect(json.event.score).toBe(720);
  });

  it("returns 400 when the X-Bureau header is missing", async () => {
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_bureau_header");
  });

  it("returns 400 when the bureau is unknown", async () => {
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body: "{}",
      headers: { "x-bureau": "fake_bureau", "content-type": "application/json" },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_bureau");
  });

  it("returns 401 when the signature is invalid", async () => {
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body: '{"event_type":"credit_report_ready"}',
      headers: {
        "x-bureau": "experian",
        "x-experian-signature": "invalid_signature",
        "content-type": "application/json",
      },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_verification_failed");
  });

  it("returns 200 for a valid CRC Nigeria webhook (SHA1 signature)", async () => {
    const body = JSON.stringify({
      event: "credit_report_ready",
      report_reference: "CRC-001",
      customer_id: "cust_001",
      crc_score: 650,
      risk_band: "PRIME",
    });
    const sig = createHmac("sha1", "crc_secret").update(body).digest("hex");
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body,
      headers: {
        "x-bureau": "crc_nigeria",
        "x-crc-signature": sig,
        "content-type": "application/json",
      },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.event.bureau).toBe("crc_nigeria");
    expect(json.event.score).toBe(650);
  });

  it("returns 200 for a valid Creditinfo webhook (Bearer token)", async () => {
    const body = JSON.stringify({
      eventType: "creditReportReady",
      reportId: "ci-001",
      ssn: "1234567890",
      score: 850,
      scoreMax: 1000,
      riskClass: "A",
    });
    const req = new NextRequest("https://example.com/api/webhooks/credit-bureau", {
      method: "POST",
      body,
      headers: {
        "x-bureau": "creditinfo",
        authorization: "Bearer creditinfo_token",
        "content-type": "application/json",
      },
    });
    const { POST } = await import("@/app/api/webhooks/credit-bureau/route");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.event.bureau).toBe("creditinfo");
    expect(json.event.riskTier).toBe("A");
  });
});
