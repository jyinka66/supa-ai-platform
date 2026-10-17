// Admin control-plane audit log — hash-chained, tamper-evident, insert-only.
//
// SEPARATE from the product audit (enterprise_audit_log_append). The admin
// audit records control-plane actions: admin invites, removals, role changes,
// MFA resets, session revocations, sensitive reads (user data access),
// quarterly reviews. It's the forensic trail for "who did what in the admin
// control plane" — critical for compliance (SOC2, ISO 27001) + incident response.
//
// ── adminAudit(evt) ──
//   Appends a hash-chained entry via the security-definer function
//   `admin_audit_log_append`. The function:
//     1. Acquires an advisory_xact_lock (serializes appends — low volume).
//     2. Reads the chain tip (SELECT ... ORDER BY seq DESC LIMIT 1).
//     3. Computes hash = sha256(prev_hash || canonical(body)).
//     4. INSERTs (seq, prev_hash, hash, body).
//
//   The `justification` field is MANDATORY for:
//     - Sensitive reads (action like 'admin.user_data.%')
//     - All writes on user data (action like 'admin.%_write')
//   The DB CHECK constraints enforce this, but we check in the service for
//   a clear error (before hitting the DB).
//
//   The `diff` field stores { old, new } for mutations — the spec's `old?` +
//   `new?` params. Stored as a single jsonb column (cleaner than two columns).
//
// ── verifyAdminAuditChain() ──
//   Nightly verification — recompute the chain + compare. Returns
//   { ok: boolean, brokenAtSeq: number | null }. If ok=false, brokenAtSeq is
//   the first seq where the recomputed hash doesn't match (the tamper point).
//
// ── Insert-only ──
//   No UPDATE/DELETE grants exist for ANY role (including service roles).
//   The only insert path is the security-definer function. RLS denies direct
//   inserts. This is the tamper-evidence guarantee: once written, an entry
//   can't be modified without breaking the chain (which verifyAdminAuditChain
//   detects).

import { db } from "@supa/db";
import { sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface AdminAuditEvent {
  /** The actor's admin user_id (or 'system' / 'migration-XXXX'). */
  actor: string;
  /** Namespaced action: admin.invited, admin.removed, admin.mfa_reset, admin.session.revoked, admin.user_data.read, ... */
  action: string;
  /** Resource refs. NEVER raw secrets/PII beyond ids. */
  target?: Record<string, unknown>;
  /**
   * REQUIRED for sensitive reads (action like 'admin.user_data.%') + all
   * writes on user data (action like 'admin.%_write'). NULL = routine action.
   * Documents WHY the admin took this action — for compliance + forensics.
   */
  justification?: string;
  /** { old, new } for mutations. NULL for reads/creates. */
  old?: unknown;
  new?: unknown;
  /** The requesting IP (from x-forwarded-for). */
  ip?: string;
  /** The user-agent string. */
  userAgent?: string;
}

export interface AdminAuditResult {
  id: string;
  seq: number;
}

export interface AdminAuditChainVerification {
  ok: boolean;
  /** If ok=false, the first seq where the recomputed hash doesn't match. */
  brokenAtSeq: number | null;
}

// ───────────────────────────────────────────────
// adminAudit — append a hash-chained entry
// ───────────────────────────────────────────────

/**
 * Append an entry to the admin audit log. Hash-chained + tamper-evident.
 *
 * Flow (delegates to the security-definer function `admin_audit_log_append`):
 *   1. Advisory lock (serialize appends).
 *   2. Read chain tip (prev_hash).
 *   3. Compute hash = sha256(prev_hash || canonical(body)).
 *   4. INSERT.
 *
 * The `justification` field is MANDATORY for:
 *   - Sensitive reads: action starting with 'admin.user_data.'
 *   - All writes on user data: action ending with '_write'
 * The DB CHECK constraints enforce this, but we check here for a clear error.
 *
 * @throws Error if justification is required but missing.
 */
export async function adminAudit(evt: AdminAuditEvent): Promise<AdminAuditResult> {
  // Validate justification requirement (defense-in-depth — the DB CHECK also enforces).
  if (requiresJustification(evt.action) && !evt.justification) {
    throw new Error(
      `admin_audit: justification required for action '${evt.action}' ` +
        `(sensitive read or user-data write)`,
    );
  }

  // Build the diff object { old, new } if either is present.
  const diff = evt.old !== undefined || evt.new !== undefined
    ? { ...(evt.old !== undefined ? { old: evt.old } : {}), ...(evt.new !== undefined ? { new: evt.new } : {}) }
    : null;

  // Call the security-definer function.
  const result = await db.execute(sql`
    select admin_audit_log_append(
      ${evt.actor},
      ${evt.action},
      ${evt.target ?? null}::jsonb,
      ${evt.justification ?? null},
      ${diff}::jsonb,
      ${evt.ip ?? null}::inet,
      ${evt.userAgent ?? null}
    ) as id
  `);
  const id = (result as unknown as Array<{ id: string }>)[0]?.id;
  if (!id) throw new Error("admin_audit: append failed (no id returned)");

  // Fetch the seq (the function returns only the id; seq is a separate query).
  const seqResult = await db.execute(sql`
    select seq from admin_audit_log where id = ${id}::uuid
  `);
  const seq = Number((seqResult as unknown as Array<{ seq: number }>)[0]?.seq ?? 0);

  return { id, seq };
}

/**
 * Determine if an action requires a justification (sensitive read or user-data write).
 * Mirrors the DB CHECK constraints.
 */
export function requiresJustification(action: string): boolean {
  // Sensitive reads: admin.user_data.* (reading user PII/data).
  if (action.startsWith("admin.user_data.")) return true;
  // All writes on user data: action ends with _write (convention).
  if (action.endsWith("_write")) return true;
  return false;
}

// ───────────────────────────────────────────────
// verifyAdminAuditChain — nightly verification
// ───────────────────────────────────────────────

/**
 * Verify the admin audit log hash chain. Recomputes every hash + compares.
 *
 * Returns { ok: true } if the chain is intact. Returns { ok: false, brokenAtSeq }
 * if a tamper is detected — brokenAtSeq is the first seq where the recomputed
 * hash doesn't match the stored hash (the tamper point).
 *
 * Called nightly by the verify-admin-audit-chain cron. On mismatch, the cron
 * emits a critical alert (the chain is the forensic guarantee — a break means
 * someone with DB access tampered with the log).
 *
 * Delegates to the security-definer function `admin_audit_log_verify_chain`.
 */
export async function verifyAdminAuditChain(): Promise<AdminAuditChainVerification> {
  const result = await db.execute(sql`
    select * from admin_audit_log_verify_chain()
  `);
  const row = (result as unknown as Array<{ ok: boolean; broken_at_seq: number | null }>)[0];
  if (!row) {
    // Empty log — the chain is trivially intact.
    return { ok: true, brokenAtSeq: null };
  }
  return {
    ok: row.ok,
    brokenAtSeq: row.broken_at_seq != null ? Number(row.broken_at_seq) : null,
  };
}

// ───────────────────────────────────────────────
// queryAdminAudit — for the admin audit log UI (owners only)
// ───────────────────────────────────────────────

export interface AdminAuditQuery {
  actorId?: string;
  action?: string;
  fromTs?: Date;
  toTs?: Date;
  limit?: number;
  offset?: number;
}

export interface AdminAuditEntry {
  seq: number;
  id: string;
  actorId: string;
  action: string;
  target: Record<string, unknown> | null;
  justification: string | null;
  diff: { old?: unknown; new?: unknown } | null;
  ip: string | null;
  userAgent: string | null;
  ts: Date;
}

/**
 * Query the admin audit log. Returns entries in descending seq order (newest first).
 *
 * RLS enforces owner-only read access (the function doesn't need to check —
 * the caller is an admin session, and RLS filters to owners). The caller
 * (the route) must verify the admin is an owner before calling.
 */
export async function queryAdminAudit(query: AdminAuditQuery = {}): Promise<AdminAuditEntry[]> {
  const limit = Math.min(query.limit ?? 100, 1000); // cap at 1000.
  const offset = Math.max(query.offset ?? 0, 0);

  // Build the WHERE clause dynamically.
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (query.actorId) {
    conditions.push(`actor_id = $${paramIdx++}`);
    params.push(query.actorId);
  }
  if (query.action) {
    conditions.push(`action = $${paramIdx++}`);
    params.push(query.action);
  }
  if (query.fromTs) {
    conditions.push(`ts >= $${paramIdx++}`);
    params.push(query.fromTs);
  }
  if (query.toTs) {
    conditions.push(`ts <= $${paramIdx++}`);
    params.push(query.toTs);
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const limitParam = `$${paramIdx++}`;
  const offsetParam = `$${paramIdx++}`;
  params.push(limit, offset);

  const result = await db.execute(sql.raw(
    `select seq, id, actor_id, action, target, justification, diff, ip::text, user_agent, ts
       from admin_audit_log
       ${whereClause}
       order by seq desc
       limit ${limitParam} offset ${offsetParam}`,
  ));

  return (result as unknown as Array<Record<string, unknown>>).map((r) => ({
    seq: Number(r.seq),
    id: r.id as string,
    actorId: r.actor_id as string,
    action: r.action as string,
    target: (r.target as Record<string, unknown>) ?? null,
    justification: (r.justification as string) ?? null,
    diff: (r.diff as { old?: unknown; new?: unknown }) ?? null,
    ip: (r.ip as string) ?? null,
    userAgent: (r.user_agent as string) ?? null,
    ts: r.ts as Date,
  }));
}
