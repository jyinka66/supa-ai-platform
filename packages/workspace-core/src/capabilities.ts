/**
 * @supa/workspace-core/capabilities
 * ----------------------------------------------------------------
 * Capability checks: can(user, action, resource) — the single
 * authority for "is this account allowed to do this thing in this
 * workspace?" The design system's capability checks pattern returns
 * here with no exceptions in the UI layer.
 *
 * Every route handler calls `can(scope, action, resource)` before
 * touching the repository. The repository layer also enforces
 * capabilities at the data layer (defense in depth — UI is the
 * first gate, repository is the second, RLS is the third).
 * ----------------------------------------------------------------
 */

import type { WorkspaceRole, WorkspaceScope } from "./workspace.js";
import { roleSatisfies } from "./workspace.js";

// ───────────────────────────────────────────────
// Actions — closed taxonomy
// ───────────────────────────────────────────────

/**
 * Closed taxonomy of actions. Adding a new action requires updating
 * the role-action matrix below — there is no default-allow.
 */
export type WorkspaceAction =
  | "workspace.read"
  | "workspace.update"
  | "workspace.delete"
  | "workspace.member.invite"
  | "workspace.member.remove"
  | "workspace.member.role.change"
  | "profile.create"
  | "profile.read"
  | "profile.update"
  | "profile.delete"
  | "invoice.create"
  | "invoice.read"
  | "invoice.update"
  | "invoice.delete"
  | "invoice.send"
  | "invoice.void"
  | "expense.create"
  | "expense.read"
  | "expense.update"
  | "expense.delete"
  | "report.read"
  | "report.export"
  | "bank.account.add"
  | "bank.account.remove"
  | "settings.read"
  | "settings.update";

// ───────────────────────────────────────────────
// Role-action matrix — the single source of truth
// ───────────────────────────────────────────────

/**
 * The role-action matrix. Owner can do everything; member can do
 * most operational things but not workspace-management; viewer can
 * only read.
 *
 * This matrix is the single source of truth — there is no other
 * place in the codebase that decides "is this role allowed to do
 * this action?". Adding a new action means adding it here, which
 * forces a deliberate decision about which roles can perform it.
 */
const ROLE_ACTION_MATRIX: Record<WorkspaceAction, WorkspaceRole> = {
  // Workspace management — owner only.
  "workspace.read": "viewer",
  "workspace.update": "owner",
  "workspace.delete": "owner",
  "workspace.member.invite": "owner",
  "workspace.member.remove": "owner",
  "workspace.member.role.change": "owner",

  // Profiles — owner can manage; member can read; viewer can read.
  "profile.create": "owner",
  "profile.read": "viewer",
  "profile.update": "owner",
  "profile.delete": "owner",

  // Invoices — member can create/edit/send; viewer can read.
  "invoice.create": "member",
  "invoice.read": "viewer",
  "invoice.update": "member",
  "invoice.delete": "owner",
  "invoice.send": "member",
  "invoice.void": "owner",

  // Expenses — member can create/edit; viewer can read.
  "expense.create": "member",
  "expense.read": "viewer",
  "expense.update": "member",
  "expense.delete": "owner",

  // Reports — viewer can read; export requires member.
  "report.read": "viewer",
  "report.export": "member",

  // Bank accounts — owner only (sensitive).
  "bank.account.add": "owner",
  "bank.account.remove": "owner",

  // Settings — owner can update; viewer can read.
  "settings.read": "viewer",
  "settings.update": "owner",
};

// ───────────────────────────────────────────────
// Resource — what the action targets
// ───────────────────────────────────────────────

/**
 * A resource the action targets. The resource is used for audit +
 * telemetry — it doesn't affect the role check (the role check is
 * purely role × action). But the resource is recorded so the audit
 * log can answer "who touched this invoice?".
 */
export interface Resource {
  readonly kind: "workspace" | "profile" | "invoice" | "expense" | "report" | "bank-account" | "settings" | "member";
  readonly id: string;
}

// ───────────────────────────────────────────────
// can(user, action, resource) — the single authority
// ───────────────────────────────────────────────

/**
 * THE function. Every route handler + repository function calls
 * this before touching data. Returns true if the caller's role
 * satisfies the action's required role.
 *
 * There is no default-allow: actions not in the matrix throw
 * (catches "I forgot to add this action to the matrix" bugs).
 */
export function can(
  scope: WorkspaceScope,
  action: WorkspaceAction,
  _resource: Resource,
): boolean {
  if (!Object.hasOwn(ROLE_ACTION_MATRIX, action)) {
    throw new UnknownActionError(`action not in role-action matrix: ${action}`);
  }
  return roleSatisfies(scope.role, ROLE_ACTION_MATRIX[action]);
}

/**
 * Assert that the caller can perform the action. Throws
 * UnauthorizedError if not. Use this in route handlers + repository
 * functions as the gate.
 */
export function assertCan(
  scope: WorkspaceScope,
  action: WorkspaceAction,
  resource: Resource,
): void {
  if (!can(scope, action, resource)) {
    throw new UnauthorizedError(
      `account ${scope.accountId} (role ${scope.role}) cannot ${action} on ${resource.kind}/${resource.id} in workspace ${scope.wsId}`,
    );
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class UnknownActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownActionError";
  }
}

// ───────────────────────────────────────────────
// Action → resource-kind mapping (for validation)
// ───────────────────────────────────────────────

/**
 * Map an action to the resource kind it targets. Used to validate
 * that the resource passed to `can()` matches the action — catches
 * "passed the wrong resource" bugs.
 */
const ACTION_RESOURCE_KIND: Record<WorkspaceAction, Resource["kind"]> = {
  "workspace.read": "workspace",
  "workspace.update": "workspace",
  "workspace.delete": "workspace",
  "workspace.member.invite": "member",
  "workspace.member.remove": "member",
  "workspace.member.role.change": "member",
  "profile.create": "profile",
  "profile.read": "profile",
  "profile.update": "profile",
  "profile.delete": "profile",
  "invoice.create": "invoice",
  "invoice.read": "invoice",
  "invoice.update": "invoice",
  "invoice.delete": "invoice",
  "invoice.send": "invoice",
  "invoice.void": "invoice",
  "expense.create": "expense",
  "expense.read": "expense",
  "expense.update": "expense",
  "expense.delete": "expense",
  "report.read": "report",
  "report.export": "report",
  "bank.account.add": "bank-account",
  "bank.account.remove": "bank-account",
  "settings.read": "settings",
  "settings.update": "settings",
};

/**
 * Validate that the resource kind matches the action. Throws if
 * mismatched — catches "passed the wrong resource" bugs.
 */
export function assertResourceMatchesAction(action: WorkspaceAction, resource: Resource): void {
  const expected = ACTION_RESOURCE_KIND[action];
  if (resource.kind !== expected) {
    throw new ResourceMismatchError(
      `action ${action} expects resource kind ${expected}, got ${resource.kind}`,
    );
  }
}

export class ResourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceMismatchError";
  }
}

/**
 * Convenience: can + resource-kind validation in one call. Use this
 * in route handlers — it catches both "wrong role" and "wrong
 * resource kind" in a single check.
 */
export function canWithValidation(
  scope: WorkspaceScope,
  action: WorkspaceAction,
  resource: Resource,
): boolean {
  assertResourceMatchesAction(action, resource);
  return can(scope, action, resource);
}
