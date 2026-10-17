// Risk levels and approval flows — Section 5.
//
// The spec: "Every action is classified by risk. The classification determines
// the approval flow."
//
// 5 levels:
//   low          → automatic. Standard logging. Standard rate limits.
//   medium       → policy-check (user-configurable, trust after N). Detailed logging. Tiered rate limits.
//   high         → human approval (delegable within bounds). Full audit. Strict rate limits.
//   critical     → two-person rule + delay window. Full audit + owner notification. Throttled.
//   irreversible → two-person rule + cooling-off period. Full audit + external notification. Executive override to bypass.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical" | "irreversible";
export type ApprovalFlow = "automatic" | "policy_check" | "human_approval" | "two_person_rule" | "two_person_plus_cooling_off";
export type LoggingLevel = "standard" | "detailed" | "full_audit" | "full_audit_plus_notification" | "full_audit_plus_external_notification";
export type RateLimitTier = "standard" | "tiered" | "strict" | "throttled";

export interface RiskLevelSpec {
  level: RiskLevel;
  title: string;
  examples: string[];
  approvalFlow: ApprovalFlow;
  loggingLevel: LoggingLevel;
  rateLimitTier: RateLimitTier;
  delegable: boolean;
  requiresDelay: boolean;
  delayWindowMinutes: number;
  requiresTwoPerson: boolean;
  requiresCoolingOff: boolean;
  coolingOffHours: number;
  notifyOwner: boolean;
  notifyExternal: boolean;
  executiveOverrideAllowed: boolean;
}

// ───────────────────────────────────────────────
// The 5 risk level specifications.
// ───────────────────────────────────────────────

export const RISK_LEVELS: Record<RiskLevel, RiskLevelSpec> = {
  low: {
    level: "low",
    title: "Low Risk",
    examples: ["read-only tools", "search", "format", "translate", "generate draft"],
    approvalFlow: "automatic",
    loggingLevel: "standard",
    rateLimitTier: "standard",
    delegable: false,
    requiresDelay: false,
    delayWindowMinutes: 0,
    requiresTwoPerson: false,
    requiresCoolingOff: false,
    coolingOffHours: 0,
    notifyOwner: false,
    notifyExternal: false,
    executiveOverrideAllowed: false,
  },

  medium: {
    level: "medium",
    title: "Medium Risk",
    examples: ["send email", "post to social", "create invoice", "update customer", "create work item"],
    approvalFlow: "policy_check",
    loggingLevel: "detailed",
    rateLimitTier: "tiered",
    delegable: false,
    requiresDelay: false,
    delayWindowMinutes: 0,
    requiresTwoPerson: false,
    requiresCoolingOff: false,
    coolingOffHours: 0,
    notifyOwner: false,
    notifyExternal: false,
    executiveOverrideAllowed: false,
  },

  high: {
    level: "high",
    title: "High Risk",
    examples: ["charge payment", "refund", "transfer funds", "send bulk email", "deploy to production"],
    approvalFlow: "human_approval",
    loggingLevel: "full_audit",
    rateLimitTier: "strict",
    delegable: true, // can be delegated within strict bounds.
    requiresDelay: false,
    delayWindowMinutes: 0,
    requiresTwoPerson: false,
    requiresCoolingOff: false,
    coolingOffHours: 0,
    notifyOwner: false,
    notifyExternal: false,
    executiveOverrideAllowed: false,
  },

  critical: {
    level: "critical",
    title: "Critical Risk",
    examples: ["delete account", "delete workspace", "revoke credentials", "remove user data", "disable security", "export full workspace"],
    approvalFlow: "two_person_rule",
    loggingLevel: "full_audit_plus_notification",
    rateLimitTier: "throttled",
    delegable: false,
    requiresDelay: true,
    delayWindowMinutes: 5, // 5-minute delay window.
    requiresTwoPerson: true,
    requiresCoolingOff: false,
    coolingOffHours: 0,
    notifyOwner: true, // owner notified.
    notifyExternal: false,
    executiveOverrideAllowed: false,
  },

  irreversible: {
    level: "irreversible",
    title: "Irreversible",
    examples: ["permanent deletion", "public disclosure", "fund transfer out of platform"],
    approvalFlow: "two_person_plus_cooling_off",
    loggingLevel: "full_audit_plus_external_notification",
    rateLimitTier: "throttled",
    delegable: false,
    requiresDelay: true,
    delayWindowMinutes: 60, // 1-hour delay.
    requiresTwoPerson: true,
    requiresCoolingOff: true,
    coolingOffHours: 24, // 24-hour cooling-off period.
    notifyOwner: true,
    notifyExternal: true, // external notification (e.g. compliance team).
    executiveOverrideAllowed: true, // bypass requires executive override, logged + reviewed.
  },
};

// ───────────────────────────────────────────────
// Action classification — map an action to a risk level.
// ───────────────────────────────────────────────

export function classifyAction(actionType: string, input?: {
  isFinancial?: boolean;
  isDestructive?: boolean;
  isIrreversible?: boolean;
  isCrossUser?: boolean;
  costUsd?: number;
}): RiskLevel {
  // Irreversible: explicit flag or known irreversible actions.
  if (input?.isIrreversible) return "irreversible";
  const irreversibleActions = ["permanent.delete", "public.disclose", "fund.transfer.out"];
  if (irreversibleActions.some((a) => actionType.includes(a))) return "irreversible";

  // Critical: known critical actions.
  const criticalActions = ["account.delete", "workspace.delete", "credentials.revoke", "user.data.remove", "security.disable", "workspace.export"];
  if (criticalActions.some((a) => actionType.includes(a))) return "critical";
  if (input?.isDestructive && actionType.includes("delete")) return "critical";

  // High: financial + bulk + deploy.
  const highActions = ["charge", "refund", "transfer.funds", "bulk.email", "deploy.production"];
  if (highActions.some((a) => actionType.includes(a))) return "high";
  if (input?.isFinancial && (input.costUsd ?? 0) > 100) return "high";

  // Medium: side effects.
  const mediumActions = ["email.send", "social.post", "invoice.create", "customer.update", "work.create"];
  if (mediumActions.some((a) => actionType.includes(a))) return "medium";
  if (input?.isFinancial) return "medium"; // financial but low cost.

  // Low: default (read-only, search, format, translate, draft).
  return "low";
}

// ───────────────────────────────────────────────
// Get the risk level specification.
// ───────────────────────────────────────────────

export function getRiskLevelSpec(level: RiskLevel): RiskLevelSpec {
  return RISK_LEVELS[level];
}

// ───────────────────────────────────────────────
// Check if an action can proceed at the given risk level.
// ───────────────────────────────────────────────

export interface RiskCheckResult {
  level: RiskLevel;
  canProceed: boolean;
  approvalRequired: boolean;
  delayRequired: boolean;
  twoPersonRequired: boolean;
  coolingOffRequired: boolean;
  notifyOwner: boolean;
  notifyExternal: boolean;
  reason: string;
}

export function checkRiskLevel(level: RiskLevel, context?: {
  hasDelegation?: boolean;
  hasTwoPersonApproval?: boolean;
  delayElapsed?: boolean;
  coolingOffElapsed?: boolean;
  hasExecutiveOverride?: boolean;
}): RiskCheckResult {
  const spec = RISK_LEVELS[level];

  switch (level) {
    case "low":
      return { level, canProceed: true, approvalRequired: false, delayRequired: false, twoPersonRequired: false, coolingOffRequired: false, notifyOwner: false, notifyExternal: false, reason: "Low risk: automatic approval." };

    case "medium":
      return { level, canProceed: true, approvalRequired: false, delayRequired: false, twoPersonRequired: false, coolingOffRequired: false, notifyOwner: false, notifyExternal: false, reason: "Medium risk: policy check (user-configurable)." };

    case "high": {
      const hasDelegation = context?.hasDelegation ?? false;
      const canProceed = hasDelegation;
      return {
        level,
        canProceed,
        approvalRequired: !hasDelegation,
        delayRequired: false,
        twoPersonRequired: false,
        coolingOffRequired: false,
        notifyOwner: false,
        notifyExternal: false,
        reason: hasDelegation ? "High risk: delegated within bounds." : "High risk: human approval required (or delegation within strict bounds).",
      };
    }

    case "critical": {
      const hasTwoPerson = context?.hasTwoPersonApproval ?? false;
      const delayElapsed = context?.delayElapsed ?? false;
      const canProceed = hasTwoPerson && delayElapsed;
      return {
        level,
        canProceed,
        approvalRequired: true,
        delayRequired: spec.requiresDelay,
        twoPersonRequired: spec.requiresTwoPerson,
        coolingOffRequired: false,
        notifyOwner: spec.notifyOwner,
        notifyExternal: false,
        reason: canProceed
          ? "Critical risk: two-person approval received + delay window elapsed."
          : `Critical risk: two-person rule + ${spec.delayWindowMinutes}min delay window required. ${!hasTwoPerson ? "Awaiting second approver." : "Awaiting delay window."}`,
      };
    }

    case "irreversible": {
      const hasTwoPerson = context?.hasTwoPersonApproval ?? false;
      const coolingOffElapsed = context?.coolingOffElapsed ?? false;
      const hasExecutiveOverride = context?.hasExecutiveOverride ?? false;

      if (hasExecutiveOverride) {
        return {
          level,
          canProceed: true,
          approvalRequired: false, // overridden.
          delayRequired: false,
          twoPersonRequired: false,
          coolingOffRequired: false,
          notifyOwner: spec.notifyOwner,
          notifyExternal: spec.notifyExternal,
          reason: "Irreversible: executive override applied (logged + reviewed).",
        };
      }

      const canProceed = hasTwoPerson && coolingOffElapsed;
      return {
        level,
        canProceed,
        approvalRequired: true,
        delayRequired: spec.requiresDelay,
        twoPersonRequired: spec.requiresTwoPerson,
        coolingOffRequired: spec.requiresCoolingOff,
        notifyOwner: spec.notifyOwner,
        notifyExternal: spec.notifyExternal,
        reason: canProceed
          ? "Irreversible: two-person approval + cooling-off period elapsed."
          : `Irreversible: two-person rule + ${spec.coolingOffHours}h cooling-off period required. ${!hasTwoPerson ? "Awaiting second approver." : `Awaiting ${spec.coolingOffHours}h cooling-off.`}`,
      };
    }
  }
}
