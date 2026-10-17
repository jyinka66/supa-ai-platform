// GET /api/expansion/public-launch
//
// Returns the public-launch checklist: 6 launch actions + 6 safeguards that
// must be in place before a region goes GA.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import {
  PUBLIC_LAUNCH_ACTIONS,
  PUBLIC_LAUNCH_SAFEGUARDS,
} from "@/lib/expansion/stage-public-launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    actions: PUBLIC_LAUNCH_ACTIONS,
    safeguards: PUBLIC_LAUNCH_SAFEGUARDS,
    totalActions: PUBLIC_LAUNCH_ACTIONS.length,
    totalSafeguards: PUBLIC_LAUNCH_SAFEGUARDS.length,
  });
});
