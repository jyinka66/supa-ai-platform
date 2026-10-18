import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../src/client";

const databaseUrl =
  "postgresql://postgres:p%40ss%23word@db.ikugfclxahxvjduowjbo.supabase.co:5432/postgres?sslmode=require";
const baseEnv = {
  DATABASE_URL: databaseUrl,
  NEXT_PUBLIC_SUPABASE_URL: "https://ikugfclxahxvjduowjbo.supabase.co",
};

describe("resolveDatabaseUrl", () => {
  it("keeps DATABASE_URL unchanged without a pooler override", () => {
    expect(resolveDatabaseUrl(baseEnv)).toBe(databaseUrl);
  });

  it("uses the supplied transaction pooler host and preserves the existing password", () => {
    const resolved = new URL(resolveDatabaseUrl({
      ...baseEnv,
      SUPABASE_DB_POOLER_HOST: "aws-1-eu-west-1.pooler.supabase.com",
    }));

    expect(resolved.hostname).toBe("aws-1-eu-west-1.pooler.supabase.com");
    expect(resolved.port).toBe("6543");
    expect(resolved.username).toBe("postgres.ikugfclxahxvjduowjbo");
    expect(resolved.password).toBe("p%40ss%23word");
    expect(resolved.pathname).toBe("/postgres");
    expect(resolved.searchParams.get("sslmode")).toBe("require");
  });

  it("allows session-pooler port when explicitly configured", () => {
    const resolved = new URL(resolveDatabaseUrl({
      ...baseEnv,
      SUPABASE_DB_POOLER_HOST: "aws-1-eu-west-1.pooler.supabase.com",
      SUPABASE_DB_POOLER_PORT: "5432",
    }));
    expect(resolved.port).toBe("5432");
  });

  it("rejects a full URL instead of a hostname", () => {
    expect(() => resolveDatabaseUrl({
      ...baseEnv,
      SUPABASE_DB_POOLER_HOST: "postgres://user:secret@host.pooler.supabase.com:6543/postgres",
    })).toThrow("SUPABASE_DB_POOLER_HOST must be the hostname");
  });

  it("rejects unsupported pooler ports", () => {
    expect(() => resolveDatabaseUrl({
      ...baseEnv,
      SUPABASE_DB_POOLER_HOST: "aws-1-eu-west-1.pooler.supabase.com",
      SUPABASE_DB_POOLER_PORT: "1234",
    })).toThrow("SUPABASE_DB_POOLER_PORT must be 5432");
  });
});
