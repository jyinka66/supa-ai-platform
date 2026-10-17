// PATCH /api/builder/sessions/[id]/plan
//
// Updates one or more plan elements of a build session (e.g. change the
// database schema, swap the auth method, change the deployment target).
//
// Body: Partial<Record<PlanElementId, unknown>>
//
// Auth: admin senior — plan changes can invalidate the build.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { getBuildSession, updateBuildSessionPlan, type PlanElementId } from "@/lib/builder/build-session";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  plan: z.record(z.string(), z.unknown()),
  reason: z.string().min(5).max(500),
}).refine((b) => Object.keys(b.plan).length > 0, { message: "plan must not be empty" });

export const PATCH = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const body = await parseJsonBody(req, BodySchema);

  await updateBuildSessionPlan({
    sessionId: id,
    plan: body.plan as Partial<Record<PlanElementId, unknown>>,
    updatedBy: ctx.admin!.adminId,
  });

  return okResponse({
    sessionId: id,
    updatedKeys: Object.keys(body.plan),
    reason: body.reason,
    updatedAt: new Date().toISOString(),
  });
});
