import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@supa/db";
import { pino } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Liveness check — is this instance alive + able to reach its dependencies?
 *
 * Checks:
 *   - db: SELECT 1 (primary database connectivity).
 *   - redis: env-configured (UPSTASH_REDIS_REST_URL presence — a PING is
 *     too expensive for every liveness probe; the readyz route does the PING).
 *   - feature_flags: SELECT 1 FROM feature_flags LIMIT 1 (the control-plane
 *     table must be reachable — isEnabled hot path depends on it).
 *
 * Returns 200 if ALL checks pass, 503 if any fail. Used by liveness probes
 * (orchestrators restart unhealthy instances).
 */
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {};

  // Database check — single tiny query (SELECT 1).
  try {
    await db.execute(sql`SELECT 1`);
    checks.db = "ok";
  } catch (err) {
    pino.warn({ event: "healthcheck_db_failed", err: String(err) });
    checks.db = "fail";
  }

  // Feature flags table check — the control-plane table must be reachable
  // (isEnabled hot path depends on it). A failure here means the feature_flags
  // migration hasn't been applied OR the table is inaccessible.
  try {
    await db.execute(sql`SELECT 1 FROM feature_flags LIMIT 1`);
    checks.feature_flags = "ok";
  } catch (err) {
    pino.warn({ event: "healthcheck_feature_flags_failed", err: String(err) });
    checks.feature_flags = "fail";
  }

  // Redis check — skip if env not set (local dev).
  checks.redis = process.env.UPSTASH_REDIS_REST_URL ? "ok" : "fail";

  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: ok ? "ok" : "degraded", checks },
    { status: ok ? 200 : 503 },
  );
}
