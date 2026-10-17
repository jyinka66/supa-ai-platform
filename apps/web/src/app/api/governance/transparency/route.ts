// GET /api/governance/transparency
// POST /api/governance/transparency
//
// GET: returns transparency log entries (filtered by user/workspace).
// POST: appends a transparency entry (used internally by the engine).

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody, paginate } from "@/lib/api/route-helpers";
import {
  logTransparency,
  getUserTransparency,
  getWorkspaceTransparency,
  type TransparencyEntry,
} from "@/lib/governance/transparency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const wsId = url.searchParams.get("wsId");
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

  let entries: TransparencyEntry[];
  if (userId) {
    entries = await getUserTransparency(userId, limit);
  } else if (wsId) {
    entries = await getWorkspaceTransparency(wsId, limit);
  } else {
    entries = []; // Need at least one filter.
  }

  return okResponse({
    entries,
    total: entries.length,
    filter: { userId, wsId, limit },
  });
});

const BodySchema = z.object({
  userId: z.string().min(1).max(100).optional(),
  wsId: z.string().uuid().optional(),
  actionType: z.string().min(3).max(100),
  targetType: z.string().min(2).max(50),
  targetId: z.string().min(1).max(200),
  decision: z.string().min(2).max(50),
  riskLevel: z.enum(["low", "medium", "high", "critical", "irreversible"]),
  policyKey: z.string().max(100).optional(),
  reasoningSummary: z.string().min(5).max(2000),
  userVisible: z.boolean().optional(),
  userMessage: z.string().max(2000).optional(),
  auditorVisible: z.boolean().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const entry = await logTransparency({
    ...body,
  }).catch((err) => {
    // Log the error but don't fail the request — transparency log failures
    // are non-fatal.
    console.error("[transparency] logTransparency failed:", err);
    return null;
  });

  return okResponse({
    entry,
    loggedBy: ctx.admin!.adminId,
    loggedAt: new Date().toISOString(),
  });
});
