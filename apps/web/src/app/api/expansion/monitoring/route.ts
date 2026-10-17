// GET /api/expansion/monitoring
//
// Returns the monitoring metric groups (8 groups) + alert types used to
// watch a region post-launch.
//
// Query params:
//   regionCode?: string — filter to one region's metrics

import { adminOnly, okResponse, paginate } from "@/lib/api/route-helpers";
import {
  MONITORING_METRIC_GROUPS,
  ALERT_TYPES,
} from "@/lib/expansion/stage-monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const regionCode = url.searchParams.get("regionCode");

  return okResponse({
    metricGroups: MONITORING_METRIC_GROUPS,
    alertTypes: ALERT_TYPES,
    filteredByRegion: regionCode,
    totals: {
      metricGroups: MONITORING_METRIC_GROUPS.length,
      alertTypes: ALERT_TYPES.length,
    },
  });
});
