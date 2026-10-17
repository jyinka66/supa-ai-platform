/**
 * Tests for the rate-limit tier configuration.
 *
 * Verifies:
 *   1. All Supa OS / Governance / Expansion routes have an explicit tier.
 *   2. Destructive actions have tighter limits than read-only ones.
 *   3. getTierForRoute() correctly matches dynamic segments (e.g.
 *      /api/supa-os/build/abc-123/agents/architect → supaOsBuild).
 */

import { describe, it, expect } from "vitest";
import { TIERS, ROUTE_TIERS, getTier, getTierForRoute } from "@/lib/ratelimit/config";

describe("TIERS — Supa OS rate limits", () => {
  it("supaOsBuild has a tight limit (10/min) — creating a build is expensive", () => {
    expect(TIERS.supaOsBuild.limit).toBe(10);
    expect(TIERS.supaOsBuild.windowMs).toBe(60_000);
  });

  it("supaOsDeploy is even tighter (5/min) — deploys cost cloud fees", () => {
    expect(TIERS.supaOsDeploy.limit).toBe(5);
  });

  it("supaOsPublish is the tightest (3/min) — publishes are irreversible", () => {
    expect(TIERS.supaOsPublish.limit).toBe(3);
  });

  it("supaOsSandbox is generous (60/min) — coding writes lots of files", () => {
    expect(TIERS.supaOsSandbox.limit).toBe(60);
  });

  it("supaOsWasm is medium (30/min) — terminal commands can be long-running", () => {
    expect(TIERS.supaOsWasm.limit).toBe(30);
  });
});

describe("TIERS — Governance rate limits", () => {
  it("governanceKillSwitch is very tight (2/min) — cooling-off prevents flip-flops", () => {
    expect(TIERS.governanceKillSwitch.limit).toBe(2);
  });

  it("governanceCommittee is medium (10/min)", () => {
    expect(TIERS.governanceCommittee.limit).toBe(10);
  });

  it("governanceQuery is 30/min — heavier DB queries", () => {
    expect(TIERS.governanceQuery.limit).toBe(30);
  });
});

describe("TIERS — Expansion rate limits", () => {
  it("expansionPipeline is 10/min — detection + evaluation are DB-heavy", () => {
    expect(TIERS.expansionPipeline.limit).toBe(10);
  });

  it("expansionOptimization is 5/min — mutations", () => {
    expect(TIERS.expansionOptimization.limit).toBe(5);
  });
});

describe("ROUTE_TIERS — explicit mappings for new routes", () => {
  const expectedMappings: Array<{ route: string; tier: string }> = [
    // Supa OS
    { route: "/api/supa-os/build", tier: "supaOsBuild" },
    { route: "/api/supa-os/build/[id]/deploy", tier: "supaOsDeploy" },
    { route: "/api/supa-os/build/[id]/sandbox/files", tier: "supaOsSandbox" },
    { route: "/api/supa-os/build/[id]/agents/[role]", tier: "supaOsBuild" },
    { route: "/api/supa-os/wasm/execute", tier: "supaOsWasm" },
    { route: "/api/supa-os/marketplace/[itemId]/review", tier: "supaOsPublish" },
    // Builder
    { route: "/api/builder/sessions/[id]/publish", tier: "supaOsPublish" },
    { route: "/api/builder/sessions/[id]/preview", tier: "supaOsSandbox" },
    // Governance
    { route: "/api/governance/kill-switches/[id]/trigger", tier: "governanceKillSwitch" },
    { route: "/api/governance/committee/decisions", tier: "governanceCommittee" },
    { route: "/api/governance/decisions/log", tier: "governanceQuery" },
    // Expansion
    { route: "/api/expansion/detection", tier: "expansionPipeline" },
    { route: "/api/expansion/optimization", tier: "expansionOptimization" },
  ];

  for (const { route, tier } of expectedMappings) {
    it(`${route} → ${tier}`, () => {
      expect(ROUTE_TIERS[route]).toBe(tier);
    });
  }
});

describe("getTierForRoute — dynamic segment matching", () => {
  it("matches /api/supa-os/build/<uuid>/agents/architect to supaOsBuild", () => {
    const tier = getTierForRoute("/api/supa-os/build/abc-123/agents/architect");
    expect(tier).toBe("supaOsBuild");
  });

  it("matches /api/supa-os/build/<uuid>/sandbox/files to supaOsSandbox", () => {
    const tier = getTierForRoute("/api/supa-os/build/abc-123/sandbox/files");
    expect(tier).toBe("supaOsSandbox");
  });

  it("matches /api/governance/kill-switches/<id>/trigger to governanceKillSwitch", () => {
    const tier = getTierForRoute("/api/governance/kill-switches/ks_001/trigger");
    expect(tier).toBe("governanceKillSwitch");
  });

  it("matches /api/expansion/detection to expansionPipeline", () => {
    const tier = getTierForRoute("/api/expansion/detection");
    expect(tier).toBe("expansionPipeline");
  });

  it("falls back to 'default' for unmapped routes", () => {
    const tier = getTierForRoute("/api/supa-os/catalog/stacks");
    expect(tier).toBe("default");
  });
});

describe("getTier — fallback behavior", () => {
  it("returns the named tier when it exists", () => {
    expect(getTier("supaOsBuild").limit).toBe(10);
  });

  it("returns the default tier for unknown names", () => {
    expect(getTier("nonexistent").limit).toBe(100);
  });

  it("returns the default tier for undefined", () => {
    expect(getTier(undefined).limit).toBe(100);
  });
});

describe("Rate limit ordering — destructive < interactive < read-only", () => {
  it("publish is tighter than deploy (publish is irreversible, deploy is reversible)", () => {
    expect(TIERS.supaOsPublish.limit).toBeLessThan(TIERS.supaOsDeploy.limit);
  });

  it("deploy is tighter than sandbox (deploy costs cloud fees, sandbox is local)", () => {
    expect(TIERS.supaOsDeploy.limit).toBeLessThan(TIERS.supaOsSandbox.limit);
  });

  it("kill switch is tighter than committee decisions (kill switch is emergency-only)", () => {
    expect(TIERS.governanceKillSwitch.limit).toBeLessThan(TIERS.governanceCommittee.limit);
  });
});
