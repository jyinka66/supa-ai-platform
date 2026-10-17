import { beforeAll } from "vitest";

beforeAll(() => {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "DATABASE_URL",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for integration tests: ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and run: pnpm supabase:start && pnpm supabase:reset`,
    );
  }
});
