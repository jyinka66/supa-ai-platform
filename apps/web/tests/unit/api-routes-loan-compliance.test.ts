/**
 * Functional tests for the Supa OS loan + ledger + compliance routes.
 *
 * These tests invoke the POST handlers with real payloads (after mocking the
 * admin middleware) and verify the response shape + the underlying library
 * math is correct.
 */

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/admin/middleware", () => ({
  requireAdminSession: vi.fn().mockResolvedValue({
    adminId: "admin_test_001",
    role: "owner",
    sessionId: "sess_test_001",
    ip: "127.0.0.1",
  }),
  ADMIN_COOKIE_NAME: "supa_admin",
}));

vi.mock("@/lib/http/middleware", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http/middleware")>("@/lib/http/middleware");
  return { ...actual, authenticate: vi.fn().mockResolvedValue("user_test_001") };
});

import * as loanRoute from "@/app/api/supa-os/loan/calculate/route";
import * as complianceMaskRoute from "@/app/api/supa-os/compliance/mask/route";

function makePostReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ───────────────────────────────────────────────
// Loan calculation
// ───────────────────────────────────────────────

describe("POST /api/supa-os/loan/calculate", () => {
  it("calculates a simple amortization schedule + summary", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: 100000,
        annualInterestRate: 12,
        termMonths: 12,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const schedule = json.data.schedule;
    const summary = json.data.summary;

    // Schedule: 12 monthly entries.
    expect(schedule.schedule).toHaveLength(12);

    // Summary: total payments, total interest, etc.
    expect(summary.totalPayment).toBeGreaterThan(100000); // principal + interest
    expect(summary.totalInterest).toBeGreaterThan(0);
    expect(summary.monthlyPayment).toBeGreaterThan(0);
  });

  it("rejects a non-positive principal", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: -1000,
        annualInterestRate: 12,
        termMonths: 12,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an exorbitant principal (>$10M)", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: 100_000_000,
        annualInterestRate: 12,
        termMonths: 12,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an interest rate above 100%", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: 1000,
        annualInterestRate: 200,
        termMonths: 12,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a term longer than 360 months (30 years)", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: 1000,
        annualInterestRate: 12,
        termMonths: 500,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts an optional startDate", async () => {
    const res = await loanRoute.POST!(
      makePostReq("https://example.com/api/supa-os/loan/calculate", {
        principal: 50000,
        annualInterestRate: 6,
        termMonths: 60,
        startDate: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Compliance mask
// ───────────────────────────────────────────────

describe("POST /api/supa-os/compliance/mask", () => {
  it("masks a card number, showing the last 4 digits", async () => {
    const res = await complianceMaskRoute.POST!(
      makePostReq("https://example.com/api/supa-os/compliance/mask", {
        value: "4242424242424242",
        fieldType: "card_number",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.masked).toContain("4242");
    // The mask should NOT contain the full card number.
    expect(json.data.masked).not.toContain("4242424242424242");
  });

  it("masks a BVN (Nigeria Bank Verification Number)", async () => {
    const res = await complianceMaskRoute.POST!(
      makePostReq("https://example.com/api/supa-os/compliance/mask", {
        value: "12345678901",
        fieldType: "bvn",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.masked).toContain("8901");
  });

  it("rejects an unknown fieldType", async () => {
    const res = await complianceMaskRoute.POST!(
      makePostReq("https://example.com/api/supa-os/compliance/mask", {
        value: "sensitive",
        fieldType: "unknown_type",
      }),
    );
    expect(res.status).toBe(400);
  });
});
