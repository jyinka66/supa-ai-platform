import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { setFlag, getFlag, FlagError, isConfirmationRequired } from "@/lib/feature-flags/service";
import { ConfirmationRequiredError } from "@/lib/admin/confirmation";
import { queryAdminAudit } from "@/lib/admin/audit";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/feature-flags/:key/rollback/:auditSeq
 *
 * One-click rollback — revert a flag to its state before the audit entry
 * at :auditSeq. Reads the audit log entry's `old` field (the before-state
 * of that change) + applies it as a new patch.
 *
 * Rollback is itself logged (a new audit entry with old=current, new=old).
 * This gives a full history: every change + every rollback is audited.
 *
 * Auth: admin session with minRole="owner".
 *
 * The rollback goes through `setFlag` (same confirmation flow — if the flag
 * is a kill_switch, the rollback requires 2nd-admin approval too).
 *
 * Response 200: the reverted flag + the new audit seq.
 * Response 202: confirmation required (kill_switch rollback — 2nd admin needed).
 * Response 404: audit entry not found, or the flag doesn't exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string; auditSeq: string }> },
) {
  const rid = requestId(req);
  const { key, auditSeq: auditSeqStr } = await params;
  try {
    const ctx = await requireAdminSession(req, "owner");
    const auditSeq = parseInt(auditSeqStr, 10);
    if (isNaN(auditSeq)) {
      return NextResponse.json({ error: "invalid_audit_seq" }, { status: 400 });
    }

    // Fetch the audit entry — the `diff.old` field is the state to revert to.
    const entries = await queryAdminAudit({ action: `flag.feature.set`, limit: 1000 });
    // Also check kill_switch set actions.
    const killEntries = await queryAdminAudit({ action: `flag.kill_switch.set`, limit: 1000 });
    const allEntries = [...entries, ...killEntries];
    const entry = allEntries.find((e) => e.seq === auditSeq);
    if (!entry) {
      return NextResponse.json({ error: "audit_entry_not_found" }, { status: 404 });
    }

    // The diff.old is the before-state of that change. We revert to it.
    const oldState = entry.diff?.old as Record<string, unknown> | undefined;
    if (!oldState) {
      return NextResponse.json(
        { error: "no_old_state_in_audit_entry" },
        { status: 400 },
      );
    }

    // Build the rollback patch from the old state.
    const rollbackPatch = {
      ...(oldState.enabled !== undefined ? { enabled: oldState.enabled as boolean } : {}),
      ...(oldState.rolloutPct !== undefined ? { rolloutPct: oldState.rolloutPct as number } : {}),
      ...(oldState.targets !== undefined ? { targets: oldState.targets as any } : {}),
      ...(oldState.kind !== undefined ? { kind: oldState.kind as any } : {}),
    };

    // Apply the rollback via setFlag (same confirmation flow).
    const result = await setFlag(
      { adminId: ctx.adminId, role: ctx.role, sessionId: ctx.sessionId, ip: ctx.ip },
      key,
      rollbackPatch,
      `rollback to seq ${auditSeq} (one-click revert)`,
      {},
    );

    const res = NextResponse.json(
      { flag: result.flag, auditSeq: result.auditSeq, rolled_back_from: auditSeq },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof ConfirmationRequiredError) {
      // Kill_switch rollback needs 2nd-admin approval.
      return NextResponse.json(
        { confirmationRequired: true, confirmationId: err.confirmationId, phrase: err.phrase },
        { status: 202 },
      );
    }
    if (err instanceof FlagError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/feature-flags/${key}/rollback/${auditSeqStr}`);
  }
}
