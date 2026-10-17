/**
 * @supa/workspace-core/workspace
 * ----------------------------------------------------------------
 * The tenancy spine.
 *
 * Every table, every query, every export carries workspace_id, and
 * the rule is structural, not habitual: repositories take { wsId }
 * as a required first parameter and there is NO code path to the DB
 * that omits it — enforced by a lint rule (no raw query builders
 * imported outside the repository layer) and by row-level security
 * at the DB as the second gate. Cross-tenant isolation is verified
 * by a property test that runs the entire op/query surface of one
 * workspace against another's data and asserts zero leakage — the
 * same "client is hostile, server re-validates" boundary
 * discipline, here applied to tenancy.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// WorkspaceId — branded type
// ───────────────────────────────────────────────

/**
 * A workspace id. Branded so it can't be confused with a doc id,
 * account id, or any other string. The only way to construct one
 * is via `asWorkspaceId()`, which validates the shape.
 *
 * Every repository function takes `{ wsId }: WorkspaceId` (or a
 * WorkspaceScope) as its required first parameter — there is no
 * code path to the DB that omits it.
 */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Brand a string as a WorkspaceId after validating it's a UUID. */
export function asWorkspaceId(id: string): WorkspaceId {
  if (!WORKSPACE_ID_RE.test(id)) {
    throw new WorkspaceIdError(`invalid workspace id (expected UUID): ${id}`);
  }
  return id as WorkspaceId;
}

export class WorkspaceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIdError";
  }
}

// ───────────────────────────────────────────────
// WorkspaceScope — the required first parameter for every repository
// ───────────────────────────────────────────────

/**
 * The required scope for every repository function. Carries the
 * workspace id + the caller's role (so the repository can enforce
 * capability checks at the data layer, not just at the route layer).
 *
 * There is NO code path to the DB that omits this — the type system
 * enforces it, the lint rule double-checks it, and RLS at the DB
 * is the third gate.
 */
export interface WorkspaceScope {
  readonly wsId: WorkspaceId;
  /** Caller's role in this workspace. */
  readonly role: WorkspaceRole;
  /** Caller's account id (for audit + capability checks). */
  readonly accountId: string;
}

// ───────────────────────────────────────────────
// Roles
// ───────────────────────────────────────────────

export type WorkspaceRole = "owner" | "member" | "viewer";

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  owner: 2,
};

export function roleSatisfies(held: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

// ───────────────────────────────────────────────
// Lint rule contract — no raw query builders outside repositories
// ───────────────────────────────────────────────

/**
 * The lint rule: no raw query builders (drizzle's db.select(),
 * db.insert(), etc.) imported outside packages/star/src/repositories/
 * (or apps/web/src/lib/db/repositories/). Repositories are the
 * ONLY layer that touches the DB; everything else goes through them.
 *
 * This is the same discipline as the security package's
 * LINT_RULE_NO_RAW_ACCESS — applied here to tenancy. The lint
 * rule is a structural gate; RLS at the DB is the second gate.
 */
export const LINT_RULE_NO_RAW_DB_ACCESS = {
  rule: "no-raw-db-access-outside-repositories",
  description:
    "Raw DB access (db.select/insert/update/delete) is forbidden outside repositories/. " +
    "All multi-tenant queries must go through a repository that takes { wsId } as a required first parameter.",
  forbidden: [
    "db.select()",
    "db.insert()",
    "db.update()",
    "db.delete()",
  ],
  allowlist: [
    "packages/*/src/repositories/**/*.ts",
    "apps/web/src/lib/db/repositories/**/*.ts",
  ],
};

// ───────────────────────────────────────────────
// Cross-tenant isolation property test contract
// ───────────────────────────────────────────────

/**
 * Cross-tenant isolation is verified by a property test that runs
 * the entire op/query surface of one workspace against another's
 * data and asserts zero leakage.
 *
 * The test: for every repository function `f(scope, ...args)`,
 * `f({ wsId: A, ... }, ...args_targeting_A)` must return only
 * workspace A's data — never workspace B's, even if `args` would
 * match B's rows. RLS at the DB enforces this; the property test
 * is the regression gate.
 *
 * This contract is documented here so the test runner + the lint
 * rule + RLS migrations all reference the same source of truth.
 */
export const CROSS_TENANT_ISOLATION_CONTRACT = {
  rule: "cross-tenant-isolation-property-test",
  description:
    "Every repository function is property-tested against cross-tenant data leakage. " +
    "f({wsId:A}, args_targeting_A) must return only A's data, never B's — even if args match B's rows.",
  enforcedBy: [
    "lint-rule-no-raw-db-access", // structural: no DB access outside repositories
    "rls-at-db",                  // runtime: row-level security policies
    "property-test-isolation",    // regression: every repository function tested
  ],
};

// ───────────────────────────────────────────────
// Workspace entity
// ───────────────────────────────────────────────

export interface Workspace {
  readonly id: WorkspaceId;
  /** Display name (e.g. "Acme Ltd"). */
  readonly name: string;
  /** Owner account id. */
  readonly ownerAccountId: string;
  /** Created at (ms epoch). */
  readonly createdAt: number;
  /** Workspace-level currency config (base currency for reports). */
  readonly baseCurrency: string;
  /** Plan tier (free/pro/enterprise). */
  readonly plan: "free" | "pro" | "enterprise";
  /** Soft-deleted at (null = active). */
  readonly deletedAt: number | null;
}

// ───────────────────────────────────────────────
// Membership — the role resolution per workspace
// ───────────────────────────────────────────────

export interface WorkspaceMembership {
  readonly workspaceId: WorkspaceId;
  readonly accountId: string;
  readonly role: WorkspaceRole;
  /** When the membership was created. */
  readonly addedAt: number;
  /** When the membership was revoked (null = active). */
  readonly revokedAt: number | null;
}

/**
 * Resolve the caller's role in a workspace. Returns null if the
 * caller is not a member (or membership was revoked). This is the
 * single authority for "what role does this account have in this
 * workspace?" — used by every capability check.
 */
export type RoleResolver = (wsId: WorkspaceId, accountId: string) => Promise<WorkspaceRole | null>;

// ───────────────────────────────────────────────
// WorkspaceScope construction
// ───────────────────────────────────────────────

/**
 * Build a WorkspaceScope from a workspace id + account id, using
 * the provided RoleResolver to look up the caller's role.
 *
 * Throws if the caller is not a member of the workspace (or
 * membership was revoked). This is the single entry point for
 * constructing a WorkspaceScope — there is no other way.
 */
export async function buildScope(
  wsId: WorkspaceId,
  accountId: string,
  resolveRole: RoleResolver,
): Promise<WorkspaceScope> {
  const role = await resolveRole(wsId, accountId);
  if (!role) {
    throw new WorkspaceAccessError(
      `account ${accountId} is not a member of workspace ${wsId}`,
    );
  }
  return { wsId, role, accountId };
}

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}
