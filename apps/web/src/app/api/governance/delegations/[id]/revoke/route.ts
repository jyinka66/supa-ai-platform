// POST /api/governance/delegations/[id]/revoke
//
// Revokes a delegation. Records who revoked it + why.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { revokeDelegation } from "@/lib/governance/delegations";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  reason: z.string().min(10).max(2000),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const body = await parseJsonBody(req, BodySchema);

  await revokeDelegation(id, ctx.admin!.adminId, body.reason);

  return okResponse({
    delegationId: id,
    revokedBy: ctx.admin!.adminId,
    revokedAt: new Date().toISOString(),
    reason: body.reason,
  });
});
