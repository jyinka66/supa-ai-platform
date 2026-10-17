/**
 * Tests for the shared API route helpers.
 *
 * Verifies:
 *   - paginate() parses ?page= + ?pageSize= correctly (with bounds).
 *   - parseJsonBody() accepts valid input, rejects malformed JSON, rejects
 *     schema-violating input.
 *   - okResponse() wraps data in the {ok:true, data:...} envelope.
 *   - withHandler() catches thrown errors and returns a problem response.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  paginate,
  parseJsonBody,
  okResponse,
  withHandler,
} from "@/lib/api/route-helpers";
import { ApiError } from "@/lib/http/middleware";

// ───────────────────────────────────────────────
// paginate
// ───────────────────────────────────────────────

describe("paginate", () => {
  it("returns defaults when no query params are present", () => {
    const url = new URL("https://example.com/api/foo");
    const p = paginate(url);
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(20);
    expect(p.skip).toBe(0);
    expect(p.take).toBe(20);
  });

  it("respects custom pageSize", () => {
    const url = new URL("https://example.com/api/foo?page=3&pageSize=50");
    const p = paginate(url);
    expect(p.page).toBe(3);
    expect(p.pageSize).toBe(50);
    expect(p.skip).toBe(100);
    expect(p.take).toBe(50);
  });

  it("clamps pageSize to the max", () => {
    const url = new URL("https://example.com/api/foo?pageSize=10000");
    const p = paginate(url, { maxPageSize: 100 });
    expect(p.pageSize).toBe(100);
  });

  it("clamps page to >= 1", () => {
    const url = new URL("https://example.com/api/foo?page=-5");
    const p = paginate(url);
    expect(p.page).toBe(1);
  });

  it("falls back to defaults when query params are non-numeric", () => {
    const url = new URL("https://example.com/api/foo?page=abc&pageSize=xyz");
    const p = paginate(url);
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(20);
  });
});

// ───────────────────────────────────────────────
// parseJsonBody
// ───────────────────────────────────────────────

describe("parseJsonBody", () => {
  function makeReq(body: unknown): NextRequest {
    return new NextRequest("https://example.com/api/foo", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("accepts valid input matching the schema", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const req = makeReq({ name: "Alice", age: 30 });
    const parsed = await parseJsonBody(req, schema);
    expect(parsed).toEqual({ name: "Alice", age: 30 });
  });

  it("throws ApiError(400, invalid_json) on malformed JSON", async () => {
    const req = new NextRequest("https://example.com/api/foo", {
      method: "POST",
      body: "not valid json",
      headers: { "Content-Type": "application/json" },
    });
    await expect(parseJsonBody(req, z.object({}))).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "invalid_json",
    });
  });

  it("throws ApiError(400, validation_failed) when schema rejects", async () => {
    const schema = z.object({ name: z.string().min(3) });
    const req = makeReq({ name: "a" }); // too short
    await expect(parseJsonBody(req, schema)).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
    });
  });
});

// ───────────────────────────────────────────────
// okResponse
// ───────────────────────────────────────────────

describe("okResponse", () => {
  it("wraps payload in the success envelope", () => {
    const res = okResponse({ foo: "bar" });
    expect(res.status).toBe(200);
    return expect(res.json()).resolves.toEqual({ ok: true, data: { foo: "bar" } });
  });

  it("honors a custom status code", () => {
    const res = okResponse({ created: true }, 201);
    expect(res.status).toBe(201);
  });
});

// ───────────────────────────────────────────────
// withHandler
// ───────────────────────────────────────────────

describe("withHandler", () => {
  it("passes through a successful response", async () => {
    const handler = withHandler(() => okResponse({ hello: "world" }));
    const req = new NextRequest("https://example.com/api/foo");
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: { hello: "world" } });
  });

  it("catches ApiError and returns a problem response with the right status", async () => {
    const handler = withHandler(() => {
      throw new ApiError("not_found", 404);
    });
    const req = new NextRequest("https://example.com/api/foo");
    const res = await handler(req);
    expect(res.status).toBe(404);
  });

  it("catches unknown errors and returns 500", async () => {
    const handler = withHandler(() => {
      throw new Error("boom");
    });
    const req = new NextRequest("https://example.com/api/foo");
    const res = await handler(req);
    expect(res.status).toBe(500);
  });

  it("sets the X-Request-Id header on the response", async () => {
    const handler = withHandler(() => okResponse({}));
    const req = new NextRequest("https://example.com/api/foo", {
      headers: { "x-request-id": "req_12345" },
    });
    const res = await handler(req);
    expect(res.headers.get("X-Request-Id")).toBe("req_12345");
  });
});
