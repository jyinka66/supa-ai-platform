import { defineConfig } from "vitest/config";

/**
 * Integration test config — runs against a real Postgres instance
 * with migrations applied. Used by the CI `integration` job.
 *
 * Required env vars (see .env.example):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 *   DATABASE_URL
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./tests/setup.ts"],
  },
});
