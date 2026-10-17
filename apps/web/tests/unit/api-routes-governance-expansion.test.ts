/**
 * Functional tests for the governance + expansion catalog GET routes.
 *
 * These tests invoke the GET handlers (after mocking admin auth) and verify
 * they return the spec catalogs (decision domains, risk levels, ethics,
 * acceptance criteria, etc.).
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

// Mock the DB-backed kill-switches module so the route returns successfully
// without needing a real Postgres connection.
vi.mock("@/lib/governance/kill-switches", async () => {
  const actual = await vi.importActual<typeof import("@/lib/governance/kill-switches")>("@/lib/governance/kill-switches");
  return {
    ...actual,
    listKillSwitches: vi.fn().mockResolvedValue([]),
  };
});

import * as decisionDomainsRoute from "@/app/api/governance/decision-domains/route";
import * as riskLevelsRoute from "@/app/api/governance/risk-levels/route";
import * as ethicsRoute from "@/app/api/governance/ethics/route";
import * as acceptanceRoute from "@/app/api/governance/acceptance/route";
import * as principlesRoute from "@/app/api/governance/principles/route";
import * as committeeRoute from "@/app/api/governance/committee/route";
import * as circuitBreakersRoute from "@/app/api/governance/circuit-breakers/route";
import * as killSwitchesRoute from "@/app/api/governance/kill-switches/route";
import * as transparencyAudiencesRoute from "@/app/api/governance/transparency-audiences/route";
import * as appealsTypesRoute from "@/app/api/governance/appeals/types/route";
import * as futureRoute from "@/app/api/governance/future/route";

import * as expansionPipelineRoute from "@/app/api/expansion/pipeline/route";
import * as expansionLifecycleRoute from "@/app/api/expansion/lifecycle/route";
import * as expansionAutonomyRoute from "@/app/api/expansion/autonomy/route";
import * as expansionFutureRoute from "@/app/api/expansion/future/route";
import * as expansionAcceptanceRoute from "@/app/api/expansion/acceptance/route";
import * as expansionRisksRoute from "@/app/api/expansion/risks/route";
import * as expansionPlaybookRoute from "@/app/api/expansion/playbook/route";
import * as expansionPublicLaunchRoute from "@/app/api/expansion/public-launch/route";
import * as expansionMonitoringRoute from "@/app/api/expansion/monitoring/route";

function makeReq(url = "https://example.com/api/foo"): NextRequest {
  return new NextRequest(url);
}

async function callGet(module: { GET: (req: NextRequest) => Promise<Response> }, url?: string) {
  const res = await module.GET(makeReq(url));
  expect(res.status).toBe(200);
  return res.json();
}

// ───────────────────────────────────────────────
// Governance catalog routes
// ───────────────────────────────────────────────

describe("Governance catalog routes", () => {
  it("GET /api/governance/decision-domains returns the 8 decision domains", async () => {
    const json = await callGet(decisionDomainsRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.domains.length).toBeGreaterThanOrEqual(8);
    expect(data.verification).toBeDefined();
    expect(data.summary).toBeDefined();
  });

  it("GET /api/governance/risk-levels returns the 5 risk levels", async () => {
    const json = await callGet(riskLevelsRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(Object.keys(data.riskLevels).length).toBe(5);
    expect(data.riskLevels).toHaveProperty("low");
    expect(data.riskLevels).toHaveProperty("medium");
    expect(data.riskLevels).toHaveProperty("high");
    expect(data.riskLevels).toHaveProperty("critical");
    expect(data.riskLevels).toHaveProperty("irreversible");
  });

  it("GET /api/governance/ethics returns principles + bias audits", async () => {
    const json = await callGet(ethicsRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.principles.length).toBeGreaterThan(0);
    expect(data.biasAudits.length).toBeGreaterThan(0);
  });

  it("GET /api/governance/acceptance returns criteria + readiness summary", async () => {
    const json = await callGet(acceptanceRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.criteria.length).toBeGreaterThan(0);
    expect(data.verification).toBeDefined();
    expect(typeof data.readinessSummary).toBe("string");
  });

  it("GET /api/governance/principles returns principle checks + summary", async () => {
    const json = await callGet(principlesRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.summary).toHaveProperty("total");
    expect(data.summary).toHaveProperty("met");
  });

  it("GET /api/governance/committee returns composition + routing rules", async () => {
    const json = await callGet(committeeRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.composition.length).toBeGreaterThan(0);
    expect(data.routingRules.length).toBeGreaterThan(0);
  });

  it("GET /api/governance/circuit-breakers returns the breaker catalog", async () => {
    const json = await callGet(circuitBreakersRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.breakers.length).toBeGreaterThan(0);
    expect(data.total).toBe(data.breakers.length);
  });

  it("GET /api/governance/kill-switches returns kill switch types + SLA", async () => {
    const json = await callGet(killSwitchesRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.types.length).toBeGreaterThan(0);
    expect(data.propagationSlaSeconds).toBe(60);
  });

  it("GET /api/governance/transparency-audiences returns user + auditor + regulator transparency", async () => {
    const json = await callGet(transparencyAudiencesRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.userTransparency.length).toBeGreaterThan(0);
    expect(data.auditorTransparency.length).toBeGreaterThan(0);
    expect(data.regulatorTransparency.length).toBeGreaterThan(0);
  });

  it("GET /api/governance/appeals/types returns appeal types + workflow", async () => {
    const json = await callGet(appealsTypesRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.types.length).toBeGreaterThan(0);
    expect(data.workflow.length).toBeGreaterThan(0);
  });

  it("GET /api/governance/future returns pillars + closing thesis", async () => {
    const json = await callGet(futureRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.pillars.length).toBeGreaterThan(0);
    expect(typeof data.closingStatement).toBe("string");
  });
});

// ───────────────────────────────────────────────
// Expansion catalog routes
// ───────────────────────────────────────────────

describe("Expansion catalog routes", () => {
  it("GET /api/expansion/pipeline returns the pipeline stages + autonomy + checkpoints", async () => {
    const json = await callGet(expansionPipelineRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    // PIPELINE_STAGES covers the post-prioritization pipeline (extract → translate → review → qa → publish → live).
    expect(data.stages.length).toBeGreaterThanOrEqual(7);
    expect(data.autonomyLevels.length).toBeGreaterThan(0);
    expect(data.humanCheckpoints.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/lifecycle returns 9 region stages + transitions", async () => {
    const json = await callGet(expansionLifecycleRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.stages.length).toBeGreaterThanOrEqual(9);
    expect(data.transitions.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/autonomy returns stage autonomy + checkpoints", async () => {
    const json = await callGet(expansionAutonomyRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.stageAutonomy.length).toBeGreaterThan(0);
    expect(data.humanCheckpoints.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/future returns pillars + closing thesis", async () => {
    const json = await callGet(expansionFutureRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.pillars.length).toBeGreaterThan(0);
    expect(typeof data.closingStatement).toBe("string");
  });

  it("GET /api/expansion/acceptance returns criteria + readiness summary", async () => {
    const json = await callGet(expansionAcceptanceRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.criteria.length).toBeGreaterThan(0);
    expect(data.verification).toBeDefined();
    expect(typeof data.readinessSummary).toBe("string");
  });

  it("GET /api/expansion/risks returns risks + mitigations", async () => {
    const json = await callGet(expansionRisksRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.risks.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/playbook returns components + principles", async () => {
    const json = await callGet(expansionPlaybookRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.components.length).toBeGreaterThan(0);
    expect(data.principles.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/public-launch returns launch actions + safeguards", async () => {
    const json = await callGet(expansionPublicLaunchRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.actions.length).toBeGreaterThan(0);
    expect(data.safeguards.length).toBeGreaterThan(0);
  });

  it("GET /api/expansion/monitoring returns metric groups + alert types", async () => {
    const json = await callGet(expansionMonitoringRoute as unknown as { GET: (req: NextRequest) => Promise<Response> });
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.metricGroups.length).toBeGreaterThan(0);
    expect(data.alertTypes.length).toBeGreaterThan(0);
  });
});
