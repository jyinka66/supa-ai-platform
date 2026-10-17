import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listActiveKillSwitches } from "@/lib/feature-flags/service";
import { listOverdueReviews } from "@/lib/admin/invite";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/status
 *
 * System status overview (owner-only). The ops dashboard landing page —
 * shows the current health of the control plane at a glance:
 *
 *   - activeKillSwitches: features currently emergency-disabled.
 *   - activeAdminSessions: count of non-revoked, non-expired admin sessions.
 *   - totalAdmins: count of active (non-revoked) admins.
 *   - overdueReviews: admins not quarterly-reviewed in > 90 days.
 *   - pendingConfirmations: 2nd-admin approvals awaiting action.
 *   - recentAuditEvents: the last 10 admin audit log entries (for the activity feed).
 *   - auditChainOk: whether the nightly audit-chain verification passed.
 *
 * Auth: admin session (any role — read-only status, no mutation). The route
 * is for ops monitoring — read_only admins can view it (they need to see
 * kill switches + alerts).
 *
 * Response 200: { ... } (see above fields)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StatusResponse {
  activeKillSwitches: Array<{ key: string; description: string; owner: string; updatedAt: string }>;
  activeAdminSessions: number;
  totalAdmins: number;
  overdueReviews: number;
  pendingConfirmations: number;
  recentAuditEvents: Array<{
    seq: number;
    actorId: string;
    action: string;
    ts: string;
  }>;
  auditChainOk: boolean;
  generatedAt: string;
}

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    // Any admin role can view status (read_only included — they need to see kill switches).
    await requireAdminSession(req);

    // Run the independent queries in parallel.
    const [killSwitches, overdueReviews, counts, recentEvents, auditChain] = await Promise.all([
      listActiveKillSwitches(),
      listOverdueReviews(),
      // Counts: active admin sessions + total admins + pending confirmations.
      db.execute(sql`
        select
          (select count(*)::integer from admin_sessions where revoked_at is null and expires_at > now() and idle_expires_at > now()) as active_sessions,
          (select count(*)::integer from admin_users where revoked_at is null and accepted_at is not null) as total_admins,
          (select count(*)::integer from admin_confirmations where status = 'pending' and expires_at > now()) as pending_confirmations
      `),
      // Recent audit events (last 10).
      db.execute(sql`
        select seq, actor_id, action, ts
          from admin_audit_log
         order by seq desc
         limit 10
      `),
      // Audit chain verification (best-effort — if the function fails, report ok=false).
      db.execute(sql`select * from admin_audit_log_verify_chain()`).catch(() => [{ ok: false, broken_at_seq: null }]),
    ]);

    const countRow = (counts as unknown as Array<{ active_sessions: number; total_admins: number; pending_confirmations: number }>)[0];
    const eventRows = recentEvents as unknown as Array<{ seq: number; actor_id: string; action: string; ts: Date }>;
    const chainRow = (auditChain as unknown as Array<{ ok: boolean; broken_at_seq: number | null }>)[0];

    const status: StatusResponse = {
      activeKillSwitches: killSwitches.map((k) => ({
        key: k.key,
        description: k.description,
        owner: k.owner,
        updatedAt: k.updatedAt.toISOString(),
      })),
      activeAdminSessions: Number(countRow?.active_sessions ?? 0),
      totalAdmins: Number(countRow?.total_admins ?? 0),
      overdueReviews: overdueReviews.length,
      pendingConfirmations: Number(countRow?.pending_confirmations ?? 0),
      recentAuditEvents: eventRows.map((e) => ({
        seq: e.seq,
        actorId: e.actor_id,
        action: e.action,
        ts: e.ts.toISOString(),
      })),
      auditChainOk: chainRow?.ok ?? false,
      generatedAt: new Date().toISOString(),
    };

    const res = NextResponse.json(status, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/status");
  }
}
