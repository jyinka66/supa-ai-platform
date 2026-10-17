// Agent action governance — 4-level governance + prohibited actions.
//
// The spec (3.2): "Agents are autonomous workers. Their actions are governed
// at four levels: tool-level, agent-level, platform-level, context-level."
//
// Agents may NOT:
//   - Escalate their own permissions.
//   - Modify their own budget or approval rules.
//   - Access another user's data.
//   - Call tools not in their scope.
//   - Bypass platform rate limits.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface AgentGovernanceConfig {
  agentId: string;
  wsId: string;
  // Agent-level governance.
  scopes: string[];                    // allowed tool keys.
  budgetLimitUsd: number;              // per-run budget.
  approvalRules: {
    requireApprovalForSideEffects: boolean;
    requireApprovalForFinancial: boolean; // always true.
    requireApprovalForDestructive: boolean; // always true.
    trustAfterNUses: number;
  };
  // Context-level governance.
  goals: string[];                     // the agent's bounded goals.
  memoryScope: "workspace" | "conversation" | "user";
  userInstructions: string;            // the user's explicit instructions.
}

export interface AgentActionCheck {
  allowed: boolean;
  level: "tool" | "agent" | "platform" | "context";
  reason: string;
  prohibited: boolean; // true if this is a prohibited action.
}

// ───────────────────────────────────────────────
// Prohibited actions — agents may NEVER do these.
// ───────────────────────────────────────────────

export const PROHIBITED_ACTIONS = [
  "permission.escalate",      // escalate their own permissions.
  "budget.modify",            // modify their own budget.
  "approval.modify",          // modify their own approval rules.
  "scope.expand",             // call tools not in their scope.
  "ratelimit.bypass",         // bypass platform rate limits.
  "user.data.access_other",  // access another user's data.
] as const;

export function isProhibitedAction(actionType: string): boolean {
  return (PROHIBITED_ACTIONS as readonly string[]).includes(actionType);
}

// ───────────────────────────────────────────────
// 4-level agent governance check.
// ───────────────────────────────────────────────

export function checkAgentAction(input: {
  config: AgentGovernanceConfig;
  actionType: string;
  toolKey?: string;
  costUsd?: number;
  cumulativeCostUsd?: number;
  targetUserId?: string;
  targetWsId?: string;
}): AgentActionCheck {
  const { config } = input;

  // Level 0: Prohibited actions (checked first — absolute block).
  if (isProhibitedAction(input.actionType)) {
    return {
      allowed: false,
      level: "platform",
      reason: `Prohibited action: "${input.actionType}" — agents may never perform this action.`,
      prohibited: true,
    };
  }

  // Level 1: Tool-level governance — is the tool in the agent's scope?
  if (input.toolKey && !config.scopes.includes(input.toolKey)) {
    return {
      allowed: false,
      level: "tool",
      reason: `Tool "${input.toolKey}" is not in the agent's scope. Agents may not call tools outside their scope.`,
      prohibited: false,
    };
  }

  // Level 2: Agent-level governance — budget + approval rules.
  if (input.cumulativeCostUsd != null && input.costUsd != null) {
    const totalCost = input.cumulativeCostUsd + input.costUsd;
    if (totalCost > config.budgetLimitUsd) {
      return {
        allowed: false,
        level: "agent",
        reason: `Budget exceeded: $${totalCost.toFixed(2)} > $${config.budgetLimitUsd.toFixed(2)} (agent budget limit).`,
        prohibited: false,
      };
    }
  }

  // Level 3: Platform-level governance — rate limits + kill switches.
  // (Would call isKillSwitchActive here — but that's async, so the caller
  // checks kill switches separately. This function is synchronous for the
  // config-based checks.)

  // Level 4: Context-level governance — is the action within the agent's goals?
  // The agent's judgment is bounded by goals, memory, and user instructions.
  // This is a soft check — the agent's reasoning is evaluated, not just the action.
  // For now, we check if the action type aligns with any goal keyword.
  if (config.goals.length > 0) {
    const goalKeywords = config.goals.join(" ").toLowerCase();
    const actionLower = input.actionType.toLowerCase();

    // If the action is clearly outside the agent's goals (e.g. a "legal.research" agent
    // trying to "financial.charge"), we flag it.
    const actionDomain = input.actionType.split(".")[0];
    if (actionDomain && !goalKeywords.includes(actionDomain) && !goalKeywords.includes("general")) {
      return {
        allowed: true, // soft check — allowed but flagged.
        level: "context",
        reason: `Action "${input.actionType}" may be outside the agent's goals (${config.goals.join(", ")}). Flagged for review.`,
        prohibited: false,
      };
    }
  }

  // Cross-user data access check.
  if (input.targetUserId && input.targetUserId !== config.wsId) {
    return {
      allowed: false,
      level: "platform",
      reason: "Agents may not access another user's data.",
      prohibited: true, // this is a prohibited action.
    };
  }

  // Cross-workspace check (agents are workspace-scoped).
  if (input.targetWsId && input.targetWsId !== config.wsId) {
    return {
      allowed: false,
      level: "platform",
      reason: "Agents may not access another workspace's data.",
      prohibited: false,
    };
  }

  return {
    allowed: true,
    level: "tool",
    reason: "Action allowed by all governance levels.",
    prohibited: false,
  };
}

// ───────────────────────────────────────────────
// Create a default agent governance config.
// ───────────────────────────────────────────────

export function createDefaultAgentConfig(input: {
  agentId: string;
  wsId: string;
  scopes: string[];
  budgetLimitUsd?: number;
  goals?: string[];
}): AgentGovernanceConfig {
  return {
    agentId: input.agentId,
    wsId: input.wsId,
    scopes: input.scopes,
    budgetLimitUsd: input.budgetLimitUsd ?? 1.0,
    approvalRules: {
      requireApprovalForSideEffects: true,
      requireApprovalForFinancial: true, // always.
      requireApprovalForDestructive: true, // always.
      trustAfterNUses: 5,
    },
    goals: input.goals ?? ["general"],
    memoryScope: "conversation",
    userInstructions: "",
  };
}
