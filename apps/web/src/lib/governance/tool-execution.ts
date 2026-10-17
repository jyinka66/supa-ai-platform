// Tool execution governance — every tool call is governed.
//
// The spec (3.1): "Every call to every tool — by a user, an agent, or an
// external developer — is governed."
//
// Tool categories:
//   read-only       → no approval required (rate limits + scopes only).
//   side-effect     → user-configured approval policy (trust after N uses).
//   financial       → always require explicit approval (unless delegated).
//   destructive     → always require approval, always logged.
//   cross-workspace → never without explicit workspace permission.
//   cross-user      → never allowed.

import { assessRisk, routeDecision, executeDecision, type DecisionRequest, type DecisionResult } from "./decision-engine";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ToolCategory = "read_only" | "side_effect" | "financial" | "destructive" | "cross_workspace" | "cross_user";

export interface ToolGovernanceCheck {
  category: ToolCategory;
  requiresApproval: boolean;
  requiresDelegation: boolean;
  alwaysLogged: boolean;
  allowed: boolean;
  reason: string;
}

// ───────────────────────────────────────────────
// Tool category classification.
// ───────────────────────────────────────────────

/** Classify a tool call into a governance category. */
export function classifyToolCall(input: {
  toolKey: string;
  sideEffect: boolean;
  isFinancial: boolean;
  isDestructive: boolean;
  crossWorkspace: boolean;
  crossUser: boolean;
}): ToolCategory {
  if (input.crossUser) return "cross_user";
  if (input.crossWorkspace) return "cross_workspace";
  if (input.isDestructive) return "destructive";
  if (input.isFinancial) return "financial";
  if (input.sideEffect) return "side_effect";
  return "read_only";
}

// ───────────────────────────────────────────────
// Governance policy per category.
// ───────────────────────────────────────────────

export function getToolGovernance(category: ToolCategory): ToolGovernanceCheck {
  switch (category) {
    case "read_only":
      return {
        category,
        requiresApproval: false,
        requiresDelegation: false,
        alwaysLogged: false,
        allowed: true,
        reason: "Read-only tools: no approval required. Subject to rate limits and scopes.",
      };

    case "side_effect":
      return {
        category,
        requiresApproval: true, // default: require approval for first N uses.
        requiresDelegation: false,
        alwaysLogged: true,
        allowed: true,
        reason: "Side-effect tools: governed by user-configured approval policy. Default: require approval for first N uses, then trust after.",
      };

    case "financial":
      return {
        category,
        requiresApproval: true, // always require explicit approval.
        requiresDelegation: true, // unless delegated within bounds.
        alwaysLogged: true,
        allowed: true,
        reason: "Financial tools: always require explicit approval unless the user delegates within bounds.",
      };

    case "destructive":
      return {
        category,
        requiresApproval: true, // always.
        requiresDelegation: true, // unless delegated.
        alwaysLogged: true,
        allowed: true,
        reason: "Destructive tools: always require approval, always logged.",
      };

    case "cross_workspace":
      return {
        category,
        requiresApproval: true, // never without explicit workspace permission.
        requiresDelegation: true, // requires explicit delegation.
        alwaysLogged: true,
        allowed: false, // blocked by default — requires explicit workspace permission.
        reason: "Cross-workspace tools: never allowed without explicit workspace permission.",
      };

    case "cross_user":
      return {
        category,
        requiresApproval: false, // N/A — always blocked.
        requiresDelegation: false, // no delegation possible.
        alwaysLogged: true,
        allowed: false, // never allowed.
        reason: "Cross-user tools: never allowed.",
      };
  }
}

// ───────────────────────────────────────────────
// Side-effect tool trust policy (trust after N uses).
// ───────────────────────────────────────────────

const TRUST_THRESHOLD = 5; // after 5 approved uses, trust the tool.

/**
 * Check if a side-effect tool has been used enough times to be trusted.
 *
 * The spec: "Default: require approval for first N uses, then trust after."
 *
 * @param useCount — how many times the tool has been used (approved).
 * @returns { trusted: boolean, remainingApprovals: number }
 */
export function checkSideEffectTrust(useCount: number): { trusted: boolean; remainingApprovals: number } {
  if (useCount >= TRUST_THRESHOLD) {
    return { trusted: true, remainingApprovals: 0 };
  }
  return { trusted: false, remainingApprovals: TRUST_THRESHOLD - useCount };
}

// ───────────────────────────────────────────────
// governToolCall — the entry point for tool call governance.
//
// Flow:
//   1. Classify the tool call.
//   2. Get the governance policy.
//   3. If not allowed → blocked.
//   4. If requires approval → route through the decision engine.
//   5. Execute + log.
// ───────────────────────────────────────────────

export async function governToolCall(input: {
  toolKey: string;
  sideEffect: boolean;
  isFinancial: boolean;
  isDestructive: boolean;
  crossWorkspace: boolean;
  crossUser: boolean;
  wsId?: string;
  actorId: string;
  actorReputation?: number;
  costUsd?: number;
  useCount?: number; // for side-effect trust policy.
}): Promise<{ allowed: boolean; decision: string; category: ToolCategory; reason: string }> {
  const category = classifyToolCall(input);
  const governance = getToolGovernance(category);

  // Cross-user: never allowed.
  if (category === "cross_user") {
    return { allowed: false, decision: "blocked", category, reason: governance.reason };
  }

  // Cross-workspace: blocked by default (requires explicit workspace permission).
  if (category === "cross_workspace" && !governance.allowed) {
    // Would check for explicit workspace permission here (stub).
    return { allowed: false, decision: "blocked", category, reason: governance.reason };
  }

  // Read-only: no approval needed.
  if (category === "read_only") {
    return { allowed: true, decision: "auto_approved", category, reason: governance.reason };
  }

  // Side-effect: check trust policy.
  if (category === "side_effect") {
    const trust = checkSideEffectTrust(input.useCount ?? 0);
    if (trust.trusted) {
      return { allowed: true, decision: "auto_approved", category, reason: `Side-effect tool trusted after ${TRUST_THRESHOLD} uses.` };
    }
    // Not yet trusted — require approval.
    // Falls through to decision routing.
  }

  // Financial / destructive / untrusted side-effect: route through decision engine.
  const req: DecisionRequest = {
    actionType: `tool.call:${input.toolKey}`,
    targetType: "tool",
    targetId: input.toolKey,
    ...(input.wsId ? { wsId: input.wsId } : {}),
    actorId: input.actorId,
    ...(input.actorReputation != null ? { actorReputation: input.actorReputation } : {}),
    ...(input.costUsd != null ? { costUsd: input.costUsd } : {}),
    isIrreversible: input.isDestructive,
  };

  const result = await routeDecision(req);

  // Execute + log.
  await executeDecision(req, result);

  return {
    allowed: result.decision !== "blocked",
    decision: result.decision,
    category,
    reason: governance.reason,
  };
}
