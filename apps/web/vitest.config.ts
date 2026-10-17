import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Vitest config — used by the `test` script (unit tests only).
 * E2E tests run via Playwright (see playwright.config.ts).
 *
 * Integration tests that need a real Postgres live in packages/db,
 * not here — this config is for component/hook unit tests.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@supa/db": resolve(__dirname, "../../packages/db/src"),
      "@supa/ui": resolve(__dirname, "../../packages/ui/src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "src/**/*.test.{ts,tsx}",
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.{ts,tsx}",
      "tests/i18n/**/*.test.{ts,tsx}",
      "tests/security/**/*.test.{ts,tsx}",
      "tests/phase1/**/*.test.{ts,tsx}",
    ],
    exclude: ["node_modules", ".next", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/messages/**"],
    },
    setupFiles: ["./tests/unit/setup.ts"],
  },
});
