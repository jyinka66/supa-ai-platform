// Feature flags — global control plane.
//
//isEnabled(key, ctx) — the hot-path lookup. First-match semantics:
//   1. kill_switch + enabled=false → OFF (immediate, bypasses everything).
//   2. targets.users    — explicit user allowlist (highest precedence).
//   3. targets.workspaces — explicit workspace allowlist.
//   4. targets.plans    — plan-based (e.g. 'pro' gets the feature).
//   5. rollout_pct      — percentage of users (stable hash bucket).
//   6. enabled          — global on/off (lowest precedence).
//
// The first matching rule wins. If no rule matches, the flag is off.
//
// Caching: the flag table is small + read-heavy. The app layer caches it
// in-memory (TTL 60s) — the `getFlag` function checks the cache first,
// falls back to the DB. A `kill_switch` change is picked up within 60s
// (acceptable for an emergency off-switch; for instant kill, the app can
// call `refreshFlags()` or the admin can POST /api/admin/feature-flags/refresh).
//
// The rollout_pct bucketing uses a stable hash of (key, userId) — the same
// user always lands in the same bucket for a given flag (no flicker across
// requests). Users without a userId (anonymous) use a hash of their IP.

import { db } from "@supa/db";
import { featureFlags } from "@supa/db/schema";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type FlagKind = "feature" | "kill_switch";

export interface FlagTargets {
  /** Plan-based targeting (e.g. ['pro', 'business']). */
  plans?: string[];
  /** Explicit workspace allowlist (UUIDs). */
  workspaces?: string[];
  /** Explicit user allowlist (UUIDs). */
  users?: string[];
}

export interface FeatureFlag {
  key: string;
  kind: FlagKind;
  enabled: boolean;
  rolloutPct: number;
  targets: FlagTargets;
  description: string;
  owner: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationContext {
  /** The user's ID (if authenticated). */
  userId?: string;
  /** The workspace ID (if in a workspace context). */
  workspaceId?: string;
  /** The workspace's plan (e.g. 'free', 'pro', 'business', 'enterprise'). */
  plan?: string;
  /** The request IP (for anonymous rollout bucketing). */
  ip?: string;
}

export class FlagError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "FlagError";
  }
}

// ───────────────────────────────────────────────
// In-memory cache (60s TTL)
// ───────────────────────────────────────────────

interface CacheEntry {
  flag: FeatureFlag | null; // null = flag doesn't exist (negative cache).
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Refresh the cache for a specific key (or all keys if no key). */
export function refreshFlags(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/** Invalidate the cache for a key (alias for refreshFlags — used after a write). */
export function invalidateFlag(key: string): void {
  cache.delete(key);
}

async function getCachedFlag(key: string): Promise<FeatureFlag | null> {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.flag;
  }
  // Cache miss — fetch from DB.
  const flag = await fetchFlagFromDb(key);
  cache.set(key, { flag, fetchedAt: Date.now() });
  return flag;
}

async function fetchFlagFromDb(key: string): Promise<FeatureFlag | null> {
  const rows = await db
    .select({
      key: featureFlags.key,
      kind: featureFlags.kind,
      enabled: featureFlags.enabled,
      rolloutPct: featureFlags.rolloutPct,
      targets: featureFlags.targets,
      description: featureFlags.description,
      owner: featureFlags.owner,
      createdAt: featureFlags.createdAt,
      updatedAt: featureFlags.updatedAt,
    })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key as string,
    kind: row.kind as FlagKind,
    enabled: row.enabled,
    rolloutPct: row.rolloutPct,
    targets: (row.targets as FlagTargets) ?? {},
    description: row.description,
    owner: row.owner,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ───────────────────────────────────────────────
// isEnabled — the hot-path lookup
// ───────────────────────────────────────────────

/**
 * Check if a feature flag is enabled for the given context.
 *
 * First-match semantics (evaluated in this order):
 *   1. kill_switch → global on/off (ignores targets + rollout).
 *   2. targets.users    — explicit user allowlist (highest precedence).
 *   3. targets.workspaces — explicit workspace allowlist.
 *   4. targets.plans    — plan-based.
 *   5. rollout_pct      — stable hash bucket (percentage of users).
 *   6. enabled          — global on/off (lowest precedence).
 *
 * If the flag doesn't exist, returns false (fail-closed — unknown flags
 * are off). This is the safe default: a typo in a flag key doesn't
 * accidentally enable a feature.
 *
 * @param key — the flag key (e.g. 'new_dashboard').
 * @param ctx — the evaluation context (userId, workspaceId, plan, ip).
 */
export async function isEnabled(key: string, ctx: EvaluationContext = {}): Promise<boolean> {
  const flag = await getCachedFlag(key);
  if (!flag) return false; // fail-closed — unknown flag = off.

  return evaluateFlag(flag, ctx);
}

/**
 * Pure evaluation function (no DB / no cache). Exported for unit testing.
 *
 * This is the first-match logic, extracted from isEnabled so it can be
 * tested without a DB.
 */
export function evaluateFlag(flag: FeatureFlag, ctx: EvaluationContext): boolean {
  // 1. kill_switch → global on/off (ignores targets + rollout).
  //    A kill switch that's enabled=true means the feature is ON (the switch
  //    was "pulled" to enable). enabled=false means OFF (emergency disable).
  //    Kill switches ignore targets + rollout — they're global.
  if (flag.kind === "kill_switch") {
    return flag.enabled;
  }

  // For 'feature' kind: first-match semantics.

  // 2. targets.users — explicit user allowlist.
  if (ctx.userId && flag.targets.users?.length) {
    return flag.targets.users.includes(ctx.userId);
  }

  // 3. targets.workspaces — explicit workspace allowlist.
  if (ctx.workspaceId && flag.targets.workspaces?.length) {
    return flag.targets.workspaces.includes(ctx.workspaceId);
  }

  // 4. targets.plans — plan-based.
  if (ctx.plan && flag.targets.plans?.length) {
    return flag.targets.plans.includes(ctx.plan);
  }

  // 5. rollout_pct — stable hash bucket.
  if (flag.rolloutPct > 0) {
    const bucketKey = ctx.userId ?? ctx.ip ?? "anonymous";
    const bucket = hashBucket(flag.key, bucketKey);
    return bucket < flag.rolloutPct;
  }

  // 6. enabled — global on/off.
  return flag.enabled;
}

/**
 * Stable hash bucket for rollout_pct.
 *
 * hash(key + subject) → 0-99. The same (key, subject) always produces the
 * same bucket — no flicker across requests. A user is in the rollout if
 * their bucket < rollout_pct.
 *
 * Uses SHA-256 (first 4 bytes → uint32 → mod 100). Cryptographic hash
 * ensures even distribution (no clustering for similar keys/subjects).
 */
export function hashBucket(flagKey: string, subject: string): number {
  const hash = createHash("sha256").update(`${flagKey}:${subject}`).digest();
  // First 4 bytes → uint32 (big-endian) → mod 100.
  const uint32 = hash.readUInt32BE(0);
  return uint32 % 100;
}

// ───────────────────────────────────────────────
// CRUD — admin-only (the API layer enforces owner-only)
// ───────────────────────────────────────────────

export interface CreateFlagInput {
  key: string;
  kind?: FlagKind;
  enabled?: boolean;
  rolloutPct?: number;
  targets?: FlagTargets;
  description: string;
  owner: string;
}

export interface UpdateFlagInput {
  kind?: FlagKind;
  enabled?: boolean;
  rolloutPct?: number;
  targets?: FlagTargets;
  description?: string;
  owner?: string;
}

/** Validate a flag key (lowercase, alphanumeric + underscore, 1-64 chars). */
export function validateFlagKey(key: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
    throw new FlagError(
      `invalid_flag_key:${key} (must be lowercase, alphanumeric + underscore, start with a letter, max 64 chars)`,
      400,
    );
  }
}

export async function createFlag(input: CreateFlagInput): Promise<FeatureFlag> {
  validateFlagKey(input.key);
  if (input.rolloutPct !== undefined && (input.rolloutPct < 0 || input.rolloutPct > 100)) {
    throw new FlagError("rollout_pct_must_be_0_100", 400);
  }

  try {
    await db
      .insert(featureFlags)
      .values({
        key: input.key,
        kind: input.kind ?? "feature",
        enabled: input.enabled ?? false,
        rolloutPct: input.rolloutPct ?? 0,
        targets: (input.targets ?? {}) as any,
        description: input.description,
        owner: input.owner,
      });
  } catch (err) {
    // Unique violation → already exists.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      throw new FlagError("flag_already_exists", 409);
    }
    throw err;
  }

  invalidateFlag(input.key);
  const flag = await fetchFlagFromDb(input.key);
  return flag!;
}

export async function updateFlag(key: string, input: UpdateFlagInput): Promise<FeatureFlag> {
  if (input.rolloutPct !== undefined && (input.rolloutPct < 0 || input.rolloutPct > 100)) {
    throw new FlagError("rollout_pct_must_be_0_100", 400);
  }

  // Build the update object — only set fields that are provided.
  const updates: Record<string, unknown> = {};
  if (input.kind !== undefined) updates.kind = input.kind;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.rolloutPct !== undefined) updates.rolloutPct = input.rolloutPct;
  if (input.targets !== undefined) updates.targets = input.targets;
  if (input.description !== undefined) updates.description = input.description;
  if (input.owner !== undefined) updates.owner = input.owner;

  if (Object.keys(updates).length === 0) {
    throw new FlagError("empty_patch", 400);
  }

  const rows = await db
    .update(featureFlags)
    .set(updates)
    .where(eq(featureFlags.key, key))
    .returning({ key: featureFlags.key });
  if (rows.length === 0) {
    throw new FlagError("flag_not_found", 404);
  }

  invalidateFlag(key);
  const flag = await fetchFlagFromDb(key);
  return flag!;
}

export async function deleteFlag(key: string): Promise<void> {
  const rows = await db
    .delete(featureFlags)
    .where(eq(featureFlags.key, key))
    .returning({ key: featureFlags.key });
  if (rows.length === 0) {
    throw new FlagError("flag_not_found", 404);
  }
  invalidateFlag(key);
}

export async function getFlag(key: string): Promise<FeatureFlag | null> {
  return fetchFlagFromDb(key);
}

export async function listFlags(): Promise<FeatureFlag[]> {
  const rows = await db
    .select({
      key: featureFlags.key,
      kind: featureFlags.kind,
      enabled: featureFlags.enabled,
      rolloutPct: featureFlags.rolloutPct,
      targets: featureFlags.targets,
      description: featureFlags.description,
      owner: featureFlags.owner,
      createdAt: featureFlags.createdAt,
      updatedAt: featureFlags.updatedAt,
    })
    .from(featureFlags)
    .orderBy(featureFlags.key);
  return rows.map((r) => ({
    key: r.key as string,
    kind: r.kind as FlagKind,
    enabled: r.enabled,
    rolloutPct: r.rolloutPct,
    targets: (r.targets as FlagTargets) ?? {},
    description: r.description,
    owner: r.owner,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** List all active kill switches (enabled=false). Used by the health endpoint. */
export async function listActiveKillSwitches(): Promise<FeatureFlag[]> {
  const rows = await db
    .select({
      key: featureFlags.key,
      kind: featureFlags.kind,
      enabled: featureFlags.enabled,
      rolloutPct: featureFlags.rolloutPct,
      targets: featureFlags.targets,
      description: featureFlags.description,
      owner: featureFlags.owner,
      createdAt: featureFlags.createdAt,
      updatedAt: featureFlags.updatedAt,
    })
    .from(featureFlags)
    .where(
      sql`${featureFlags.kind} = 'kill_switch' and ${featureFlags.enabled} = false`,
    )
    .orderBy(featureFlags.key);
  return rows.map((r) => ({
    key: r.key as string,
    kind: r.kind as FlagKind,
    enabled: r.enabled,
    rolloutPct: r.rolloutPct,
    targets: (r.targets as FlagTargets) ?? {},
    description: r.description,
    owner: r.owner,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// ───────────────────────────────────────────────
// setFlag — confirmation-gated update with diff audit (spec: apps/admin/src/flags.ts)
//
// The spec:
//   export async function setFlag(actor, key, patch, justification) {
//     const before = await sys.one(`select * from feature_flags where key=$1`, [key]);
//     await requireConfirmation(actor, { danger: before.kind === 'kill_switch', ... });
//     await sys.update("feature_flags", key, patch);
//     await adminAudit({ actor, action: `flag.${before.kind}.set`, target: {key}, old: before, new: patch, justification });
//   }
//
// FIXES from the spec:
// 1. `sys.update("feature_flags", key, patch)` — the spec uses a system-role
//    update. Our `updateFlag` already uses the system role (supa_system has
//    CRUD grants). No change needed — we delegate to updateFlag.
// 2. The audit uses `adminAudit` (our lib/admin/audit.ts adminAudit function)
//    with old/new diff + justification. The spec's `old: before, new: patch`
//    is the diff — we store it as { old: before, new: patch } in the audit log.
// 3. `requireConfirmation` — the spec references it but doesn't define it.
//    Created in lib/admin/confirmation.ts: typed phrase + 2nd admin for
//    kill_switches.
// 4. One-click rollback = the change log entry's "revert" button. This is
//    the same endpoint with the old values. Rollback is itself logged (a
//    new audit entry with old=new, new=old). No separate rollback endpoint
//    needed — the UI calls setFlag with the inverted patch. But we provide
//    a convenience route POST /rollback/[auditSeq] that reads the audit log,
//    extracts the old values, + calls setFlag with them (logged as a rollback).
// ───────────────────────────────────────────────

import { adminAudit, type AdminAuditEvent } from "@/lib/admin/audit";
import {
  requireConfirmation,
  consumeConfirmation,
  ConfirmationRequiredError,
  type ConfirmationContext,
} from "@/lib/admin/confirmation";
import type { AdminSession } from "@/lib/admin/invite";

export interface SetFlagOptions {
  /** The typed phrase (required for kill_switches — e.g. "enable kill_search_v3"). */
  typedPhrase?: string;
  /** The confirmation ID from a prior 202 response (kill_switch 2nd-admin approval). */
  confirmationId?: string;
}

export interface SetFlagResult {
  flag: FeatureFlag;
  /** The audit log entry's seq (for the rollback button). */
  auditSeq: number;
  /** Whether a confirmation is required (2nd-admin approval). */
  confirmationRequired?: boolean;
  confirmationId?: string;
}

/**
 * Set (update) a feature flag. Confirmation-gated for kill_switches.
 *
 * Flow:
 *   1. Fetch the current flag (the "before" state).
 *   2. requireConfirmation: for kill_switches, check the typed phrase + (if
 *      no confirmationId) create a pending 2nd-admin confirmation → throw
 *      ConfirmationRequiredError. The route catches this → returns 202.
 *   3. Apply the patch (via updateFlag — uses supa_system).
 *   4. Audit: `flag.<kind>.set` with { old: before, new: patch } + justification.
 *   5. Consume the confirmation (if any).
 *   6. Return the updated flag + the audit seq (for the rollback button).
 *
 * @throws ConfirmationRequiredError (202) if 2nd-admin approval is needed.
 * @throws ConfirmationError(400/403/404/409/410) if the confirmation is invalid.
 * @throws FlagError(404) if the flag doesn't exist.
 */
export async function setFlag(
  actor: AdminSession,
  key: string,
  patch: UpdateFlagInput,
  justification: string,
  opts: SetFlagOptions = {},
): Promise<SetFlagResult> {
  // 1. Fetch the before state.
  const before = await fetchFlagFromDb(key);
  if (!before) throw new FlagError("flag_not_found", 404);

  // 2. Require confirmation (kill_switch → typed phrase + 2nd admin).
  const isKillSwitch = before.kind === "kill_switch";
  const patchRecord: Record<string, unknown> = { ...patch };
  const confCtx: ConfirmationContext = {
    ...(opts.typedPhrase ? { typedPhrase: opts.typedPhrase } : {}),
    ...(opts.confirmationId ? { confirmationId: opts.confirmationId } : {}),
  };

  // This throws ConfirmationRequiredError if a 2nd admin is needed.
  await requireConfirmation(
    actor.adminId,
    {
      danger: isKillSwitch,
      phrase: `${patch.enabled === true ? "enable" : "disable"} ${key}`,
      secondAdmin: isKillSwitch,
    },
    confCtx,
    patchRecord,
    key,
  );

  // 3. Apply the patch.
  const updated = await updateFlag(key, patch);

  // 4. Audit with old/new diff + justification.
  const auditResult = await adminAudit({
    actor: actor.adminId,
    action: `flag.${before.kind}.set`,
    target: { key },
    justification,
    old: {
      enabled: before.enabled,
      rolloutPct: before.rolloutPct,
      targets: before.targets,
      kind: before.kind,
    },
    new: patchRecord,
    ip: actor.ip,
  });

  // 5. Consume the confirmation (if any).
  if (opts.confirmationId) {
    await consumeConfirmation(opts.confirmationId);
  }

  return { flag: updated, auditSeq: auditResult.seq };
}

/**
 * Check if a ConfirmationRequiredError was thrown (the route uses this to
 * return 202 with the confirmation ID).
 */
export function isConfirmationRequired(err: unknown): err is ConfirmationRequiredError {
  return err instanceof ConfirmationRequiredError;
}

// ───────────────────────────────────────────────
// previewImpact — evaluate flag state against real segments BEFORE saving
//
// The spec:
//   export async function previewImpact(key, patch) {
//     const affected = await readReplica.one(`
//       select
//         (select count(*) from users u where matches(u, ${patch.targets})) as users_affected,
//         (select count(*) from workspaces w where matches(w, ${patch.targets})) as ws_affected,
//         (select count(*) from users u where matches(u, ${patch.targets})
//            and u.plan in ('pro','team')) as paying_affected`);
//     return affected;
//   }
//
// FIXES from the spec:
// 1. `matches(u, ${patch.targets})` — non-existent function. The matching logic
//    is the same as evaluateFlag (targets.users/workspaces/plans + rollout_pct).
//    We implement it in the app layer (query the users + workspaces tables with
//    the target conditions).
// 2. `readReplica.one(...)` — raw SQL. We use Drizzle queries against the
//    default pool (no read replica yet — a follow-up would route analytics
//    queries to a read replica to avoid load on the primary).
// 3. `u.plan in ('pro','team')` — the plan is on `workspaces`, not `users`.
//    Fixed: join users → workspace_members → workspaces for the plan.
// ───────────────────────────────────────────────

export interface ImpactPreview {
  usersAffected: number;
  workspacesAffected: number;
  payingAffected: number; // users in pro/business/enterprise workspaces.
  rolloutPct: number;
  enabled: boolean;
}

/**
 * Preview the impact of a flag patch — count how many users/workspaces would
 * be affected. Shown in the UI before the confirm button enables.
 *
 * For target-based patches (users/workspaces/plans): counts the entities that
 * match the targets.
 *
 * For rollout_pct: estimates the affected user count as (rollout_pct / 100) ×
 * total users (the stable hash means ~rollout_pct% of users get the feature).
 *
 * For enabled (global): counts ALL users (the feature is on for everyone).
 */
export async function previewImpact(
  key: string,
  patch: UpdateFlagInput,
): Promise<ImpactPreview> {
  const targets = patch.targets ?? {};
  const rolloutPct = patch.rolloutPct ?? 0;
  const enabled = patch.enabled ?? false;

  // If the patch enables globally (enabled=true, no targets, rollout_pct=0):
  // all users are affected.
  if (enabled && !targets.users?.length && !targets.workspaces?.length && !targets.plans?.length && rolloutPct === 0) {
    const totalUsers = await countTotalUsers();
    const totalWs = await countTotalWorkspaces();
    const paying = await countPayingUsers();
    return {
      usersAffected: totalUsers,
      workspacesAffected: totalWs,
      payingAffected: paying,
      rolloutPct: 0,
      enabled: true,
    };
  }

  // Target-based: count matching entities.
  let usersAffected = 0;
  let workspacesAffected = 0;
  let payingAffected = 0;

  if (targets.users?.length) {
    usersAffected = targets.users.length; // explicit allowlist.
  } else if (targets.workspaces?.length) {
    // Count users in the targeted workspaces.
    usersAffected = await countUsersInWorkspaces(targets.workspaces);
    workspacesAffected = targets.workspaces.length;
  } else if (targets.plans?.length) {
    // Count workspaces on the targeted plans + their users.
    const { wsCount, userCount, payingCount } = await countByPlans(targets.plans);
    workspacesAffected = wsCount;
    usersAffected = userCount;
    payingAffected = payingCount;
  } else if (rolloutPct > 0) {
    // Rollout: ~rollout_pct% of users.
    const total = await countTotalUsers();
    usersAffected = Math.ceil((total * rolloutPct) / 100);
  }

  return {
    usersAffected,
    workspacesAffected,
    payingAffected,
    rolloutPct,
    enabled,
  };
}

// ───────────────────────────────────────────────
// Impact-preview helpers (raw SQL — the users + workspaces tables)
// ───────────────────────────────────────────────

async function countTotalUsers(): Promise<number> {
  const result = await db.execute(sql`select count(*)::integer as n from auth.users`);
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function countTotalWorkspaces(): Promise<number> {
  const result = await db.execute(sql`select count(*)::integer as n from workspaces where deleted_at is null`);
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function countPayingUsers(): Promise<number> {
  // Users in workspaces on pro/business/enterprise plans.
  const result = await db.execute(sql`
    select count(distinct wm.user_id)::integer as n
      from workspace_members wm
      join workspaces w on w.id = wm.workspace_id
     where w.deleted_at is null
       and w.plan in ('pro', 'business', 'enterprise')
  `);
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function countUsersInWorkspaces(wsIds: string[]): Promise<number> {
  if (wsIds.length === 0) return 0;
  const result = await db.execute(sql`
    select count(distinct user_id)::integer as n
      from workspace_members
     where workspace_id = any(${wsIds}::uuid[])
  `);
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function countByPlans(plans: string[]): Promise<{ wsCount: number; userCount: number; payingCount: number }> {
  if (plans.length === 0) return { wsCount: 0, userCount: 0, payingCount: 0 };
  const result = await db.execute(sql`
    select
      count(distinct w.id)::integer as ws_count,
      count(distinct wm.user_id)::integer as user_count,
      count(distinct wm.user_id) filter (where w.plan in ('pro','business','enterprise'))::integer as paying_count
    from workspaces w
    left join workspace_members wm on wm.workspace_id = w.id
    where w.deleted_at is null
      and w.plan = any(${plans}::text[])
  `);
  const row = (result as unknown as Array<{ ws_count: number; user_count: number; paying_count: number }>)[0];
  return {
    wsCount: Number(row?.ws_count ?? 0),
    userCount: Number(row?.user_count ?? 0),
    payingCount: Number(row?.paying_count ?? 0),
  };
}

// ───────────────────────────────────────────────
// listStaleFlags — flags enabled > 90d (the nightly staleness cron)
//
// The spec: "nightly job lists flags enabled > 90 with no code reference
// in latest deploys (flag key grepped from build manifests) → flags list
// shows 'stale' badge; owner paged after 180 days."
//
// The code-reference check (grepping build manifests) is deployment-specific
// + not implementable in the app layer without a build-manifest API. We
// implement the time-based staleness (enabled > 90d → stale, > 180d → page
// owner) + leave the code-reference check as a stub (returns stale=true for
// all > 90d flags — a follow-up would refine with build-manifest data).
// ───────────────────────────────────────────────

export interface StaleFlag extends FeatureFlag {
  daysEnabled: number;
  stale: boolean;       // > 90 days.
  pageOwner: boolean;   // > 180 days.
}

const STALE_THRESHOLD_DAYS = 90;
const PAGE_OWNER_THRESHOLD_DAYS = 180;

export async function listStaleFlags(): Promise<StaleFlag[]> {
  const allFlags = await listFlags();
  const now = Date.now();
  return allFlags
    .filter((f) => f.enabled) // only enabled flags can be stale.
    .map((f) => {
      const daysEnabled = Math.floor((now - f.updatedAt.getTime()) / 86400000);
      return {
        ...f,
        daysEnabled,
        stale: daysEnabled > STALE_THRESHOLD_DAYS,
        pageOwner: daysEnabled > PAGE_OWNER_THRESHOLD_DAYS,
      };
    })
    .filter((f) => f.stale); // only return stale flags.
}
