// Permission registry — the closed enum of permissions.
//
// Admins pick from this list, never invent strings. The CI linter verifies
// that no policy references raw role names except owner/admin (the built-in
// hierarchy). Custom roles are defined by their permissions array — the
// `has_permission()` pg function checks if the user's role grants the
// required permission.
//
// Owner is implied-all: the owner role's permissions array contains every
// permission, so `has_permission(ws, 'any:permission')` returns true for
// the owner without a special case.

// ───────────────────────────────────────────────
// PERMISSIONS — the closed enum
// ───────────────────────────────────────────────

export const PERMISSIONS = {
  // File operations.
  "file:read": [],
  "file:write": [],
  "file:share": [],
  "file:delete": [],

  // Member management.
  "member:invite": [],
  "member:remove": [],
  "member:role:change": [],

  // Role management (create/edit/delete custom roles).
  "role:manage": [],

  // Webhook management.
  "webhook:manage": [],

  // SSO management (configure SAML/OIDC connections).
  "sso:manage": [],

  // Audit log read.
  "audit:read": [],

  // Billing management.
  "billing:manage": [],

  // Agent operations.
  "agent:read": [],
  "agent:run": [],
  "agent:manage": [],

  // Workspace settings.
  "settings:read": [],
  "settings:write": [],

  // Retention + legal hold.
  "retention:manage": [],
} as const;

export type Permission = keyof typeof PERMISSIONS;

// ───────────────────────────────────────────────
// Built-in role → permission mapping
// ───────────────────────────────────────────────

/**
 * The built-in role → permission mapping. Used for backfilling the `roles`
 * table when a new workspace is created (migration 0043 + the create_workspace
 * security-definer function).
 *
 * Owner: all permissions (implied-all).
 * Admin: file + member + webhook + audit + settings (no billing, no SSO, no role management).
 * Member: file read/write (basic access).
 * Guest: file read (read-only).
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: Object.keys(PERMISSIONS) as Permission[],
  admin: [
    "file:read", "file:write", "file:share", "file:delete",
    "member:invite", "member:remove", "member:role:change",
    "webhook:manage",
    "audit:read",
    "agent:read", "agent:run", "agent:manage",
    "settings:read", "settings:write",
  ],
  member: [
    "file:read", "file:write",
    "agent:read", "agent:run",
    "settings:read",
  ],
  guest: [
    "file:read",
  ],
};

// ───────────────────────────────────────────────
// Permission validation
// ───────────────────────────────────────────────

/**
 * Validate that a permission string is in the closed registry.
 * Used when creating/editing custom roles — admins can only pick from
 * the registry, never invent strings.
 */
export function isValidPermission(perm: string): perm is Permission {
  return perm in PERMISSIONS;
}

/**
 * Validate a permissions array — all must be in the registry.
 * Returns `{ valid, invalid }` — the invalid ones are reported to the caller.
 */
export function validatePermissions(perms: string[]): { valid: Permission[]; invalid: string[] } {
  const valid: Permission[] = [];
  const invalid: string[] = [];
  for (const p of perms) {
    if (isValidPermission(p)) {
      valid.push(p);
    } else {
      invalid.push(p);
    }
  }
  return { valid, invalid };
}

// ───────────────────────────────────────────────
// hasPermission — app-layer check
// ───────────────────────────────────────────────

import { db } from "@supa/db";
import { memberships, roles } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

/**
 * Check if a user has a specific permission in a workspace.
 *
 * Uses the `has_permission()` pg function (migration 0043) — checks the
 * user's role's permissions array. Owner is implied-all.
 *
 * This is the app-layer equivalent of the DB `has_permission()` function.
 * Use in route handlers + service functions:
 *   ```
 *   if (!(await hasPermission(wsId, uid, "member:invite"))) {
 *     throw new ApiError("forbidden", 403);
 *   }
 *   ```
 *
 * For RLS policies, use the DB function directly:
 *   `using (has_permission(ws_id, 'member:invite'))`
 */
export async function hasPermission(
  wsId: string,
  uid: string,
  permission: Permission,
): Promise<boolean> {
  const result = await db.execute(sql`
    select has_permission(${wsId}::uuid, ${permission}) as has_perm
  `);
  const rows = result as unknown as { rows: { has_perm: boolean }[] };
  return rows.rows[0]?.has_perm ?? false;
}

/**
 * Assert that the user has a specific permission. Throws ApiError(403) if not.
 */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function assertPermission(
  wsId: string,
  uid: string,
  permission: Permission,
): Promise<void> {
  if (!(await hasPermission(wsId, uid, permission))) {
    throw new ApiError(`permission_denied:${permission}`, 403);
  }
}

// ───────────────────────────────────────────────
// Role CRUD — create/list/update/delete custom roles
// ───────────────────────────────────────────────

/**
 * Create a custom role. Admin+ only (checked by the caller). Validates
 * that all permissions are in the registry.
 *
 * Built-in roles (owner/admin/member/guest) can't be created — they're
 * created automatically when the workspace is created.
 */
export async function createRole(
  wsId: string,
  name: string,
  permissions: string[],
): Promise<{ id: string }> {
  const { valid, invalid } = validatePermissions(permissions);
  if (invalid.length > 0) {
    throw new ApiError(`invalid_permissions:${invalid.join(",")}`, 400);
  }

  const rows = await db
    .insert(roles)
    .values({
      workspaceId: wsId as any,
      name,
      builtIn: false,
      permissions: valid,
    })
    .returning({ id: roles.id });

  const row = rows[0];
  if (!row) throw new ApiError("role_insert_failed", 500);
  return { id: row.id };
}

/**
 * List all roles for a workspace (built-in + custom).
 */
export async function listRoles(wsId: string): Promise<{
  id: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
}[]> {
  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      builtIn: roles.builtIn,
      permissions: roles.permissions,
    })
    .from(roles)
    .where(eq(roles.workspaceId, wsId as any));

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name,
    builtIn: r.builtIn,
    permissions: r.permissions as string[],
  }));
}

/**
 * Update a custom role's permissions. Admin+ only. Built-in roles can't be
 * modified (immutable).
 */
export async function updateRole(
  wsId: string,
  roleId: string,
  permissions: string[],
): Promise<void> {
  // Check it's not a built-in role.
  const rows = await db
    .select({ builtIn: roles.builtIn })
    .from(roles)
    .where(and(eq(roles.id, roleId as any), eq(roles.workspaceId, wsId as any)))
    .limit(1);

  const role = rows[0];
  if (!role) throw new ApiError("role_not_found", 404);
  if (role.builtIn) throw new ApiError("cannot_modify_builtin_role", 403);

  const { valid, invalid } = validatePermissions(permissions);
  if (invalid.length > 0) {
    throw new ApiError(`invalid_permissions:${invalid.join(",")}`, 400);
  }

  await db
    .update(roles)
    .set({ permissions: valid })
    .where(eq(roles.id, roleId as any));
}

/**
 * Delete a custom role. Admin+ only. Built-in roles can't be deleted.
 * Memberships pointing at this role are set to role_id=null (the user
 * loses their role — they'll need to be re-assigned).
 */
export async function deleteRole(wsId: string, roleId: string): Promise<void> {
  const rows = await db
    .select({ builtIn: roles.builtIn })
    .from(roles)
    .where(and(eq(roles.id, roleId as any), eq(roles.workspaceId, wsId as any)))
    .limit(1);

  const role = rows[0];
  if (!role) throw new ApiError("role_not_found", 404);
  if (role.builtIn) throw new ApiError("cannot_delete_builtin_role", 403);

  // Null out memberships pointing at this role (customRoleId).
  await db
    .update(memberships)
    .set({ customRoleId: null })
    .where(eq(memberships.customRoleId, roleId as any));

  // Delete the role.
  await db.delete(roles).where(eq(roles.id, roleId as any));
}
