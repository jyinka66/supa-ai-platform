// GET /api/expansion/success?regionCode=NG
//
// Measures whether a region has been successful post-launch. Computes a
// success verdict (successful | partial | not_successful) against the success
// criteria.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { measureRegionSuccess, SUCCESS_CRITERIA } from "@/lib/expansion/measurement-success";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const regionCode = url.searchParams.get("regionCode");
  if (!regionCode) {
    return okResponse({
      criteria: SUCCESS_CRITERIA,
      message: "Pass ?regionCode=NG to measure success.",
    });
  }
  const measurement = await measureRegionSuccess(regionCode);
  return okResponse({
    regionCode,
    measurement,
    criteria: SUCCESS_CRITERIA,
    measuredAt: new Date().toISOString(),
  });
});
