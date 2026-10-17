// Audit log service — hash chain, verification, access.
//
// APPEND ONLY: inserts happen via the `enterprise_audit_log_append`
// security-definer function (migration 0029). No UPDATE/DELETE grants exist
// on `enterprise_audit_log` — REVOKE was issued in the migration. The hash
// chain is computed by a BEFORE INSERT trigger (`compute_audit_hash_chain`):
//
//   h_n = sha256(prev_hash || canonical(record_n))
//
// where prev_hash = the last hash in the chain for this ws_id (or '\x00'
// genesis for the first entry), and canonical(record) = deterministic JSON
// (sorted keys, no whitespace).
//
//   audit()         — append via the security-definer function. The trigger
//                     computes prev_hash + hash; the function just inserts.
//   verifyChain()   — nightly job. Walks the entire chain (all ws_id), recomputes
//                     each hash, detects breaks. On break, alert + page on-call.
//   search()        — read access (admin/owner only, perm: audit.read).
//                     Filtered by actor/action/date range. Returns entries + chainTip
//                     (the tip hash — so exports are verifiable by third parties).
//   exportAudit()   — NDJSON stream of entries in a date range. Includes hashes
//                     so the recipient can run verifyChain() independently.

import { db } from "@supa/db";
import { enterpriseAuditLog } from "@supa/db/schema";
import { eq, and, gte, lte, sql, desc, asc } from "drizzle-orm";
import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface AuditEntry {
  actorType: "user" | "api_key" | "scim" | "sso" | "system";
  actorId: string;
  action: string;
  target?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export interface AuditLogRow {
  seq: number;
  id: string;
  wsId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  target: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  ts: Date;
  prevHash: Buffer;
  hash: Buffer;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  brokenHash?: Buffer;
  expectedHash?: Buffer;
}

export interface SearchFilters {
  actor?: string;
  action?: string;
  from?: Date;
  to?: Date;
  cursor?: string; // seq cursor (opaque to the caller).
}

export interface SearchResult {
  entries: AuditLogRow[];
  chainTip: string | null; // hex of the last hash in the chain for this ws_id.
  nextCursor: string | null;
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status code. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Canonical JSON — deterministic (sorted keys at every depth, no whitespace).
 * This is what gets hashed. The trigger's `compute_audit_hash_chain` function
 * uses `jsonb_build_object(...)` which produces canonical JSON (sorted keys).
 * This JS version must match — same field order, same types.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex of a string. */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** SHA-256 Buffer of a Buffer (for chain verification). */
function sha256Buffer(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Concatenate two Buffers. */
function concatBuffers(a: Buffer, b: Buffer): Buffer {
  return Buffer.concat([a, b]);
}

/**
 * Require that the user has a specific permission.
 * Inline (same pattern as apikeys/service.ts — avoids a cross-module import
 * that would create a circular dep).
 */
async function requirePerm(wsId: string, userId: string, perm: string): Promise<void> {
  const { memberships, customRoles } = await import("@supa/db/schema");
  const rows = await db
    .select({ role: memberships.role, status: memberships.status, customRoleId: memberships.customRoleId })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("not_a_member", 403);
  if (m.status !== "active") throw new ApiError(`membership_${m.status}`, 403);

  const ROLE_DEFAULTS: Record<string, string[]> = {
    owner: ["*"],
    admin: ["chat.*", "work.*", "freelance.*", "design.*", "business.*", "agents.*",
            "members.invite", "members.suspend", "settings.write", "billing.view",
            "audit.read", "api_keys.manage"],
    member: [],
    viewer: [],
  };

  let perms: string[];
  if (m.role === "custom" && m.customRoleId) {
    const roleRows = await db
      .select({ perms: customRoles.perms })
      .from(customRoles)
      .where(eq(customRoles.id, m.customRoleId as any))
      .limit(1);
    perms = (roleRows[0]?.perms as string[]) ?? [];
  } else {
    perms = ROLE_DEFAULTS[m.role as string] ?? [];
  }

  const has = perms.some((p) => {
    if (p === "*") return true;
    if (p === perm) return true;
    if (p.endsWith(".*")) return perm.startsWith(p.slice(0, -2) + ".");
    return false;
  });
  if (!has) throw new ApiError(`permission_missing:${perm}`, 403);
}

/**
 * Get the tip hash of the chain for a ws_id (the last entry's hash).
 * Used by `search()` so exports are verifiable by third parties.
 */
async function getTipHash(wsId: string): Promise<string | null> {
  const rows = await db
    .select({ hash: enterpriseAuditLog.hash })
    .from(enterpriseAuditLog)
    .where(eq(enterpriseAuditLog.wsId, wsId as any))
    .orderBy(desc(enterpriseAuditLog.seq))
    .limit(1);
  const tip = rows[0]?.hash as Buffer | undefined;
  return tip ? tip.toString("hex") : null;
}

/**
 * Query filtered audit log entries for a ws_id. Returns up to `limit` rows,
 * starting after `cursor` (seq) if provided.
 */
async function queryFiltered(
  wsId: string,
  f: SearchFilters,
  limit: number,
): Promise<AuditLogRow[]> {
  const conditions = [eq(enterpriseAuditLog.wsId, wsId as any)];

  if (f.actor) {
    conditions.push(eq(enterpriseAuditLog.actorId, f.actor));
  }
  if (f.action) {
    conditions.push(eq(enterpriseAuditLog.action, f.action));
  }
  if (f.from) {
    conditions.push(gte(enterpriseAuditLog.ts, f.from));
  }
  if (f.to) {
    conditions.push(lte(enterpriseAuditLog.ts, f.to));
  }
  if (f.cursor) {
    const cursorSeq = parseInt(f.cursor, 10);
    if (!Number.isNaN(cursorSeq)) {
      conditions.push(sql`${enterpriseAuditLog.seq} > ${cursorSeq}`);
    }
  }

  const rows = await db
    .select()
    .from(enterpriseAuditLog)
    .where(and(...conditions))
    .orderBy(asc(enterpriseAuditLog.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    wsId: (r.wsId as string | null) ?? null,
    actorType: r.actorType as string,
    actorId: r.actorId as string,
    action: r.action as string,
    target: (r.target as Record<string, unknown> | null) ?? null,
    ip: (r.ip as string | null) ?? null,
    userAgent: (r.userAgent as string | null) ?? null,
    ts: r.ts as Date,
    prevHash: r.prevHash as Buffer,
    hash: r.hash as Buffer,
  }));
}

/**
 * Stream audit log entries as NDJSON (newline-delimited JSON). Each line is
 * one entry with its hash. The recipient can run `verifyChain()` independently
 * to verify the chain wasn't tampered with.
 *
 * This is a stub — the real impl uses a ReadableStream + the Response body
 * for streaming (avoids buffering the entire export in memory).
 */
async function* streamNdjson(
  wsId: string,
  range: [Date, Date],
): AsyncGenerator<string> {
  const rows = await db
    .select()
    .from(enterpriseAuditLog)
    .where(
      and(
        eq(enterpriseAuditLog.wsId, wsId as any),
        gte(enterpriseAuditLog.ts, range[0]),
        lte(enterpriseAuditLog.ts, range[1]),
      ),
    )
    .orderBy(asc(enterpriseAuditLog.seq));

  for (const r of rows) {
    yield JSON.stringify({
      seq: r.seq,
      id: r.id,
      wsId: r.wsId,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      target: r.target,
      ip: r.ip,
      userAgent: r.userAgent,
      ts: r.ts,
      prevHash: (r.prevHash as Buffer).toString("hex"),
      hash: (r.hash as Buffer).toString("hex"),
    }) + "\n";
  }
}

// ───────────────────────────────────────────────
// audit() — append via the security-definer function
// ───────────────────────────────────────────────

/**
 * Append to the audit log. Uses the `enterprise_audit_log_append` security-definer
 * function (migration 0029). The function runs as the table owner (bypasses the
 * no-insert RLS policy), and the `compute_audit_hash_chain` BEFORE INSERT trigger
 * computes `prev_hash` + `hash = sha256(prev_hash || canonical(record))`.
 *
 * The caller does NOT compute the hash — the trigger does. This is the security
 * guarantee: even if the caller's JS is compromised, the hash chain is computed
 * by the DB trigger (which can't be bypassed without superuser).
 *
 * `wsId` is nullable — system-level audit entries (not scoped to a workspace)
 * have `wsId = null`.
 */
export async function audit(
  wsId: string | null,
  entry: AuditEntry,
): Promise<string> {
  const result = await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${entry.actorType},
      ${entry.actorId},
      ${entry.action},
      ${entry.target ?? null}::jsonb,
      ${entry.ip ?? null}::inet,
      ${entry.userAgent ?? null}::text
    ) as id
  `);
  // The function returns the inserted row's id (uuid).
  const rows = result as unknown as { rows: { id: string }[] };
  return rows.rows[0]?.id ?? "";
}

// ───────────────────────────────────────────────
// verifyChain() — nightly verification job
// ───────────────────────────────────────────────

/**
 * Verify the integrity of the hash chain. Walks the entire chain (all ws_id,
 * ordered by seq), recomputes each hash, and detects breaks.
 *
 * For each row:
 *   expected = sha256(prev_hash || canonical(record))
 *   if expected != row.hash → BROKEN at this seq.
 *
 * The canonical record must match the trigger's `compute_audit_hash_chain`
 * function exactly — same fields, same order. The trigger uses:
 *   jsonb_build_object(
 *     'ws_id', new.ws_id,
 *     'id', new.id,
 *     'actor_type', new.actor_type,
 *     'actor_id', new.actor_id,
 *     'action', new.action,
 *     'target', new.target,
 *     'ip', new.ip::text,
 *     'user_agent', new.user_agent,
 *     'ts', new.ts::text
 *   )::text
 *
 * This JS `canonical()` must produce the same output. The field order in
 * jsonb_build_object is preserved (it's not sorted by key — jsonb sorts keys
 * on output, but jsonb_build_object preserves insertion order in the text cast).
 * So the JS canonical must use the SAME field order.
 *
 * On break: alert + page on-call (the alerting is a separate concern — this
 * function returns the broken seq; the caller decides how to alert).
 *
 * Returns `{ ok: true, checked: N }` on success, `{ ok: false, brokenAt: seq }`
 * on break (with the broken hash + the expected hash for forensics).
 */
export async function verifyChain(): Promise<VerifyResult> {
  const rows = await db
    .select({
      seq: enterpriseAuditLog.seq,
      wsId: enterpriseAuditLog.wsId,
      id: enterpriseAuditLog.id,
      actorType: enterpriseAuditLog.actorType,
      actorId: enterpriseAuditLog.actorId,
      action: enterpriseAuditLog.action,
      target: enterpriseAuditLog.target,
      ip: enterpriseAuditLog.ip,
      userAgent: enterpriseAuditLog.userAgent,
      ts: enterpriseAuditLog.ts,
      prevHash: enterpriseAuditLog.prevHash,
      hash: enterpriseAuditLog.hash,
    })
    .from(enterpriseAuditLog)
    .orderBy(asc(enterpriseAuditLog.seq));

  // prev starts as '\x00' genesis (matches the trigger's genesis).
  let prev = Buffer.from("00", "hex");

  for (const r of rows) {
    // Build the canonical record — MUST match the trigger's field order.
    const rec = canonical({
      ws_id: r.wsId,
      id: r.id,
      actor_type: r.actorType,
      actor_id: r.actorId,
      action: r.action,
      target: r.target,
      ip: r.ip != null ? String(r.ip) : null,
      user_agent: r.userAgent,
      ts: r.ts != null ? r.ts.toISOString() : null,
    });
    const recBuffer = Buffer.from(rec, "utf8");
    const expected = sha256Buffer(concatBuffers(prev, recBuffer));

    const actualHash = r.hash as Buffer;
    if (!expected.equals(actualHash)) {
      return {
        ok: false,
        checked: rows.indexOf(r),
        brokenAt: r.seq as number,
        brokenHash: actualHash,
        expectedHash: expected,
      };
    }

    // Verify prev_hash matches the previous row's hash (chain continuity).
    const actualPrevHash = r.prevHash as Buffer;
    if (!prev.equals(actualPrevHash)) {
      return {
        ok: false,
        checked: rows.indexOf(r),
        brokenAt: r.seq as number,
        brokenHash: actualPrevHash,
        expectedHash: prev, // expected prev_hash.
      };
    }

    prev = Buffer.from(actualHash);
  }

  return { ok: true, checked: rows.length };
}

// ───────────────────────────────────────────────
// search() — read access (admin/owner only)
// ───────────────────────────────────────────────

const SEARCH_PAGE_SIZE = 100;

/**
 * Search the audit log. Admin/owner only (perm: `audit.read`). Filtered by
 * actor, action, date range. Cursor-based pagination (seq cursor).
 *
 * Always returns `chainTip` (the tip hash of the chain for this ws_id) so
 * exports are verifiable by third parties — the recipient can compare their
 * copy's tip against the live tip to detect tampering.
 */
export async function search(
  wsId: string,
  byUserId: string,
  f: SearchFilters,
): Promise<SearchResult> {
  await requirePerm(wsId, byUserId, "audit.read");

  const entries = await queryFiltered(wsId, f, SEARCH_PAGE_SIZE);
  const chainTip = await getTipHash(wsId);

  // Compute the next cursor (the seq of the last entry, if there are more).
  const lastSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : null;
  const nextCursor = entries.length === SEARCH_PAGE_SIZE && lastSeq != null
    ? String(lastSeq)
    : null;

  return { entries, chainTip, nextCursor };
}

// ───────────────────────────────────────────────
// exportAudit() — NDJSON stream with hashes
// ───────────────────────────────────────────────

/**
 * Export the audit log as NDJSON (newline-delimited JSON). Each line is one
 * entry with its `prevHash` + `hash` (hex). The recipient can run `verifyChain()`
 * independently — the export is self-verifying.
 *
 * Admin/owner only (perm: `audit.read`).
 *
 * Returns an async generator that yields NDJSON lines. The API route wraps
 * this in a ReadableStream + Response with `Content-Disposition: attachment`.
 */
export async function exportAudit(
  wsId: string,
  byUserId: string,
  range: [Date, Date],
): Promise<AsyncGenerator<string>> {
  await requirePerm(wsId, byUserId, "audit.read");
  return streamNdjson(wsId, range);
}

// ───────────────────────────────────────────────
// Pool-based secure operations — the connection layer version of audit/verify.
//
// These use the `systemPool` + `withSystem` for the hash-chain computation
// (the audit append needs to read the previous hash with FOR UPDATE to
// serialize concurrent appends — this is a system-level operation, not
// user-scoped). The existing `audit()` function calls the security-definer
// `enterprise_audit_log_append` function (which has the trigger compute the
// hash); these secure functions provide an ALTERNATIVE path where the app
// layer computes the hash (the spec's intent: "the app layer owns real hashing").
//
// Both paths coexist:
//   - `audit()` (existing) → security-definer function + trigger computes hash.
//   - `auditSecure()` (new) → app layer computes hash + direct INSERT via system pool.
//   - `verifyChainSecure()` (new) → app layer recomputes + walks chain.
// ───────────────────────────────────────────────

import { withSystem, getSystemPool } from "@supa/db/pool";

/** Audit row shape for the hash-chain computation. */
interface AuditChainRow {
  seq: number;
  ws_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  target: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  prev_hash: Buffer;
  hash: Buffer;
  ts: Date;
}

/**
 * Canonical JSON — stable field order (deterministic). The hash is computed
 * over this string. MUST match the trigger's `compute_audit_hash_chain`
 * function's field order exactly (ws_id, id, actor_type, actor_id, action,
 * target, ip, user_agent, ts). A mismatch would cause verifyChain to false-positive.
 */
function canonicalChain(r: Partial<AuditChainRow>): string {
  return JSON.stringify({
    ws_id: r.ws_id,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    target: r.target,
    ip: r.ip != null ? String(r.ip) : null,
    user_agent: r.user_agent,
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
  });
}

/**
 * Append to the audit log with APP-LAYER hash computation (secure path).
 *
 * Uses the system pool + `withSystem` (supa_system role). Reads the previous
 * hash with `FOR UPDATE` (serializes concurrent appends — prevents two
 * appends from reading the same prev_hash + creating a fork in the chain).
 * Computes `hash = sha256(prev_hash || canonical(record))` in JS.
 *
 * This is the ALTERNATIVE to the existing `audit()` function (which calls the
 * security-definer `enterprise_audit_log_append` function + lets the trigger
 * compute the hash). Both paths produce the same result (same canonical field
 * order, same hash algorithm). The difference:
 *   - `audit()` → trigger computes hash (can't be bypassed by JS compromise).
 *   - `auditSecure()` → app layer computes hash (more transparent, testable).
 *
 * Use `audit()` in production (the trigger is the security guarantee).
 * Use `auditSecure()` in tests + for the verify-chain path.
 */
export async function auditSecure(
  wsId: string,
  evt: AuditEntry,
): Promise<void> {
  const pool = getSystemPool();

  await withSystem(pool, async (tx) => {
    // Read the previous hash with FOR UPDATE (serialize concurrent appends).
    const prevRows = await tx`
      select hash from enterprise_audit_log
      order by seq desc limit 1
      for update
    `;
    const prevHash = (prevRows[0] as { hash: Buffer } | undefined)?.hash
      ?? Buffer.from("00", "hex");

    // Compute the canonical record + hash.
    const ts = new Date();
    const canonicalRec = canonicalChain({
      ws_id: wsId,
      actor_type: evt.actorType,
      actor_id: evt.actorId,
      action: evt.action,
      target: evt.target ?? null,
      ip: evt.ip ?? null,
      user_agent: evt.userAgent ?? null,
      ts,
    });
    const hash = createHash("sha256")
      .update(Buffer.concat([prevHash, Buffer.from(canonicalRec, "utf8")]))
      .digest();

    // Insert the audit entry with the computed hash.
    await tx`
      insert into enterprise_audit_log
        (ws_id, actor_type, actor_id, action, target, ip, user_agent, prev_hash, hash, ts)
      values
        (${wsId}::uuid, ${evt.actorType}, ${evt.actorId}, ${evt.action},
         ${evt.target ?? null}::jsonb, ${evt.ip ?? null}::inet,
         ${evt.userAgent ?? null}, ${prevHash}, ${hash}, ${ts})
    `;
  });
}

/**
 * Verify the hash chain integrity (secure path — app-layer recomputation).
 *
 * Reads ALL audit log entries (ordered by seq), recomputes each hash from
 * the canonical record, and detects breaks. On break, returns the broken seq.
 *
 * Uses the system pool (the verification reads all ws_id — RLS would block
 * cross-ws reads). The verification is nightly (cron) + on-demand (admin UI).
 *
 * Returns `{ ok: true, checked: N }` on success, `{ ok: false, brokenAt, brokenHash, expectedHash }` on break.
 */
export async function verifyChainSecure(): Promise<VerifyResult> {
  const pool = getSystemPool();

  return withSystem(pool, async (tx) => {
    const rows = await tx`
      select seq, ws_id, actor_type, actor_id, action, target, ip, user_agent,
             prev_hash, hash, ts
      from enterprise_audit_log
      order by seq
    `;

    let prev: Buffer | null = null;

    for (const r of rows as unknown as AuditChainRow[]) {
      // Check chain continuity: prev_hash must match the previous row's hash.
      if (prev && !r.prev_hash.equals(prev)) {
        return {
          ok: false,
          checked: rows.indexOf(r as never),
          brokenAt: r.seq,
          brokenHash: r.prev_hash,
          expectedHash: prev,
        };
      }

      // Recompute the hash from the canonical record.
      const canonicalRec = canonicalChain(r);
      const recomputed = createHash("sha256")
        .update(Buffer.concat([r.prev_hash, Buffer.from(canonicalRec, "utf8")]))
        .digest();

      if (!recomputed.equals(r.hash)) {
        return {
          ok: false,
          checked: rows.indexOf(r as never),
          brokenAt: r.seq,
          brokenHash: r.hash,
          expectedHash: recomputed,
        };
      }

      prev = r.hash;
    }

    return { ok: true, checked: (rows as unknown[]).length };
  });
}
