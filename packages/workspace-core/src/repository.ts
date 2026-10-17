/**
 * @supa/workspace-core/repository
 * ----------------------------------------------------------------
 * The repository contract: every repository function takes a
 * WorkspaceScope as its required first parameter. There is no code
 * path to the DB that omits it.
 *
 * This module provides:
 *   - The `Repository` base interface that all repositories implement.
 *   - The `withScope` helper for constructing scoped repository calls.
 *   - The cross-tenant isolation property-test contract (the
 *     regression gate that runs every repository function against
 *     another workspace's data and asserts zero leakage).
 * ----------------------------------------------------------------
 */

import type { WorkspaceScope, WorkspaceId } from "./workspace.js";
import type { WorkspaceAction, Resource } from "./capabilities.js";
import { assertCan } from "./capabilities.js";

// ───────────────────────────────────────────────
// Repository — the only DB access layer
// ───────────────────────────────────────────────

/**
 * Every repository implements this interface. The contract:
 *   - Every function takes a `WorkspaceScope` as the first parameter.
 *   - Every function asserts the caller's capability before touching data.
 *   - Every function's DB query is scoped by `wsId` (the workspace id).
 *   - No function ever returns data from another workspace.
 *
 * The lint rule `LINT_RULE_NO_RAW_DB_ACCESS` from `./workspace.ts`
 * enforces that no code outside repositories/ touches the DB.
 */
export interface Repository {
  /** The workspace id this repository is scoped to. */
  readonly wsId: WorkspaceId;
}

// ───────────────────────────────────────────────
// Scoped call — capability check + repository call
// ───────────────────────────────────────────────

/**
 * Run a repository function with a capability check first. Throws
 * UnauthorizedError if the caller's role doesn't satisfy the action.
 *
 * Usage:
 *   const invoice = await scoped(
 *     scope, "invoice.read", { kind: "invoice", id: invoiceId },
 *     () => invoiceRepo.findById(scope, invoiceId),
 *   );
 *
 * The capability check is the first gate. The repository's DB query
 * (scoped by wsId) is the second gate. RLS at the DB is the third
 * gate. Three gates, one rule: cross-tenant isolation.
 */
export async function scoped<T>(
  scope: WorkspaceScope,
  action: WorkspaceAction,
  resource: Resource,
  fn: () => Promise<T>,
): Promise<T> {
  assertCan(scope, action, resource);
  return fn();
}

// ───────────────────────────────────────────────
// Cross-tenant isolation property test
// ───────────────────────────────────────────────

/**
 * The property test contract: for every repository function `f`,
 * `f({ wsId: A, ... }, ...args_targeting_A)` must return only
 * workspace A's data — never workspace B's.
 *
 * This module provides the test harness that runs every repository
 * function against cross-tenant data. The test is the regression
 * gate; RLS at the DB is the runtime gate; the lint rule is the
 * structural gate.
 */
export interface IsolationTest {
  /** Name of the repository function under test. */
  readonly fnName: string;
  /**
   * Run the function with scope A, against args that would match
   * workspace B's rows. Returns the result.
   */
  runWithScopeA: () => Promise<unknown>;
  /** The expected result: empty / null / zero (no B data leaked). */
  expectEmpty: (result: unknown) => boolean;
}

export async function runIsolationTest(test: IsolationTest): Promise<{ passed: boolean; reason?: string }> {
  const result = await test.runWithScopeA();
  if (!test.expectEmpty(result)) {
    return {
      passed: false,
      reason: `${test.fnName} leaked cross-tenant data: ${JSON.stringify(result).slice(0, 200)}`,
    };
  }
  return { passed: true };
}

// ───────────────────────────────────────────────
// Repository error types
// ───────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(
    message: string,
    readonly resourceKind: string,
    readonly resourceId: string,
    readonly wsId: WorkspaceId,
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
