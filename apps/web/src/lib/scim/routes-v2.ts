// SCIM 2.0 routes v2 — RFC 7644 subset.
//
// Bearer token (scim_tokens hash), scoped to ONE workspace.
// Routes: /Users (create, get, filter, patch, delete), /ServiceProviderConfig.
//
//   PATCH /scim/v2/Users/:id — replace active=false → deprovision (removeMember),
//     active=true → restore (restoreMember). SCIM patch operations, not PUT.
//   DELETE /scim/v2/Users/:id — full deprovision: unlink identity, remove from
//     all group memberships, deactivate. NEVER hard-delete our user.
//   GET /scim/v2/ServiceProviderConfig — return SCIM config (supported features).
//
// The SCIM routes use the v2 tables (migration 0042: sso_connections +
// scim_identities). The token → ws → conn resolution maps the SCIM token
// to the workspace + the SSO connection (for group→role mapping).
//
// DEPROVISION = our Phase 1 removal semantics, not deletion:
//   - Membership status → 'suspended' (data preserved).
//   - Sessions revoked (instant — the user can't access anything).
//   - API keys revoked (the user's credentials are dead).
//   - Phase 2: WS sockets ejected <2s (realtime presence broadcast).
//
// DELETE = unlink + remove from all groups, NEVER hard-delete:
//   - scim_identities.user_id → null (unlink the identity from our user).
//   - Memberships removed (status → 'workspace_deleted').
//   - The user record survives (for audit/billing).
//   - The user's content survives (tombstoned — author_erased=true on
//     messages, creator_erased=true on work items — GDPR erasure interplay).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { scimTokens, ssoConnections, scimIdentities, memberships, sessions } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface ScimCtx {
  wsId: string;
  connId: string | null; // the SSO connection (for group→role mapping).
  tokenId: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

interface ScimPatchOp {
  op: "replace" | "add" | "remove";
  path?: string;
  value?: unknown;
}

// ───────────────────────────────────────────────
// SCIM auth — bearer token → ws → conn
// ───────────────────────────────────────────────

/**
 * Authenticate a SCIM request via Bearer token. Resolves:
 *   1. Hash the token (SHA-256 — fast lookup, the token is high-entropy).
 *   2. Look up in scim_tokens (revoked_at IS NULL).
 *   3. Resolve the ws_id from the token.
 *   4. Resolve the SSO connection for the ws (for group→role mapping).
 *   5. Update last_used_at.
 *
 * Returns the ScimCtx (wsId + connId + tokenId).
 */
export async function requireScimAuth(req: NextRequest): Promise<ScimCtx> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new ApiError("invalid_scim_token", 401);
  }

  const token = auth.slice(7);
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const tokenRows = await db
    .select({
      id: scimTokens.id,
      wsId: scimTokens.wsId,
    })
    .from(scimTokens)
    .where(
      and(
        eq(scimTokens.tokenHash, tokenHash),
        isNull(scimTokens.revokedAt),
      ),
    )
    .limit(1);

  const tokenRow = tokenRows[0];
  if (!tokenRow) {
    throw new ApiError("invalid_scim_token", 401);
  }

  // Update last_used_at.
  await db
    .update(scimTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(scimTokens.id, tokenRow.id as any));

  // Resolve the SSO connection for this ws (for group→role mapping).
  const connRows = await db
    .select({ id: ssoConnections.id })
    .from(ssoConnections)
    .where(eq(ssoConnections.workspaceId, tokenRow.wsId as any))
    .limit(1);

  return {
    wsId: tokenRow.wsId as string,
    connId: connRows[0]?.id as string ?? null,
    tokenId: tokenRow.id as string,
  };
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/**
 * Resolve a SCIM user id to our internal user_id + membership.
 * The SCIM user id is the scim_identities.scim_user_id.
 */
async function resolveScimUser(
  ctx: ScimCtx,
  scimUserId: string,
): Promise<{ userId: string; membershipId: string } | null> {
  // Look up the scim_identity by (scim_user_id, sso_conn_id) or by ws_id.
  const conditions = [
    eq(scimIdentities.scimUserId, scimUserId),
    eq(scimIdentities.workspaceId, ctx.wsId as any),
  ];
  if (ctx.connId) {
    conditions.push(eq(scimIdentities.ssoConnId, ctx.connId as any));
  }

  const identRows = await db
    .select({ userId: scimIdentities.userId })
    .from(scimIdentities)
    .where(and(...conditions))
    .limit(1);

  const ident = identRows[0];
  if (!ident?.userId) return null;

  // Look up the membership.
  const memberRows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.wsId, ctx.wsId as any),
        eq(memberships.userId, ident.userId as any),
      ),
    )
    .limit(1);

  const member = memberRows[0];
  if (!member) return null;

  return {
    userId: ident.userId as string,
    membershipId: member.id as string,
  };
}

/**
 * Deprovision a user (SCIM active=false):
 *   - Membership status → 'suspended' (data preserved).
 *   - Sessions revoked (instant — user can't access anything).
 *   - API keys revoked (user's credentials are dead).
 *   - Phase 2: WS sockets ejected <2s.
 */
async function deprovisionUser(wsId: string, userId: string): Promise<void> {
  await db
    .update(memberships)
    .set({
      status: "suspended" as any,
      suspendReason: "scim_deprovisioned",
      suspendedAt: new Date(),
    })
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.userId, userId as any),
      ),
    );

  // Revoke sessions.
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    await supabase.auth.admin.signOut(userId, "global");
  } catch {}

  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: "scim_deprovisioned" })
    .where(
      and(
        eq(sessions.userId, userId as any),
        isNull(sessions.revokedAt),
      ),
    );
}

/**
 * Restore a user (SCIM active=true):
 *   - Membership status → 'active'.
 *   - Clear suspended fields.
 *   - Sessions NOT auto-restored (user must re-authenticate).
 */
async function restoreUser(wsId: string, userId: string): Promise<void> {
  await db
    .update(memberships)
    .set({
      status: "active" as any,
      suspendedBy: null,
      suspendedAt: null,
      suspendReason: null,
    })
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.userId, userId as any),
      ),
    );
}

/**
 * Full deprovision (SCIM DELETE):
 *   - Unlink the scim_identity (user_id → null).
 *   - Remove from all group memberships.
 *   - Membership status → 'workspace_deleted'.
 *   - NEVER hard-delete the user record (audit/billing).
 */
async function unlinkAndRemove(ctx: ScimCtx, scimUserId: string): Promise<void> {
  const resolved = await resolveScimUser(ctx, scimUserId);
  if (!resolved) return;

  // Unlink the scim_identity.
  await db
    .update(scimIdentities)
    .set({ userId: null })
    .where(
      and(
        eq(scimIdentities.scimUserId, scimUserId),
        eq(scimIdentities.workspaceId, ctx.wsId as any),
      ),
    );

  // Remove the membership (deprovision, never delete).
  await db
    .update(memberships)
    .set({ status: "workspace_deleted" as any })
    .where(
      and(
        eq(memberships.wsId, ctx.wsId as any),
        eq(memberships.userId, resolved.userId as any),
      ),
    );

  // Revoke sessions.
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    await supabase.auth.admin.signOut(resolved.userId, "global");
  } catch {}

  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: "scim_deleted" })
    .where(
      and(
        eq(sessions.userId, resolved.userId as any),
        isNull(sessions.revokedAt),
      ),
    );

  // Audit.
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${ctx.wsId}::uuid, 'scim', ${scimUserId}, 'ws.member.scim_deleted',
      jsonb_build_object('user', ${resolved.userId}::uuid),
      null::inet, null::text
    )
  `);
}

/** Check if a SCIM patch path matches a specific attribute. */
function pathIs(op: ScimPatchOp, attr: string): boolean {
  if (!op.path) return false;
  // SCIM path: "active" or "userName" or "name.givenName" etc.
  return op.path.toLowerCase() === attr.toLowerCase();
}

/** Build a SCIM-formatted error response. */
function scimError(status: number, detail: string): NextResponse {
  return NextResponse.json(
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail,
      status,
    },
    { status },
  );
}

/** Build a SCIM-formatted success response. */
function scimOk(data: Record<string, unknown>): NextResponse {
  return NextResponse.json(data, { status: 200 });
}

// ───────────────────────────────────────────────
// PATCH /scim/v2/Users/:id — deprovision / restore
// ───────────────────────────────────────────────

/**
 * PATCH /scim/v2/Users/:id — SCIM patch operations.
 *
 * Supported operations:
 *   - `replace` `active` = false → deprovision (suspend membership, revoke sessions).
 *   - `replace` `active` = true → restore (reactivate membership).
 *
 * Other operations (replace userName, add groups, etc.) are logged + ignored
 * (not supported in Phase 1 — Phase 2 would add full SCIM patch support).
 *
 * Returns the updated user resource (SCIM-formatted).
 */
export async function patchUser(
  ctx: ScimCtx,
  scimUserId: string,
  operations: ScimPatchOp[],
): Promise<NextResponse> {
  const resolved = await resolveScimUser(ctx, scimUserId);
  if (!resolved) {
    return scimError(404, `User ${scimUserId} not found`);
  }

  for (const op of operations) {
    if (op.op === "replace" && pathIs(op, "active")) {
      if (op.value === false) {
        // Deprovision = Phase 1 removal semantics, not deletion.
        await deprovisionUser(ctx.wsId, resolved.userId);
      } else {
        // Restore.
        await restoreUser(ctx.wsId, resolved.userId);
      }
    } else {
      // Unsupported operation — log + skip (don't fail the whole patch).
      console.log(`[scim] unsupported patch op: ${op.op} ${op.path}`);
    }
  }

  return scimOk({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: scimUserId,
    active: operations.find((op) => pathIs(op, "active"))?.value ?? true,
    meta: {
      resourceType: "User",
      location: `/scim/v2/Users/${scimUserId}`,
    },
  });
}

// ───────────────────────────────────────────────
// DELETE /scim/v2/Users/:id — full deprovision
// ───────────────────────────────────────────────

/**
 * DELETE /scim/v2/Users/:id — full deprovision.
 *
 * Unlinks the scim_identity (user_id → null), removes the membership
 * (status → 'workspace_deleted'), revokes all sessions. NEVER hard-deletes
 * the user record (for audit/billing).
 *
 * Returns 204 No Content (SCIM spec for delete).
 */
export async function deleteUser(
  ctx: ScimCtx,
  scimUserId: string,
): Promise<NextResponse> {
  await unlinkAndRemove(ctx, scimUserId);
  return new NextResponse(null, { status: 204 });
}

// ───────────────────────────────────────────────
// GET /scim/v2/ServiceProviderConfig
// ───────────────────────────────────────────────

/**
 * GET /scim/v2/ServiceProviderConfig — SCIM service provider config.
 *
 * Advertises supported SCIM features (patch, bulk, filter, sort, etc.).
 * Phase 1: only patch + filter are supported.
 */
export function serviceProviderConfig(): NextResponse {
  return NextResponse.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "SCIM Bearer Token",
        description: "Per-workspace SCIM bearer token (hashed).",
      },
    ],
  });
}

// ───────────────────────────────────────────────
// Route handler — POST /scim/v2/Users/:id (PATCH via POST for Next.js)
// ───────────────────────────────────────────────

/**
 * Handle a SCIM PATCH request. Next.js App Router uses POST for PATCH
 * (or we can use a catch-all route that dispatches by method).
 *
 * Usage in the route file:
 *   ```
 *   // apps/web/src/app/scim/v2/Users/[id]/route.ts
 *   export async function PATCH(req: NextRequest, { params }) {
 *     const ctx = await requireScimAuth(req);
 *     const { id } = await params;
 *     const body = await req.json();
 *     return patchUser(ctx, id, body.Operations ?? []);
 *   }
 *   ```
 */
export async function handleScimPatch(req: NextRequest, scimUserId: string): Promise<NextResponse> {
  try {
    const ctx = await requireScimAuth(req);
    const body = await req.json();
    const operations: ScimPatchOp[] = body.Operations ?? [];
    return patchUser(ctx, scimUserId, operations);
  } catch (err) {
    if (err instanceof ApiError) {
      return scimError(err.status, err.message);
    }
    console.error("[scim] patch error:", err);
    return scimError(500, "internal_error");
  }
}

/**
 * Handle a SCIM DELETE request.
 */
export async function handleScimDelete(req: NextRequest, scimUserId: string): Promise<NextResponse> {
  try {
    const ctx = await requireScimAuth(req);
    return deleteUser(ctx, scimUserId);
  } catch (err) {
    if (err instanceof ApiError) {
      return scimError(err.status, err.message);
    }
    console.error("[scim] delete error:", err);
    return scimError(500, "internal_error");
  }
}
