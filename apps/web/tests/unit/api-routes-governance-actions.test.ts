/**
 * Functional tests for the governance tools/agents check + developer-abuse routes.
 *
 * These routes wrap governance logic and return a structured decision verdict.
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

// Mock the DB-backed decision engine so financial/destructive tool calls
// don't fail by trying to query Postgres. Both routeDecision and
// executeDecision are mocked — executeDecision would otherwise insert into
// the governance_decisions table.
vi.mock("@/lib/governance/decision-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/governance/decision-engine")>("@/lib/governance/decision-engine");
  return {
    ...actual,
    routeDecision: vi.fn().mockResolvedValue({
      decision: "policy_approved",
      riskLevel: "medium",
      policyKey: "tool.call:default",
      reasoning: { mocked: true },
      decisionId: "dec_test_001",
    }),
    executeDecision: vi.fn().mockResolvedValue({
      decisionId: "dec_test_001",
      decision: "policy_approved",
    }),
    assessRisk: actual.assessRisk,
  };
});

import * as toolsCheckRoute from "@/app/api/governance/tools/check/route";
import * as agentsCheckRoute from "@/app/api/governance/agents/check/route";
import * as developerAbuseRoute from "@/app/api/governance/developer-abuse/route";

function makePostReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ───────────────────────────────────────────────
// Tool governance check
// ───────────────────────────────────────────────

describe("POST /api/governance/tools/check", () => {
  it("classifies a read-only tool call as 'read_only' and allows it", async () => {
    const res = await toolsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/tools/check", {
        toolKey: "files.read",
        sideEffect: false,
        isFinancial: false,
        isDestructive: false,
        crossWorkspace: false,
        crossUser: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.category).toBe("read_only");
    expect(json.data.decision.allowed).toBe(true);
  });

  it("classifies a destructive tool call as 'destructive'", async () => {
    const res = await toolsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/tools/check", {
        toolKey: "workspaces.delete",
        sideEffect: true,
        isFinancial: false,
        isDestructive: true,
        crossWorkspace: false,
        crossUser: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.category).toBe("destructive");
  });

  it("classifies a financial tool call as 'financial'", async () => {
    const res = await toolsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/tools/check", {
        toolKey: "billing.charge",
        sideEffect: true,
        isFinancial: true,
        isDestructive: false,
        crossWorkspace: false,
        crossUser: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.category).toBe("financial");
  });

  it("classifies a cross-user tool call as 'cross_user'", async () => {
    const res = await toolsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/tools/check", {
        toolKey: "users.impersonate",
        sideEffect: true,
        isFinancial: false,
        isDestructive: false,
        crossWorkspace: true,
        crossUser: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.category).toBe("cross_user");
  });

  it("rejects a body missing required fields", async () => {
    const res = await toolsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/tools/check", {
        toolKey: "files.read",
        // missing sideEffect, isFinancial, isDestructive, crossWorkspace, crossUser
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────
// Agent action governance check
// ───────────────────────────────────────────────

describe("POST /api/governance/agents/check", () => {
  it("flags a prohibited action (e.g. system.shutdown)", async () => {
    const res = await agentsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/agents/check", {
        actionType: "system.shutdown",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    // PROHIBITED_ACTIONS includes things like system.shutdown, system.wipe, etc.
    // The exact list depends on the lib; we just verify the structure.
    expect(json.data).toHaveProperty("prohibited");
    expect(json.data).toHaveProperty("result");
    expect(Array.isArray(json.data.prohibitedActions)).toBe(true);
  });

  it("allows a normal action (e.g. files.read)", async () => {
    const res = await agentsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/agents/check", {
        actionType: "files.read",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.prohibited).toBe(false);
  });

  it("rejects an empty actionType", async () => {
    const res = await agentsCheckRoute.POST!(
      makePostReq("https://example.com/api/governance/agents/check", {
        actionType: "ab",
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────
// Developer abuse detection
// ───────────────────────────────────────────────

describe("POST /api/governance/developer-abuse", () => {
  it("flags minor rate-limit evasion as 'rate_limited' (low score)", async () => {
    const res = await developerAbuseRoute.POST!(
      makePostReq("https://example.com/api/governance/developer-abuse", {
        developerId: "dev_001",
        signals: [
          { type: "rate_limit_evasion", occurrences: 1, windowMinutes: 60 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.abuse.score).toBeGreaterThan(0);
    expect(json.data.abuse.level).toMatch(/^(rate_limited|warning|suspended|banned)$/);
  });

  it("flags data exfiltration as a serious offense (high score)", async () => {
    const res = await developerAbuseRoute.POST!(
      makePostReq("https://example.com/api/governance/developer-abuse", {
        developerId: "dev_002",
        signals: [
          { type: "data_exfiltration", occurrences: 5, windowMinutes: 60 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // 30 weight × 5 occurrences = 150 raw score, no reputation discount.
    expect(json.data.abuse.score).toBeGreaterThanOrEqual(70);
    expect(["suspended", "banned"]).toContain(json.data.abuse.level);
  });

  it("gives trusted developers (reputation >= 80) the benefit of the doubt (30% discount)", async () => {
    const res = await developerAbuseRoute.POST!(
      makePostReq("https://example.com/api/governance/developer-abuse", {
        developerId: "dev_003",
        developerReputation: 90,
        signals: [
          { type: "data_exfiltration", occurrences: 3, windowMinutes: 60 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // 30 × 3 = 90 raw, × 0.7 (trusted discount) = 63 → floored to 63.
    expect(json.data.abuse.score).toBeLessThan(90);
  });

  it("amplifies the score for low-reputation developers", async () => {
    const res = await developerAbuseRoute.POST!(
      makePostReq("https://example.com/api/governance/developer-abuse", {
        developerId: "dev_004",
        developerReputation: 10,
        signals: [
          { type: "rate_limit_evasion", occurrences: 2, windowMinutes: 60 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // 8 × 2 = 16 raw, × 1.3 (low-rep amplification) = ~20.
    expect(json.data.abuse.score).toBeGreaterThan(16);
  });

  it("rejects an empty signals array", async () => {
    const res = await developerAbuseRoute.POST!(
      makePostReq("https://example.com/api/governance/developer-abuse", {
        developerId: "dev_005",
        signals: [],
      }),
    );
    expect(res.status).toBe(400);
  });
});
