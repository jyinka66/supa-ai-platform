// POST /api/governance/rollback
//
// Rolls back a previously-applied policy decision. Records who rolled it back
// + why. Only reversible decisions can be rolled back.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { rollbackPolicy, ROLLBACK_PATHS } from "@/lib/governance/rollback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  targetId: z.string().min(1).max(200),
  reason: z.string().min(10).max(2000),
  toVersion: z.number().int().min(0).optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const result = await rollbackPolicy({
    targetId: body.targetId,
    rolledBackBy: ctx.admin!.adminId,
    reason: body.reason,
    toVersion: body.toVersion,
  });

  return okResponse({
    result,
    rollbackPaths: ROLLBACK_PATHS,
    rolledBackBy: ctx.admin!.adminId,
    rolledBackAt: new Date().toISOString(),
  });
});
