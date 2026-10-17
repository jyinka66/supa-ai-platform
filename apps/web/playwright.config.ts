import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — used by the `test:e2e` script and the CI `smoke` job.
 *
 * Smoke suite: locale rendering, RTL for /ar, /api/health 200, security headers.
 * Full E2E: see tests/e2e/*.spec.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: {
      "x-trace-id": "playwright-smoke",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Mobile + RTL runs only in CI to keep local dev fast.
    ...(process.env.CI
      ? [
          {
            name: "mobile-chrome",
            use: { ...devices["Pixel 7"] },
          },
          {
            name: "rtl-firefox",
            use: { ...devices["Desktop Firefox"], locale: "ar" },
          },
        ]
      : []),
  ],
  webServer: process.env.CI
    ? {
        command: "pnpm start",
        url: "http://localhost:3000",
        timeout: 120_000,
        reuseExistingServer: false,
      }
    : undefined,
});
