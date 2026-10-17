/**
 * Tests for the Supa OS API client.
 *
 * Verifies that:
 *   1. Each namespace exposes the expected methods.
 *   2. Each method constructs the right URL + HTTP method + body.
 *   3. The response envelope { ok, data } is unwrapped correctly.
 *
 * The fetch is stubbed with a simple function that captures calls + returns
 * a queued response. We use `globalThis.fetch` to avoid jsdom's URL parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  supaOsApi,
  governanceApi,
  expansionApi,
  builderApi,
  ApiClientError,
} from "@/lib/api-client";

// Capture every fetch call so tests can assert on URL + method + body.
const calls: Array<{ url: string; method: string; body?: string }> = [];
let nextResponse: { ok: boolean; status: number; json: () => Promise<unknown> } = {
  ok: true, status: 200, json: async () => ({ ok: true, data: {} }),
};

beforeEach(() => {
  calls.length = 0;
  nextResponse = { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({
      url,
      method: options?.method ?? "GET",
      body: typeof options?.body === "string" ? options.body : undefined,
    });
    return nextResponse as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setResponse(ok: boolean, status: number, data: unknown) {
  if (ok) {
    nextResponse = { ok: true, status, json: async () => ({ ok: true, data }) };
  } else {
    nextResponse = { ok: false, status, json: async () => ({ error: data }) };
  }
}

// ───────────────────────────────────────────────
// supaOsApi.build
// ───────────────────────────────────────────────

describe("supaOsApi.build", () => {
  it("create() POSTs to /api/supa-os/build with the right body", async () => {
    setResponse(true, 200, { session: { id: "build_001" } });
    const result = await supaOsApi.build.create({ prompt: "Build a todo app" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/supa-os/build");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "Build a todo app" });
    expect(result.session.id).toBe("build_001");
  });

  it("get() GETs /api/supa-os/build/<id>", async () => {
    setResponse(true, 200, { session: { id: "abc" } });
    await supaOsApi.build.get("abc");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc");
    expect(calls[0]!.method).toBe("GET");
  });

  it("cancel() DELETEs /api/supa-os/build/<id>", async () => {
    setResponse(true, 200, { sessionId: "abc" });
    await supaOsApi.build.cancel("abc");
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("runAgent() POSTs to /api/supa-os/build/<id>/agents/<role>", async () => {
    setResponse(true, 200, { output: {} });
    await supaOsApi.build.runAgent("abc", "architect");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc/agents/architect");
    expect(calls[0]!.method).toBe("POST");
  });

  it("deploy() POSTs to /api/supa-os/build/<id>/deploy with target", async () => {
    setResponse(true, 200, { deployment: {} });
    await supaOsApi.build.deploy("abc", "vercel");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc/deploy");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ target: "vercel" });
  });
});

// ───────────────────────────────────────────────
// supaOsApi.sandbox
// ───────────────────────────────────────────────

describe("supaOsApi.sandbox", () => {
  it("get() GETs the sandbox state", async () => {
    setResponse(true, 200, { files: [], terminal: { lines: [] } });
    await supaOsApi.sandbox.get("abc");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc/sandbox");
  });

  it("writeFile() POSTs to /sandbox/files with path + content", async () => {
    setResponse(true, 200, {});
    await supaOsApi.sandbox.writeFile("abc", "/app/foo.ts", "content");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc/sandbox/files");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ path: "/app/foo.ts", content: "content" });
  });

  it("deleteFile() DELETEs with ?path= query param", async () => {
    setResponse(true, 200, {});
    await supaOsApi.sandbox.deleteFile("abc", "/app/foo.ts");
    expect(calls[0]!.url).toBe("/api/supa-os/build/abc/sandbox?path=%2Fapp%2Ffoo.ts");
    expect(calls[0]!.method).toBe("DELETE");
  });
});

// ───────────────────────────────────────────────
// supaOsApi.loan + marketplace
// ───────────────────────────────────────────────

describe("supaOsApi.loan", () => {
  it("calculate() POSTs the loan parameters", async () => {
    setResponse(true, 200, { schedule: { schedule: [] }, summary: {} });
    await supaOsApi.loan.calculate({ principal: 100000, annualInterestRate: 12, termMonths: 12 });
    expect(calls[0]!.url).toBe("/api/supa-os/loan/calculate");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ principal: 100000, annualInterestRate: 12, termMonths: 12 });
  });
});

describe("supaOsApi.marketplace", () => {
  it("list() GETs with query params", async () => {
    setResponse(true, 200, { items: [], total: 0 });
    await supaOsApi.marketplace.list({ q: "fraud", type: "agent_skill", sort: "newest" });
    expect(calls[0]!.url).toContain("q=fraud");
    expect(calls[0]!.url).toContain("type=agent_skill");
    expect(calls[0]!.url).toContain("sort=newest");
  });

  it("review() POSTs to /marketplace/<id>/review", async () => {
    setResponse(true, 200, { item: {} });
    await supaOsApi.marketplace.review("item_001", { decision: "approve", notes: "Looks good" });
    expect(calls[0]!.url).toBe("/api/supa-os/marketplace/item_001/review");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ decision: "approve", notes: "Looks good" });
  });
});

// ───────────────────────────────────────────────
// governanceApi + expansionApi + builderApi
// ───────────────────────────────────────────────

describe("governanceApi", () => {
  it("killSwitches.list() GETs the kill switches", async () => {
    setResponse(true, 200, { switches: [], types: [] });
    await governanceApi.killSwitches.list();
    expect(calls[0]!.url).toBe("/api/governance/kill-switches");
  });

  it("audit.list() GETs with query params", async () => {
    setResponse(true, 200, { entries: [] });
    await governanceApi.audit.list({ category: "governance", limit: 50 });
    expect(calls[0]!.url).toContain("category=governance");
    expect(calls[0]!.url).toContain("limit=50");
  });
});

describe("expansionApi", () => {
  it("detection.run() POSTs the region code", async () => {
    setResponse(true, 200, {});
    await expansionApi.detection.run({ regionCode: "NG" });
    expect(calls[0]!.url).toBe("/api/expansion/detection");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ regionCode: "NG" });
  });
});

describe("builderApi.sessions", () => {
  it("updatePlan() PATCHes the plan", async () => {
    setResponse(true, 200, { updatedKeys: ["name"] });
    await builderApi.sessions.updatePlan("abc", { plan: { name: "New name" }, reason: "Renaming" });
    expect(calls[0]!.url).toBe("/api/builder/sessions/abc/plan");
    expect(calls[0]!.method).toBe("PATCH");
  });

  it("advance() POSTs the lifecycle action", async () => {
    setResponse(true, 200, { newStatus: "building" });
    await builderApi.sessions.advance("abc", { action: "advance", reason: "Next stage" });
    expect(calls[0]!.url).toBe("/api/builder/sessions/abc/lifecycle");
    expect(JSON.parse(calls[0]!.body!).action).toBe("advance");
  });
});

// ───────────────────────────────────────────────
// Error handling
// ───────────────────────────────────────────────

describe("ApiClientError", () => {
  it("throws ApiClientError with the right status + code on error responses", async () => {
    setResponse(false, 403, { code: "FORBIDDEN", message: "Insufficient role" });
    await expect(supaOsApi.build.get("abc")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 403,
      code: "FORBIDDEN",
      message: "Insufficient role",
    });
  });

  it("uses the right default code when error JSON is malformed", async () => {
    // Override nextResponse with one whose json() throws.
    nextResponse = {
      ok: false,
      status: 500,
      json: async () => { throw new Error("not JSON"); },
    };
    await expect(supaOsApi.build.get("abc")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });
});
