// POST /api/builder/sessions/[id]/versions/rollback
//
// Rolls back the build session to a previous version. Scope can be narrow
// (just code, just config) or full (all 9 dimensions).
//
// Body:
//   toVersion: string (semver or git sha)
//   scope: "full" | "code" | "schema" | "config" | "env" | "tests" | "ui" | "deps" | "migrations" | "docs"
//   reason: string

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { rollbackToVersion, type RollbackScope } from "@/lib/builder/app-versioning";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  toVersion: z.string().min(1).max(100),
  scope: z.enum(["full", "code", "schema", "config", "env", "tests", "ui", "deps", "migrations", "docs"]) as z.ZodType<RollbackScope>,
  reason: z.string().min(10).max(2000),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const body = await parseJsonBody(req, BodySchema);

  const result = await rollbackToVersion({
    sessionId: id,
    toVersion: body.toVersion,
    scope: body.scope,
    rolledBackBy: ctx.admin!.adminId,
    reason: body.reason,
  });

  return okResponse({
    sessionId: id,
    rollback: result,
    rolledBackBy: ctx.admin!.adminId,
    rolledBackAt: new Date().toISOString(),
  });
});
