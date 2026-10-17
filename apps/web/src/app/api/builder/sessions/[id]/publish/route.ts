// POST /api/builder/sessions/[id]/publish
//
// Publishes a build session to a target (supa_hosting, custom_domain,
// vercel, netlify, app_store, play_store).
//
// Body:
//   target: PublishTargetId
//
// Returns: { result, targetSpec }
//
// Auth: admin senior — publishing is irreversible.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody, withRateLimit } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { publishToTarget, PUBLISH_TARGETS, verifyPublishTargets } from "@/lib/builder/publish-targets";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  target: z.enum(["supa_hosting", "custom_domain", "git_repository", "cloud_deployment", "app_store", "google_play"]),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  // Rate limit: 3 publishes per admin per minute (supaOsPublish tier).
  // Publishes are irreversible + cost store/marketplace fees.
  const rl = await withRateLimit(req, ctx.admin!.adminId);
  if (rl) return rl;

  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const body = await parseJsonBody(req, BodySchema);

  const result = await publishToTarget({
    sessionId: id,
    target: body.target,
    publishedBy: ctx.admin!.adminId,
  });

  return okResponse({
    sessionId: id,
    result,
    target: body.target,
    targets: PUBLISH_TARGETS,
    verification: verifyPublishTargets(),
    publishedBy: ctx.admin!.adminId,
    publishedAt: new Date().toISOString(),
  });
});
