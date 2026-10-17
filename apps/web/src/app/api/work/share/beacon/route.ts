import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  shareLinkId: z.string().uuid(),
  durationMs: z.number().int().min(0).max(86_400_000), // max 24h
}).strict();

/**
 * POST /api/work/share/beacon
 *
 * Records dwell time for a share view. Called via the Beacon API when
 * the viewer navigates away from the page.
 *
 * No auth required — the shareLinkId is the only identifier.
 * The SECURITY DEFINER function `update_work_share_dwell` updates the
 * most recent share_view row.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  try {
    await (db as any).rpc("update_work_share_dwell", {
      p_share_link_id: parsed.data.shareLinkId,
      p_duration_ms: parsed.data.durationMs,
    });
  } catch {
    // Best-effort — beacon failures shouldn't error.
  }

  return ok({ recorded: true });
}
