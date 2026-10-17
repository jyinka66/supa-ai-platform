import { NextResponse } from "next/server";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

/**
 * GET /api/readyz
 *
 * Readiness check — verifies all dependencies are reachable.
 * Returns 200 if ALL checks pass, 503 if any fail.
 *
 * Unlike /api/health (which is a simple liveness check), /api/readyz
 * actually tests:
 *   - Database: SELECT 1
 *   - Redis: PING
 *
 * Used by load balancers / orchestrators to decide whether to route
 * traffic to this instance.
 */
export async function GET() {
  const checks: Record<string, "ok" | "fail" | "skip"> = {};

  // Database check.
  try {
    await db.execute(sql`SELECT 1`);
    checks.db = "ok";
  } catch {
    checks.db = "fail";
  }

  // Redis check.
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const redis = Redis.fromEnv();
      await redis.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "skip"; // not configured — don't fail readiness
    }
  } catch {
    checks.redis = "fail";
  }

  const allOk = Object.values(checks).every((v) => v === "ok" || v === "skip");

  return NextResponse.json(
    { status: allOk ? "ready" : "not_ready", checks },
    { status: allOk ? 200 : 503 },
  );
}
