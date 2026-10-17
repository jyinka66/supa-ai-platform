// POST /api/builder/sessions/[id]/handoff
//
// Hands off the build session to an AI employee — the AI employee will own
// the maintenance, monitoring, and iteration cycle going forward.
//
// Body:
//   employeeId: string
//   scope: "monitoring" | "maintenance" | "iteration" | "full"
//   cadence?: "daily" | "weekly" | "monthly"
//   autoDeploy?: boolean

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { handoffToEmployee, EMPLOYEE_WORKFLOW, type HandoffScope } from "@/lib/builder/ai-employee-handoff";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  employeeId: z.string().min(1).max(100),
  scope: z.enum(["monitor_only", "monitor_and_fix", "monitor_fix_and_improve"]) as z.ZodType<HandoffScope>,
  cadence: z.enum(["daily", "weekly", "monthly"]).optional(),
  autoDeploy: z.boolean().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const body = await parseJsonBody(req, BodySchema);

  const result = await handoffToEmployee({
    sessionId: id,
    employeeId: body.employeeId,
    scope: body.scope,
    cadence: body.cadence,
    autoDeploy: body.autoDeploy,
    handedOffBy: ctx.admin!.adminId,
  });

  return okResponse({
    sessionId: id,
    handoff: result,
    workflow: EMPLOYEE_WORKFLOW,
    handedOffBy: ctx.admin!.adminId,
    handedOffAt: new Date().toISOString(),
  });
});
