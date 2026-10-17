// GET /api/builder/sessions/[id]
//
// Returns a single build session by id.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  return okResponse({ session });
});
