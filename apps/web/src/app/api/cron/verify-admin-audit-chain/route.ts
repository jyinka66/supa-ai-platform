import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { verifyAdminAuditChain } from "@/lib/admin/audit";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";

/**
 * POST /api/cron/verify-admin-audit-chain
 *
 * Nightly verification of the admin audit log hash chain. Recomputes every
 * hash + compares to the stored hash. If any mismatch is detected, the chain
 * is broken (someone with DB access tampered with the log) → emit a
 * CRITICAL alert via the audit log itself (the only writable path).
 *
 * The spec: "Nightly verification job (same pattern as Phase 1): recompute
 * chain, compare, alert-critical on mismatch. Retention: indefinite. Table is
 * insert-only — no UPDATE/DELETE grants exist for any role including service
 * roles in this DB."
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual — C4 fix).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  return safeEqual(authHeader, expected);
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const verification = await verifyAdminAuditChain();

  if (!verification.ok) {
    // CRITICAL alert — the chain is broken. Emit an audit entry (the only
    // writable path) + log loudly.
    //
    // This is a security incident — the admin audit log is the forensic
    // guarantee. A break means someone with DB access modified or deleted
    // entries (UPDATE/DELETE are revoked from all roles, so this requires
    // superuser access — a serious compromise).
    //
    // The ops team monitors for 'admin.audit_chain.broken' alerts + pages
    // the on-call security engineer.
    try {
      await db.execute(sql`
        select admin_audit_log_append(
          'system',
          'admin.audit_chain.broken',
          jsonb_build_object('broken_at_seq', ${verification.brokenAtSeq}),
          'NIGHTLY VERIFICATION: hash chain broken at seq — possible tamper',
          null::jsonb,
          null::inet,
          null::text
        )
      `);
    } catch {
      // If the audit append itself fails (e.g., the log is so damaged the
      // function can't run), we can't record the alert via the audit log.
      // Fall back to console.error (the cron runner captures stderr).
      console.error(
        "[CRITICAL] admin audit chain broken at seq",
        verification.brokenAtSeq,
        "AND the alert append failed — the audit log may be severely damaged.",
      );
    }

    return NextResponse.json(
      {
        ok: false,
        brokenAtSeq: verification.brokenAtSeq,
        alert: "CRITICAL — hash chain broken, possible tamper detected.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, brokenAtSeq: null });
}

export const GET = POST;
