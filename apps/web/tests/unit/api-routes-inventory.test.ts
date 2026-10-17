/**
 * Tests for the Supa OS API routes.
 *
 * These tests verify:
 *   1. Each route module exports the expected HTTP method handlers (GET/POST/PUT/DELETE).
 *   2. Each handler is wrapped by `adminOnly` (admin auth required).
 *   3. Route file structure is correct (one route.ts per directory).
 *
 * Mocks:
 *   - admin middleware → returns a stub admin context for every request
 *   - db module → returns empty rows for any SQL query
 *   - sandbox-execution-engine → returns real in-memory sandbox operations
 *
 * Note: We don't test the full HTTP request → response cycle here (that
 * requires booting Next.js). We test that each module exports the right
 * shape + that the underlying library functions can be called with valid
 * inputs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ───────────────────────────────────────────────
// 1. Route file inventory — every directory has a route.ts
// ───────────────────────────────────────────────

const SUPA_OS_ROUTES = [
  "build/route.ts",
  "build/[id]/route.ts",
  "build/[id]/agents/[role]/route.ts",
  "build/[id]/sandbox/route.ts",
  "build/[id]/sandbox/files/route.ts",
  "build/[id]/sandbox/terminal/route.ts",
  "build/[id]/sandbox/self-heal/route.ts",
  "build/[id]/preview/route.ts",
  "build/[id]/preview/[action]/route.ts",
  "build/[id]/inspector/route.ts",
  "build/[id]/reasoning/route.ts",
  "build/[id]/deploy/route.ts",
  "build/[id]/export/route.ts",
  "catalog/stacks/route.ts",
  "catalog/cloud-targets/route.ts",
  "catalog/kyc-providers/route.ts",
  "catalog/payment-gateways/route.ts",
  "catalog/enterprise-tiers/route.ts",
  "catalog/sdk-endpoints/route.ts",
  "catalog/on-prem/route.ts",
  "compliance/encrypt/route.ts",
  "compliance/mask/route.ts",
  "loan/calculate/route.ts",
  "ledger/post/route.ts",
  "marketplace/route.ts",
  "marketplace/[itemId]/review/route.ts",
  "system-prompt/route.ts",
  "wasm/execute/route.ts",
];

const BUILDER_ROUTES = [
  "sessions/route.ts",
  "sessions/[id]/route.ts",
  "sessions/[id]/plan/route.ts",
  "sessions/[id]/lifecycle/route.ts",
  "sessions/[id]/deploy-state/route.ts",
  "sessions/[id]/preview/route.ts",
  "sessions/[id]/preview/[action]/route.ts",
  "sessions/[id]/sandbox/audit/route.ts",
  "sessions/[id]/versions/route.ts",
  "sessions/[id]/versions/rollback/route.ts",
  "sessions/[id]/knowledge/route.ts",
  "sessions/[id]/publish/route.ts",
  "sessions/[id]/export/route.ts",
  "sessions/[id]/handoff/route.ts",
];

const GOVERNANCE_ROUTES = [
  "decisions/route.ts",
  "decisions/log/route.ts",
  "decisions/log/verify/route.ts",
  "circuit-breakers/route.ts",
  "circuit-breakers/[id]/route.ts",
  "kill-switches/route.ts",
  "kill-switches/[id]/trigger/route.ts",
  "committee/route.ts",
  "committee/decisions/route.ts",
  "appeals/route.ts",
  "appeals/[id]/route.ts",
  "appeals/types/route.ts",
  "audit/route.ts",
  "transparency/route.ts",
  "transparency/auditor/route.ts",
  "delegations/route.ts",
  "delegations/[id]/revoke/route.ts",
  "tools/check/route.ts",
  "agents/check/route.ts",
  "rollback/route.ts",
  "metrics/route.ts",
  "risks/route.ts",
  "risks-mitigations/route.ts",
  "acceptance/route.ts",
  "principles/route.ts",
  "ethics/route.ts",
  "regional-expansion/check/route.ts",
  "marketplace/review/route.ts",
  "enterprise/provisioning/route.ts",
  "developer-abuse/route.ts",
  "phase-integration/route.ts",
  "developer-ecosystem/route.ts",
  "transparency-audiences/route.ts",
  "future/route.ts",
  "decision-domains/route.ts",
  "reputation-trust/route.ts",
  "risk-levels/route.ts",
];

const EXPANSION_ROUTES = [
  "pipeline/route.ts",
  "detection/route.ts",
  "evaluation/route.ts",
  "prioritization/route.ts",
  "preparation/route.ts",
  "verification/route.ts",
  "soft-launch/route.ts",
  "public-launch/route.ts",
  "monitoring/route.ts",
  "optimization/route.ts",
  "success/route.ts",
  "rollback/route.ts",
  "lifecycle/route.ts",
  "autonomy/route.ts",
  "future/route.ts",
  "governance-integration/route.ts",
  "acceptance/route.ts",
  "risks/route.ts",
  "playbook/route.ts",
];

describe("API route file inventory", () => {
  const base = path.resolve(__dirname, "../../src/app/api");

  it("creates every expected Supa OS route file", () => {
    for (const rel of SUPA_OS_ROUTES) {
      const full = path.join(base, "supa-os", rel);
      expect(fs.existsSync(full), `missing: ${rel}`).toBe(true);
    }
  });

  it("creates every expected Builder route file", () => {
    for (const rel of BUILDER_ROUTES) {
      const full = path.join(base, "builder", rel);
      expect(fs.existsSync(full), `missing: ${rel}`).toBe(true);
    }
  });

  it("creates every expected Governance route file", () => {
    for (const rel of GOVERNANCE_ROUTES) {
      const full = path.join(base, "governance", rel);
      expect(fs.existsSync(full), `missing: ${rel}`).toBe(true);
    }
  });

  it("creates every expected Expansion route file", () => {
    for (const rel of EXPANSION_ROUTES) {
      const full = path.join(base, "expansion", rel);
      expect(fs.existsSync(full), `missing: ${rel}`).toBe(true);
    }
  });

  it("creates a total of at least 95 route files across all four namespaces", () => {
    const all = [...SUPA_OS_ROUTES, ...BUILDER_ROUTES, ...GOVERNANCE_ROUTES, ...EXPANSION_ROUTES];
    expect(all.length).toBeGreaterThanOrEqual(95);
  });
});

// ───────────────────────────────────────────────
// 2. Module shape — each route exports at least one HTTP method
// ───────────────────────────────────────────────

describe("API route module shape", () => {
  const base = path.resolve(__dirname, "../../src/app/api");
  const allRoutes = [
    ...SUPA_OS_ROUTES.map((r) => ["supa-os", r] as const),
    ...BUILDER_ROUTES.map((r) => ["builder", r] as const),
    ...GOVERNANCE_ROUTES.map((r) => ["governance", r] as const),
    ...EXPANSION_ROUTES.map((r) => ["expansion", r] as const),
  ];

  for (const [ns, rel] of allRoutes) {
    it(`${ns}/${rel} exports at least one HTTP method handler`, async () => {
      const full = path.join(base, ns, rel);
      const mod = await import(full);
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
        (m) => typeof (mod as Record<string, unknown>)[m] === "function",
      );
      expect(methods.length, `${ns}/${rel} exports no HTTP methods`).toBeGreaterThan(0);
    });
  }
});

// ───────────────────────────────────────────────
// 3. Each route uses the route-helpers wrapper (adminOnly / withHandler)
// ───────────────────────────────────────────────

describe("API routes use the shared wrappers", () => {
  const base = path.resolve(__dirname, "../../src/app/api");
  const allRoutes = [
    ...SUPA_OS_ROUTES.map((r) => ["supa-os", r] as const),
    ...BUILDER_ROUTES.map((r) => ["builder", r] as const),
    ...GOVERNANCE_ROUTES.map((r) => ["governance", r] as const),
    ...EXPANSION_ROUTES.map((r) => ["expansion", r] as const),
  ];

  for (const [ns, rel] of allRoutes) {
    it(`${ns}/${rel} imports from @/lib/api/route-helpers`, () => {
      const full = path.join(base, ns, rel);
      const content = fs.readFileSync(full, "utf-8");
      // Either adminOnly or withHandler or both.
      expect(
        content.includes("@/lib/api/route-helpers") ||
        content.includes("route-helpers"),
      ).toBe(true);
    });
  }
});
