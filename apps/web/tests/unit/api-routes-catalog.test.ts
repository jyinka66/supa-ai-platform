/**
 * Functional tests for the Supa OS catalog routes.
 *
 * These tests actually invoke the GET handlers (after mocking the admin
 * middleware to bypass auth) and verify the response shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the admin middleware so every request is treated as authenticated.
vi.mock("@/lib/admin/middleware", () => ({
  requireAdminSession: vi.fn().mockResolvedValue({
    adminId: "admin_test_001",
    role: "owner",
    sessionId: "sess_test_001",
    ip: "127.0.0.1",
  }),
  ADMIN_COOKIE_NAME: "supa_admin",
}));

// Mock the http/middleware's authenticate to bypass user auth.
vi.mock("@/lib/http/middleware", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http/middleware")>("@/lib/http/middleware");
  return {
    ...actual,
    authenticate: vi.fn().mockResolvedValue("user_test_001"),
  };
});

import * as catalogStacksRoute from "@/app/api/supa-os/catalog/stacks/route";
import * as catalogCloudTargetsRoute from "@/app/api/supa-os/catalog/cloud-targets/route";
import * as catalogKycProvidersRoute from "@/app/api/supa-os/catalog/kyc-providers/route";
import * as catalogPaymentGatewaysRoute from "@/app/api/supa-os/catalog/payment-gateways/route";
import * as catalogEnterpriseTiersRoute from "@/app/api/supa-os/catalog/enterprise-tiers/route";
import * as catalogSdkEndpointsRoute from "@/app/api/supa-os/catalog/sdk-endpoints/route";
import * as catalogOnPremRoute from "@/app/api/supa-os/catalog/on-prem/route";

// Helper: build a NextRequest.
function makeReq(url = "https://example.com/api/foo"): NextRequest {
  return new NextRequest(url);
}

// Helper: extract the JSON body from a NextResponse.
async function body(res: Response): Promise<{ ok?: boolean; data?: unknown; [k: string]: unknown }> {
  return res.json();
}

// ───────────────────────────────────────────────
// Catalog routes
// ───────────────────────────────────────────────

describe("Supa OS catalog routes", () => {
  it("GET /api/supa-os/catalog/stacks returns the Next.js + Flutter stacks", async () => {
    const handler = (catalogStacksRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.ok).toBe(true);
    const data = json.data as { stacks: Array<{ id: string; label: string }> };
    expect(data.stacks).toHaveLength(2);
    expect(data.stacks.map((s) => s.id)).toEqual(["nextjs_supabase", "flutter_firebase"]);
  });

  it("GET /api/supa-os/catalog/cloud-targets returns the cloud deploy targets catalog", async () => {
    const handler = (catalogCloudTargetsRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { targets: unknown[]; total: number };
    expect(data.targets.length).toBeGreaterThanOrEqual(5);
    expect(data.total).toBe(data.targets.length);
  });

  it("GET /api/supa-os/catalog/kyc-providers returns KYC + African KYC providers", async () => {
    const handler = (catalogKycProvidersRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { providers: unknown[]; africanProviders: unknown[]; total: number };
    expect(data.providers.length).toBeGreaterThan(0);
    expect(data.africanProviders.length).toBeGreaterThan(0);
    expect(data.total).toBe(data.providers.length + data.africanProviders.length);
  });

  it("GET /api/supa-os/catalog/payment-gateways returns the gateway catalog", async () => {
    const handler = (catalogPaymentGatewaysRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { gateways: unknown[]; total: number };
    expect(data.gateways.length).toBeGreaterThan(0);
    expect(data.total).toBe(data.gateways.length);
  });

  it("GET /api/supa-os/catalog/enterprise-tiers returns tiers + deployment models", async () => {
    const handler = (catalogEnterpriseTiersRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { tiers: unknown[]; deploymentModels: unknown[] };
    expect(data.tiers.length).toBeGreaterThan(0);
    expect(data.deploymentModels.length).toBeGreaterThan(0);
  });

  it("GET /api/supa-os/catalog/sdk-endpoints returns API endpoints + SDK languages", async () => {
    const handler = (catalogSdkEndpointsRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { endpoints: unknown[]; sdks: unknown[]; totalEndpoints: number; totalSdks: number };
    expect(data.endpoints.length).toBeGreaterThan(0);
    expect(data.sdks.length).toBeGreaterThan(0);
  });

  it("GET /api/supa-os/catalog/on-prem returns private cloud + container platforms", async () => {
    const handler = (catalogOnPremRoute as unknown as { GET: (req: NextRequest) => Promise<Response> }).GET;
    const res = await handler(makeReq());
    expect(res.status).toBe(200);
    const json = await body(res);
    const data = json.data as { privateCloudTargets: unknown[]; containerPlatforms: unknown[]; total: number };
    expect(data.privateCloudTargets.length).toBeGreaterThan(0);
    expect(data.containerPlatforms.length).toBeGreaterThan(0);
    expect(data.total).toBe(data.privateCloudTargets.length + data.containerPlatforms.length);
  });
});
