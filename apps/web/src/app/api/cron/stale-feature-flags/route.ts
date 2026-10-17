import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { listStaleFlags, type StaleFlag } from "@/lib/feature-flags/service";
import { adminAudit } from "@/lib/admin/audit";

/**
 * POST /api/cron/stale-feature-flags
 *
 * Nightly staleness check. Lists feature flags that have been enabled > 90
 * days (stale) + pages the owner for flags > 180 days.
 *
 * The spec: "nightly job lists flags enabled > 90 with no code reference in
 * latest deploys (flag key grepped from build manifests) → flags list shows
 * 'stale' badge; owner paged after 180 days. Flags die; they don't accumulate."
 *
 * The code-reference check (grepping build manifests) is deployment-specific +
 * not implementable in the app layer without a build-manifest API. We implement
 * the time-based staleness + emit audit alerts for page-owner flags.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual — C4 fix).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  return safeEqual(authHeader, expected);
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const staleFlags = await listStaleFlags();

  // For page-owner flags (> 180 days), emit an audit alert.
  const pageOwnerFlags = staleFlags.filter((f) => f.pageOwner);
  for (const flag of pageOwnerFlags) {
    try {
      await adminAudit({
        actor: "system",
        action: "flag.stale.page_owner",
        target: {
          key: flag.key,
          owner: flag.owner,
          daysEnabled: flag.daysEnabled,
        },
        justification: `nightly staleness check — flag enabled for ${flag.daysEnabled} days (> 180 threshold)`,
      });
    } catch {
      // Audit failure must not fail the cron.
      console.error("[stale-flags-cron] audit failed for", flag.key);
    }
  }

  return NextResponse.json({
    staleCount: staleFlags.length,
    pageOwnerCount: pageOwnerFlags.length,
    staleFlags: staleFlags.map((f) => ({
      key: f.key,
      owner: f.owner,
      daysEnabled: f.daysEnabled,
      stale: f.stale,
      pageOwner: f.pageOwner,
    })),
  });
}

export const GET = POST;
