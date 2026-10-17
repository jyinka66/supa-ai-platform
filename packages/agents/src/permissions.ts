import { z } from "zod";
import type { ToolClass, ApprovalPolicy } from "./schema.js";

export interface PermissionSet {
  allows(permission: string): boolean;
}

/** Simple set-based PermissionSet impl. */
export class SetPermissionSet implements PermissionSet {
  private readonly perms: ReadonlySet<string>;
  constructor(perms: Iterable<string>) {
    this.perms = new Set(perms);
  }
  allows(permission: string): boolean {
    return this.perms.has(permission);
  }
}

export interface ToolDef {
  id: string;
  cls: ToolClass;
  description: string;
  inputSchema: z.ZodTypeAny;
  requiredPermission: string;
  defaultApproval: ApprovalPolicy;
  timeoutMs: number;
  /** Optional in-process executor. Tools without an executor are external
   *  (registered by id only, executed by an out-of-process worker). The
   *  executor path in runs/executor.ts uses `tool.execute!(...)` only when
   *  this field is set; otherwise the call is dispatched externally and
   *  the result is polled back. */
  execute?: (wsId: string, args: unknown) => Promise<unknown>;
}

const POLICY_FLOOR: Record<ToolClass, ApprovalPolicy> = {
  read_only:    "never_ask_but_log",
  side_effect:  "always",
  financial:    "always_two_gate",
  destructive:  "always",
};

export function policyFloor(t: ToolDef): ApprovalPolicy {
  return POLICY_FLOOR[t.cls];
}

/** User-configured policy can only ever TIGHTEN, never loosen, the floor. */
export function effectivePolicy(t: ToolDef, configured: ApprovalPolicy | undefined): ApprovalPolicy {
  if (!configured) return policyFloor(t);
  const rank: Record<ApprovalPolicy, number> = {
    never_ask_but_log: 0,
    first_run: 1,
    always: 2,
    always_two_gate: 3,
  };
  return rank[configured] < rank[policyFloor(t)] ? policyFloor(t) : configured;
}

/**
 * THE PRIVILEGE RULE — enforced per tool call at run time, not config time.
 * An agent's authority = grants ∩ grantor's LIVE permissions.
 * Transitive for a2a: intersect the whole chain.
 */
export function canInvoke(
  tool: ToolDef,
  agentGrants: readonly string[],
  grantorPerms: PermissionSet,
  chainGrantorPerms: readonly PermissionSet[] = [],  // for a2a chains
): { ok: boolean; reason?: string } {
  if (!agentGrants.includes(tool.id)) {
    return { ok: false, reason: `tool_not_granted:${tool.id}` };
  }
  for (const perms of [grantorPerms, ...chainGrantorPerms]) {
    if (!perms.allows(tool.requiredPermission)) {
      return { ok: false, reason: `permission_missing:${tool.requiredPermission}` };
    }
  }
  return { ok: true };
}
