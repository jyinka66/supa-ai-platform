// POST /api/builder/sessions/[id]/lifecycle
//
// Advances / pauses / rolls back the build lifecycle stage.
//
// Body:
//   action: "advance" | "pause" | "resume" | "rollback"
//   targetStage?: BuildStage (only used for "rollback")
//   reason: string
//
// Auth: admin senior.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { getBuildSession, updateBuildSessionStatus, type BuildSessionStatus } from "@/lib/builder/build-session";
import { BUILD_STAGES, getStage, getStageByNumber } from "@/lib/builder/build-lifecycle";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["advance", "pause", "resume", "rollback"]),
  targetStage: z.enum([
    "planning", "scaffolding", "schema_design", "api_design", "security_design",
    "ui_design", "code_generation", "test_generation", "build", "preview", "deploy",
  ]).optional(),
  reason: z.string().min(5).max(500),
});

// Map lifecycle stages to build session status.
const STAGE_TO_STATUS: Record<string, BuildSessionStatus> = {
  planning: "planning",
  scaffolding: "planning",
  schema_design: "planning",
  api_design: "planning",
  security_design: "planning",
  ui_design: "planning",
  code_generation: "building",
  test_generation: "building",
  build: "building",
  preview: "previewing",
  testing: "testing",
  deploy: "deployed",
};

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const body = await parseJsonBody(req, BodySchema);

  let newStatus: BuildSessionStatus;
  switch (body.action) {
    case "advance":
      newStatus = body.targetStage
        ? STAGE_TO_STATUS[body.targetStage] ?? "building"
        : "building";
      break;
    case "pause":
      newStatus = "paused";
      break;
    case "resume":
      newStatus = "building";
      break;
    case "rollback":
      newStatus = body.targetStage
        ? STAGE_TO_STATUS[body.targetStage] ?? "planning"
        : "planning";
      break;
  }

  await updateBuildSessionStatus({
    sessionId: id,
    status: newStatus,
    updatedBy: ctx.admin!.adminId,
    reason: body.reason,
  });

  return okResponse({
    sessionId: id,
    action: body.action,
    newStatus,
    targetStage: body.targetStage,
    stages: BUILD_STAGES,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
