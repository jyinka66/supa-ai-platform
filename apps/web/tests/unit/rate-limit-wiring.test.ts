/**
 * Tests for the withRateLimit() helper + its wiring into route handlers.
 *
 * Strategy: mock the entire @/lib/ratelimit module so the sliding-window
 * code (which tries to instantiate Redis.fromEnv() at module load) never
 * runs. We capture every applyLimitForRoute() call + control its return
 * value via `nextRateLimitResult`.
 *
 * We don't stub the env vars — instead, we mock the rate-limit module
 * itself. This is the cleanest separation: the unit tests verify the
 * route's WIRING (does it call withRateLimit? does it check the result?)
 * without depending on whether Redis is configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ───────────────────────────────────────────────
// Mocks — applied BEFORE any imports that touch them.
// ───────────────────────────────────────────────

vi.mock("@/lib/admin/middleware", () => ({
  requireAdminSession: vi.fn().mockResolvedValue({
    adminId: "admin_001",
    role: "owner",
    sessionId: "sess_001",
    ip: "127.0.0.1",
  }),
  ADMIN_COOKIE_NAME: "supa_admin",
}));

vi.mock("@/lib/http/middleware", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
      super(message);
      this.name = "ApiError";
    }
  },
  authenticate: vi.fn().mockResolvedValue("user_001"),
  requestId: vi.fn(() => "test-request-id"),
  corsHeaders: vi.fn(() => ({})),
  errorResponse: vi.fn(),
  jsonLimiter: vi.fn(),
  billingGate: vi.fn(),
}));

vi.mock("@supa/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000001",
        owner_id: "admin_001",
        ws_id: "00000000-0000-0000-0000-000000000001",
        name: "Test Build",
        original_prompt: "Build a todo app for testing rate limits",
        platform: "web",
        status: "planning",
        plan: {},
        repo_url: null,
        build_artifact_hash: null,
        test_results: null,
        preview_url: null,
        deployment_target: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]),
  },
}));

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const queryChunks: unknown[] = [];
      for (let i = 0; i < strings.length; i++) {
        queryChunks.push(strings[i]!);
        if (i < values.length) queryChunks.push(values[i]);
      }
      return { queryChunks, toString: () => strings.join("?") };
    },
    { raw: (str: string) => ({ queryChunks: [str], toString: () => str }) },
  ),
}));

// Capture rate-limit calls + control the return value.
const rateLimitCalls: Array<{ pathname: string; identifier: string }> = [];
let nextRateLimitResult: { ok: boolean; remaining: number; retryAfterSec: number } | undefined = {
  ok: true, remaining: 9, retryAfterSec: 0,
};

vi.mock("@/lib/ratelimit", () => ({
  applyLimitForRoute: vi.fn(async (pathname: string, identifier: string) => {
    rateLimitCalls.push({ pathname, identifier });
    if (nextRateLimitResult === undefined) throw new Error("Redis is down");
    return nextRateLimitResult;
  }),
  applyLimit: vi.fn(async () => nextRateLimitResult),
  TIERS: {},
  getTier: vi.fn(() => ({ limit: 10, windowMs: 60_000 })),
  getTierForRoute: vi.fn(() => "supaOsBuild" as never),
}));

// Stub env to "configured" so withRateLimit goes through the real path
// (instead of the fail-open path).
beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://test.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test_token");
  rateLimitCalls.length = 0;
  nextRateLimitResult = { ok: true, remaining: 9, retryAfterSec: 0 };
});

afterEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});

// ───────────────────────────────────────────────
// Direct unit tests for withRateLimit
// ───────────────────────────────────────────────

import { withRateLimit } from "@/lib/api/route-helpers";

describe("withRateLimit (direct)", () => {
  it("returns null when rate limit allows", async () => {
    const req = new NextRequest("https://example.com/api/supa-os/build", { method: "POST" });
    const result = await withRateLimit(req, "admin_001");
    expect(result).toBeNull();
    expect(rateLimitCalls).toHaveLength(1);
    expect(rateLimitCalls[0]!.pathname).toBe("/api/supa-os/build");
    expect(rateLimitCalls[0]!.identifier).toBe("admin_001");
  });

  it("returns a 429 problem response when rate limit denies", async () => {
    nextRateLimitResult = { ok: false, remaining: 0, retryAfterSec: 30 };
    const req = new NextRequest("https://example.com/api/supa-os/build", { method: "POST" });
    const result = await withRateLimit(req, "admin_001");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    const json = await result!.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.details.retryAfterSec).toBe(30);
  });

  it("fails open (returns null) when Redis env vars are missing", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const req = new NextRequest("https://example.com/api/foo", { method: "POST" });
    const result = await withRateLimit(req, "admin_001");
    expect(result).toBeNull();
    // The rate-limit module should NOT have been called.
    expect(rateLimitCalls).toHaveLength(0);
  });

  it("fails open (returns null) when the rate-limit module throws", async () => {
    // Set the result to undefined — the mock will throw "Redis is down".
    nextRateLimitResult = undefined;
    const req = new NextRequest("https://example.com/api/foo", { method: "POST" });
    // The route's try/catch should swallow the error and return null.
    const result = await withRateLimit(req, "admin_001");
    expect(result).toBeNull();
    // Restore.
    nextRateLimitResult = { ok: true, remaining: 9, retryAfterSec: 0 };
  });
});

// ───────────────────────────────────────────────
// Wiring tests — verify the route calls withRateLimit
// ───────────────────────────────────────────────

describe("POST /api/supa-os/marketplace — rate limit wiring", () => {
  it("calls withRateLimit with the authenticated user + marketplace path", async () => {
    const { POST } = await import("@/app/api/supa-os/marketplace/route");
    const req = new NextRequest("https://example.com/api/supa-os/marketplace", {
      method: "POST",
      body: JSON.stringify({ name: "Test theme", type: "theme", description: "A valid test theme for rate limit coverage.", monetization: "free", price: 0, version: "1.0.0", manifest: { tokens: { "color.primary": "#000000" } } }),
      headers: { "Content-Type": "application/json" },
    });
    try { await POST(req); } catch { /* request may fail validation after rate limiting */ }
    expect(rateLimitCalls).toHaveLength(1);
    expect(rateLimitCalls[0]?.pathname).toBe("/api/supa-os/marketplace");
    expect(rateLimitCalls[0]?.identifier).toBe("user_001");
  });

  it("returns 429 before processing a marketplace submission when rate limit denies", async () => {
    nextRateLimitResult = { ok: false, remaining: 0, retryAfterSec: 30 };
    const { POST } = await import("@/app/api/supa-os/marketplace/route");
    const req = new NextRequest("https://example.com/api/supa-os/marketplace", {
      method: "POST",
      body: JSON.stringify({ name: "Test theme", type: "theme", description: "A valid test theme for rate limit coverage.", monetization: "free", price: 0, version: "1.0.0", manifest: { tokens: { "color.primary": "#000000" } } }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(rateLimitCalls).toHaveLength(1);
  });
});

describe("POST /api/governance/kill-switches/[id]/trigger — rate limit wiring", () => {
  it("calls withRateLimit before any other logic", async () => {
    const { POST } = await import("@/app/api/governance/kill-switches/[id]/trigger/route");
    const req = new NextRequest("https://example.com/api/governance/kill-switches/global_halt/trigger", {
      method: "POST",
      body: JSON.stringify({ reason: "Emergency shutdown — security incident detected in production" }),
      headers: { "Content-Type": "application/json" },
    });
    (req as unknown as { params: Record<string, string> }).params = { id: "global_halt" };
    try { await POST(req); } catch { /* expected — KILL_SWITCH_TYPES.find may return undefined */ }
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitCalls[0]!.pathname).toContain("/api/governance/kill-switches/");
    expect(rateLimitCalls[0]!.identifier).toBe("admin_001");
  });
});

describe("POST /api/builder/sessions/[id]/publish — rate limit wiring", () => {
  it("calls withRateLimit with the admin id + publish path", async () => {
    const { POST } = await import("@/app/api/builder/sessions/[id]/publish/route");
    const req = new NextRequest("https://example.com/api/builder/sessions/abc/publish", {
      method: "POST",
      body: JSON.stringify({ target: "supa_hosting" }),
      headers: { "Content-Type": "application/json" },
    });
    (req as unknown as { params: Record<string, string> }).params = { id: "abc" };
    try { await POST(req); } catch { /* expected — getBuildSession returns mock row */ }
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitCalls[0]!.pathname).toContain("/api/builder/sessions/");
    expect(rateLimitCalls[0]!.identifier).toBe("admin_001");
  });
});

describe("POST /api/supa-os/marketplace/[itemId]/review — rate limit wiring", () => {
  it("calls withRateLimit with the admin id + review path", async () => {
    const { POST } = await import("@/app/api/supa-os/marketplace/[itemId]/review/route");
    const req = new NextRequest("https://example.com/api/supa-os/marketplace/item_001/review", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", notes: "Looks good — passes all automated checks." }),
      headers: { "Content-Type": "application/json" },
    });
    (req as unknown as { params: Record<string, string> }).params = { itemId: "item_001" };
    try { await POST(req); } catch { /* expected — itemStore is empty */ }
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);
    expect(rateLimitCalls[0]!.pathname).toContain("/api/supa-os/marketplace/");
    expect(rateLimitCalls[0]!.identifier).toBe("admin_001");
  });
});
