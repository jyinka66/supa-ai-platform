import { test, expect } from "@playwright/test";

/**
 * Smoke tests — critical-path checks that gate PR merge.
 * See .github/workflows/ci.yml `smoke` job.
 */

test.describe("health", () => {
  test("GET /api/health returns 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

test.describe("security headers", () => {
  test("CSP, HSTS, X-Frame-Options are set", async ({ request }) => {
    const res = await request.get("/");
    const headers = res.headers();

    expect(headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

test.describe("locale rendering", () => {
  test("/en renders in English (LTR)", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("/ar renders in Arabic (RTL)", async ({ page }) => {
    await page.goto("/ar/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("/ar shows translated strings, not English fallback", async ({ page }) => {
    await page.goto("/ar/login");
    // Arabic for "Sign in" — must not match the English "Sign in"
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/تسجيل الدخول/);
  });

  test("invalid locale falls back to 404 (not 500)", async ({ page }) => {
    const res = await page.goto("/xx/login");
    expect(res?.status()).toBe(404);
  });
});

test.describe("trace-id propagation", () => {
  test("incoming x-trace-id is echoed back", async ({ request }) => {
    const res = await request.get("/", {
      headers: { "x-trace-id": "11111111-1111-1111-1111-111111111111" },
    });
    expect(res.headers()["x-trace-id"]).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("missing x-trace-id generates a UUID", async ({ request }) => {
    const res = await request.get("/");
    const traceId = res.headers()["x-trace-id"];
    expect(traceId).toBeTruthy();
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("malformed x-trace-id is rejected and replaced", async ({ request }) => {
    const res = await request.get("/", {
      headers: { "x-trace-id": "'; DROP TABLE logs; --" },
    });
    const traceId = res.headers()["x-trace-id"];
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

test.describe("CSRF protection", () => {
  test("POST without Origin header is rejected", async ({ request }) => {
    const res = await request.post("/api/auth/signup", {
      data: { email: "x@y.z", password: "0123456789ab" },
      headers: { origin: "" },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF: invalid origin");
  });

  test("POST with mismatched Origin is rejected", async ({ request }) => {
    const res = await request.post("/api/auth/signup", {
      data: { email: "x@y.z", password: "0123456789ab" },
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });
});
