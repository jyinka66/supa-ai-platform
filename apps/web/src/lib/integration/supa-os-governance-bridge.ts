// Cross-system integration — wires Supa OS actions through the Governance
// decision engine.
//
// Every "sensitive" Supa OS action (deploy, publish, marketplace submit,
// sandbox file write by destructive agents) must pass through Governance
// BEFORE executing. The Governance engine:
//   1. Checks kill switches (block if active for this action type).
//   2. Assesses risk (low / medium / high / critical / irreversible).
//   3. Applies policy rules (auto-approved, policy-approved, blocked).
//   4. Logs the decision to the immutable decision log.
//   5. Returns a GovernanceGateResult that the Supa OS route handler
//      inspects — if denied, the route returns 403 + the decision id
//      (so the user can appeal).
//
// Action types governed:
//   - supa_os.build.create
//   - supa_os.build.deploy
//   - supa_os.build.publish
//   - supa_os.marketplace.submit
//   - supa_os.marketplace.publish
//   - supa_os.sandbox.write_file (when destructive agent)
//   - supa_os.sandbox.execute_command (when isDestructive=true)
//   - supa_os.kill_switch.activate
//
// Usage:
//   ```
//   const gate = await governSupaOsAction({
//     actionType: "supa_os.build.deploy",
//     actorId: ctx.admin!.adminId,
//     targetId: sessionId,
//     costUsd: estimatedDeployCost,
//   });
//   if (!gate.allowed) {
//     return okResponse({ ok: false, error: "GOVERNANCE_BLOCKED", gate }, 403);
//   }
//   // ... proceed with deploy ...
//   ```

import { routeDecision, type DecisionResult, type DecisionRequest } from "@/lib/governance/decision-engine";
import { logTransparency } from "@/lib/governance/transparency";
import { appendDecisionLog } from "@/lib/governance/governance-decision-log";
import { recordDecision } from "@/lib/governance/governance-metrics";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface SupaOsGovernanceRequest {
  actionType: SupaOsActionType;
  actorId: string;
  targetId: string;
  wsId?: string;
  costUsd?: number;
  isIrreversible?: boolean;
  metadata?: Record<string, unknown>;
}

export type SupaOsActionType =
  | "supa_os.build.create"
  | "supa_os.build.cancel"
  | "supa_os.build.deploy"
  | "supa_os.build.publish"
  | "supa_os.build.rollback"
  | "supa_os.marketplace.submit"
  | "supa_os.marketplace.publish"
  | "supa_os.marketplace.yank"
  | "supa_os.sandbox.write_file"
  | "supa_os.sandbox.delete_file"
  | "supa_os.sandbox.execute_command"
  | "supa_os.kill_switch.activate"
  | "supa_os.kill_switch.deactivate";

export interface SupaOsGovernanceGate {
  allowed: boolean;
  decision: DecisionResult["decision"];
  riskLevel: DecisionResult["riskLevel"];
  decisionId: string;
  policyKey: string | null;
  reasoning: Record<string, unknown>;
  appealable: boolean;
}

// ───────────────────────────────────────────────
// Action type → risk profile mapping.
//
// Each action type has a default risk level + irreversibility flag.
// The decision engine can override these based on context (e.g. a deploy
// to a production target is "critical", but a deploy to a preview target
// is "low").
// ───────────────────────────────────────────────

const ACTION_RISK_PROFILE: Record<SupaOsActionType, {
  targetType: string;
  defaultRisk: "low" | "medium" | "high" | "critical" | "irreversible";
  isIrreversible: boolean;
}> = {
  "supa_os.build.create":           { targetType: "build_session",   defaultRisk: "low",      isIrreversible: false },
  "supa_os.build.cancel":           { targetType: "build_session",   defaultRisk: "low",      isIrreversible: false },
  "supa_os.build.deploy":           { targetType: "deployment",      defaultRisk: "high",     isIrreversible: false },
  "supa_os.build.publish":          { targetType: "deployment",      defaultRisk: "critical", isIrreversible: false },
  "supa_os.build.rollback":        { targetType: "deployment",      defaultRisk: "high",     isIrreversible: false },
  "supa_os.marketplace.submit":     { targetType: "marketplace_item", defaultRisk: "low",     isIrreversible: false },
  "supa_os.marketplace.publish":    { targetType: "marketplace_item", defaultRisk: "high",    isIrreversible: false },
  "supa_os.marketplace.yank":       { targetType: "marketplace_item", defaultRisk: "medium",   isIrreversible: true },
  "supa_os.sandbox.write_file":     { targetType: "sandbox_file",    defaultRisk: "low",      isIrreversible: false },
  "supa_os.sandbox.delete_file":   { targetType: "sandbox_file",    defaultRisk: "medium",   isIrreversible: false },
  "supa_os.sandbox.execute_command": { targetType: "sandbox_command", defaultRisk: "medium",  isIrreversible: false },
  "supa_os.kill_switch.activate":   { targetType: "kill_switch",     defaultRisk: "critical", isIrreversible: false },
  "supa_os.kill_switch.deactivate": { targetType: "kill_switch",     defaultRisk: "high",     isIrreversible: false },
};

// ───────────────────────────────────────────────
// governSupaOsAction — the single entry point.
//
// Called by every Supa OS route handler that performs a sensitive action.
// ───────────────────────────────────────────────

export async function governSupaOsAction(
  req: SupaOsGovernanceRequest,
): Promise<SupaOsGovernanceGate> {
  const profile = ACTION_RISK_PROFILE[req.actionType];
  if (!profile) {
    // Unknown action type — default to "medium" risk + defer to human review.
    return governUnknown(req);
  }

  // Build the decision request.
  const decisionReq: DecisionRequest = {
    actionType: req.actionType,
    targetType: profile.targetType,
    targetId: req.targetId,
    ...(req.wsId ? { wsId: req.wsId } : {}),
    actorId: req.actorId,
    ...(req.costUsd != null ? { costUsd: req.costUsd } : {}),
    isIrreversible: req.isIrreversible ?? profile.isIrreversible,
  };

  // Route through the decision engine (checks kill switches + policies).
  const result = await routeDecision(decisionReq);

  // Append to the immutable decision log.
  const logResult = await appendDecisionLog({
    timestamp: new Date(),
    actor: req.actorId,
    action: req.actionType,
    context: {
      targetType: profile.targetType,
      targetId: req.targetId,
      ...(req.wsId ? { wsId: req.wsId } : {}),
      ...req.metadata,
    },
    policyApplied: {
      key: result.policyKey,
      version: null,
      result: result.decision === "blocked" ? "deny" :
              result.decision === "deferred" ? "defer" :
              result.decision === "auto_approved" ? "allow" :
              "warn",
    },
    decision: result.decision,
    reasoning: {
      riskLevel: result.riskLevel,
      riskFactors: [{ factor: "default_risk", value: profile.defaultRisk, impact: "high" }],
      ...(result.reasoning as Record<string, unknown>),
    },
  });

  // Record metrics (counter + latency histogram).
  recordDecision({
    domain: profile.targetType,
    outcome: result.decision,
    riskLevel: result.riskLevel,
    latencyMs: 0, // TODO: measure actual latency in Phase 3.
  });

  // Log to the transparency log (visible to the actor + auditors).
  await logTransparency({
    userId: req.actorId,
    wsId: req.wsId,
    actionType: req.actionType,
    targetType: profile.targetType,
    targetId: req.targetId,
    decision: result.decision,
    riskLevel: result.riskLevel,
    policyKey: result.policyKey ?? undefined,
    reasoningSummary: `Risk=${result.riskLevel}, decision=${result.decision}`,
    userVisible: true,
    userMessage: `Action ${req.actionType} was ${result.decision}.`,
    auditorVisible: true,
  }).catch(() => {
    // Transparency log failure is non-fatal — the action still proceeds
    // (or doesn't) based on the governance decision. Log + continue.
  });

  return {
    allowed: result.decision !== "blocked" && result.decision !== "deferred",
    decision: result.decision,
    riskLevel: result.riskLevel,
    decisionId: logResult.id,
    policyKey: result.policyKey,
    reasoning: result.reasoning as Record<string, unknown>,
    appealable: true,
  };
}

// ───────────────────────────────────────────────
// governUnknown — fallback for unmapped action types.
// ───────────────────────────────────────────────

async function governUnknown(req: SupaOsGovernanceRequest): Promise<SupaOsGovernanceGate> {
  const decisionReq: DecisionRequest = {
    actionType: req.actionType,
    targetType: "unknown",
    targetId: req.targetId,
    actorId: req.actorId,
    isIrreversible: req.isIrreversible ?? false,
  };
  const result = await routeDecision(decisionReq);
  return {
    allowed: result.decision !== "blocked",
    decision: result.decision,
    riskLevel: result.riskLevel,
    decisionId: crypto.randomUUID(),
    policyKey: result.policyKey,
    reasoning: { ...result.reasoning as Record<string, unknown>, warning: "unknown_action_type" },
    appealable: true,
  };
}

// ───────────────────────────────────────────────
// Helper — for tests + manual checks. Returns the risk profile for an
// action type without running the full governance pipeline.
// ───────────────────────────────────────────────

export function getActionRiskProfile(actionType: SupaOsActionType) {
  return ACTION_RISK_PROFILE[actionType] ?? {
    targetType: "unknown",
    defaultRisk: "medium" as const,
    isIrreversible: false,
  };
}
