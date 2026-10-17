// POST /api/builder/sessions/[id]/preview/[action]
//
// Performs a lifecycle action on the preview: sleep | wake | restart.
//
// Path:
//   id     — build session id
//   action — sleep | wake | restart
//
// Auth: admin senior.

import { NextRequest } from "next/server";
import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { PREVIEW_LIFECYCLE } from "@/lib/builder/live-preview";
import { ApiError } from "@/lib/http/middleware";
import { previewStore } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminOnly("senior", async (req, ctx) => {
  const params = (req as unknown as { params?: Record<string, string | undefined> }).params ?? {};
  const id = params.id;
  const action = params.action;
  if (!id || !action) throw new ApiError("not_found", 404, { param: "id-or-action" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const preview = previewStore.get(id);
  if (!preview) throw new ApiError("not_found", 404, { preview: id });

  const actionSpec = PREVIEW_LIFECYCLE.find((l) => l.action === action);
  if (!actionSpec) throw new ApiError("invalid_request", 400, { action });

  // Apply the lifecycle action.
  switch (action) {
    case "sleep":
      preview.status = "sleeping";
      break;
    case "wake":
      preview.status = "running";
      break;
    case "restart":
      preview.status = "running";
      preview.startedAt = new Date();
      break;
  }

  return okResponse({
    sessionId: id,
    action,
    actionSpec,
    preview,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
