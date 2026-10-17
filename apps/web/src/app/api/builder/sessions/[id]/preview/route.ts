// POST /api/builder/sessions/[id]/preview
// DELETE /api/builder/sessions/[id]/preview
//
// Starts / stops the live preview for a build session.

import { NextRequest } from "next/server";
import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { PREVIEW_GUARANTEES, PREVIEW_LIFECYCLE, verifyLivePreview } from "@/lib/builder/live-preview";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-memory preview instances — Phase 2 swaps for a real WebContainer pool.
// Exported so the [action] subroute can share state.
export const previewStore = new Map<string, { port: number; status: string; startedAt: Date }>();

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const port = 3000 + (Math.floor(Math.random() * 1000));
  previewStore.set(id, { port, status: "running", startedAt: new Date() });

  return okResponse({
    sessionId: id,
    preview: {
      port,
      status: "running",
      startedAt: previewStore.get(id)!.startedAt,
      url: `https://preview-${id}.supa-hosting.local:${port}`,
    },
    guarantees: PREVIEW_GUARANTEES,
    lifecycleActions: PREVIEW_LIFECYCLE,
    verification: verifyLivePreview(),
    startedBy: ctx.admin!.adminId,
  });
});

export const DELETE = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const preview = previewStore.get(id);
  if (preview) {
    previewStore.delete(id);
    return okResponse({ sessionId: id, stopped: true, port: preview.port });
  }
  return okResponse({ sessionId: id, stopped: false, message: "no preview running" });
});
