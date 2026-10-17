// GET /api/supa-os/catalog/sdk-endpoints
//
// Returns the SDK/API platform catalog — 16 API endpoints + 8 SDK languages +
// 13 OAuth scopes — used to build public API surfaces.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { API_ENDPOINTS, SDKS } from "@/lib/supa-os/sdk-api-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    endpoints: API_ENDPOINTS,
    sdks: SDKS,
    totalEndpoints: API_ENDPOINTS.length,
    totalSdks: SDKS.length,
  });
});
