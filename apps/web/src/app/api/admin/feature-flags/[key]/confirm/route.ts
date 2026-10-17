import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { approveConfirmation, ConfirmationError } from "@/lib/admin/confirmation";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/feature-flags/:key/confirm
 *
 * Approve a pending 2nd-admin confirmation for a kill_switch flag change.
 *
 * The two-person rule: the approver must be a DIFFERENT owner than the
 * requester. A single compromised owner can't flip a kill_switch alone.
 *
 * Auth: admin session with minRole="owner".
 *
 * Body: { "confirmationId": "..." }
 *
 * Response 200: { "ok": true, "approved": true, "patch": {...} }
 *   The patch is returned so the UI can show what was approved. The actual
 *   flag update is applied when the ORIGINAL requester re-calls PATCH with
 *   the confirmationId (the setFlag flow re-runs + applies the patch).
 *
 * Alternative flow: the confirm endpoint could apply the patch directly
 * (since the patch is stored in the confirmation). But keeping the apply
 * in the original requester's call means the audit log records the
 * requester as the actor (not the approver) — cleaner attribution.
 *
 * Response 403: approver is the same as the requester.
 * Response 404: confirmation not found.
 * Response 409: already approved/rejected/expired.
 * Response 410: expired.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConfirmBody = z.object({
  confirmationId: z.string().uuid(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rid = requestId(req);
  const { key: _key } = await params;
  try {
    // Owner-only — the 2nd admin must be an owner.
    const ctx = await requireAdminSession(req, "owner");

    const body = await req.json();
    const parsed = ConfirmBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const conf = await approveConfirmation(parsed.data.confirmationId, ctx.adminId);

    const res = NextResponse.json(
      { ok: true, approved: true, patch: conf.patch },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof ConfirmationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/feature-flags/${_key}/confirm`);
  }
}
