/**
 * GET /api/observability/onboarding-kpi
 *
 * Telemetry bridge: drain the onboarding KPI snapshot to the
 * observability channel. Reported per-window (e.g. every 5 min)
 * by the cron that also drains the crash + ai-quality queues.
 *
 * The session channel is the denominator — every onboarding metric
 * is reported as a rate against session count, not a raw count.
 */

import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { AdminAuthError } from "@/lib/admin/auth";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { computeOnboardingKpi } from "@/lib/onboarding/server-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const blocked = await guard(req, "default");
  if (blocked) return blocked;

  // Admin control-plane auth (separate from product auth). The onboarding KPI
  // snapshot is internal telemetry — restricted to control-plane admins (not
  // workspace admins). This uses the admin session (argon2id token, 8h cap,
  // MFA-gated, IP-bound) — a product session compromise grants zero access.
  try {
    await requireAdminSession(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return problem("UNAUTHENTICATED", {
        status: err.status,
        message: "Admin session required for onboarding KPIs.",
      });
    }
    throw err;
  }

  const snapshot = computeOnboardingKpi();
  return ok({
    snapshot,
    reportedAt: Date.now(),
  });
}
