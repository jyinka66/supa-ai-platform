import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { previewImpact, type FlagKind, type FlagTargets } from "@/lib/feature-flags/service";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/feature-flags/:key/preview
 *
 * Preview the impact of a flag patch — count how many users/workspaces would
 * be affected. Shown in the UI before the confirm button enables.
 *
 * Auth: admin session (any role — read-only preview, no mutation).
 *
 * Body: the same shape as PATCH (kind, enabled, rolloutPct, targets, etc.)
 *
 * Response 200:
 *   {
 *     "usersAffected": 1234,
 *     "workspacesAffected": 56,
 *     "payingAffected": 789,
 *     "rolloutPct": 50,
 *     "enabled": true
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PreviewBody = z.object({
  kind: z.enum(["feature", "kill_switch"]).optional(),
  enabled: z.boolean().optional(),
  rolloutPct: z.number().int().min(0).max(100).optional(),
  targets: z.object({
    plans: z.array(z.string()).optional(),
    workspaces: z.array(z.string().uuid()).optional(),
    users: z.array(z.string().uuid()).optional(),
  }).optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rid = requestId(req);
  const { key } = await params;
  try {
    // Any admin role can preview (read-only — no mutation).
    await requireAdminSession(req);

    const body = await req.json();
    const parsed = PreviewBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const result = await previewImpact(key, {
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind as FlagKind } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.rolloutPct !== undefined ? { rolloutPct: parsed.data.rolloutPct } : {}),
      ...(parsed.data.targets !== undefined ? { targets: parsed.data.targets as FlagTargets } : {}),
    });

    const res = NextResponse.json(result, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/api/admin/feature-flags/${key}/preview`);
  }
}
