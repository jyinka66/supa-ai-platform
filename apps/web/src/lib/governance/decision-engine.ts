// Governance decision engine — risk-based routing, least privilege, approval scaling.
//
// The spec (Section 2): "Policy as code. Least privilege by default. Approval
// scales with risk. Reputation reduces friction. Everything is logged."
//
// Flow:
//   1. assessRisk(action, target, actor) → risk level (low/medium/high/critical/irreversible).
//   2. routeDecision(risk, policy, delegation) → auto_approved / policy_approved / human_approved / blocked.
//   3. execute + log + transparency.

import { db } from "@supa/db";
import { governanceDecisions } from "@supa/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { evaluatePolicy } from "@/lib/platform/policy-engine";
import { isKillSwitchActive } from "./kill-switches";
import { hasDelegation } from "./delegations";
import { logTransparency } from "./transparency";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical" | "irreversible";
export type GovernanceDecision = "auto_approved" | "policy_approved" | "human_approved" | "blocked" | "deferred";

export interface RiskAssessment {
  level: RiskLevel;
  factors: Array<{ factor: string; value: string; impact: string }>;
}

export interface DecisionRequest {
  actionType: string;       // 'tool.call', 'agent.run', 'marketplace.publish', etc.
  targetType: string;       // 'tool', 'agent', 'template', 'connector', 'region', 'vertical', 'deployment'.
  targetId: string;
  wsId?: string;
  actorId: string;          // user_id, 'system', 'agent:<id>'.
  actorReputation?: number; // 0-100 (developer org reputation).
  costUsd?: number;
  isIrreversible?: boolean;
}

export interface DecisionResult {
  decision: GovernanceDecision;
  riskLevel: RiskLevel;
  policyKey: string | null;
  reasoning: Record<string, unknown>;
  reversible: boolean;
  appealable: boolean;
}

// ───────────────────────────────────────────────
// Risk assessment — classify the action's risk level.
// ───────────────────────────────────────────────

export function assessRisk(req: DecisionRequest): RiskAssessment {
  const factors: Array<{ factor: string; value: string; impact: string }> = [];

  // Irreversible actions.
  if (req.isIrreversible || req.actionType.includes("delete") || req.actionType.includes("purge") || req.actionType.includes("revoke")) {
    factors.push({ factor: "irreversible", value: "true", impact: "Cannot be undone" });
    return { level: "irreversible", factors };
  }

  // Cost-based risk.
  if (req.costUsd != null) {
    if (req.costUsd > 100) {
      factors.push({ factor: "cost", value: `$${req.costUsd}`, impact: "High cost" });
      return { level: "high", factors };
    }
    if (req.costUsd > 10) {
      factors.push({ factor: "cost", value: `$${req.costUsd}`, impact: "Medium cost" });
    } else {
      factors.push({ factor: "cost", value: `$${req.costUsd}`, impact: "Low cost" });
    }
  }

  // Action-type-based risk.
  const highRiskActions = ["marketplace.publish", "enterprise.provision", "region.activate", "vertical.publish", "deployment.upgrade"];
  const mediumRiskActions = ["agent.run", "tool.call", "connector.action", "template.publish"];

  if (highRiskActions.includes(req.actionType)) {
    factors.push({ factor: "action_type", value: req.actionType, impact: "High-risk action" });
    return { level: "high", factors };
  }

  if (mediumRiskActions.includes(req.actionType)) {
    factors.push({ factor: "action_type", value: req.actionType, impact: "Medium-risk action" });

    // Reputation reduces friction: trusted actors → lower risk.
    if (req.actorReputation != null && req.actorReputation >= 70) {
      factors.push({ factor: "reputation", value: String(req.actorReputation), impact: "Trusted actor — reduced friction" });
      return { level: "low", factors };
    }

    return { level: "medium", factors };
  }

  // Default: low risk.
  factors.push({ factor: "action_type", value: req.actionType, impact: "Low-risk action" });
  return { level: "low", factors };
}

// ───────────────────────────────────────────────
// Route decision — based on risk + policy + kill switches + delegations.
//
// Routing logic:
//   irreversible → blocked (unless explicit delegation exists) OR human_approved.
//   critical → human_approved (always).
//   high → policy_approved (if policy matches) OR human_approved.
//   medium → policy_approved (if policy matches) OR human_approved.
//   low → auto_approved (unless kill switch active).
//
// Kill switches override everything: if active → blocked.
// ───────────────────────────────────────────────

export async function routeDecision(req: DecisionRequest): Promise<DecisionResult> {
  // 1. Check kill switches.
  const killSwitchActive = await isKillSwitchActive(req.actionType, req.targetType, req.targetId);
  if (killSwitchActive) {
    return {
      decision: "blocked",
      riskLevel: "irreversible",
      policyKey: null,
      reasoning: { kill_switch: "active", reason: "Kill switch is active for this action" },
      reversible: false,
      appealable: true,
    };
  }

  // 2. Assess risk.
  const risk = assessRisk(req);

  // 3. Route based on risk level.
  let decision: GovernanceDecision;
  let policyKey: string | null = null;
  const reasoning: Record<string, unknown> = { risk_factors: risk.factors };

  switch (risk.level) {
    case "irreversible": {
      // Check for explicit delegation.
      const delegated = await hasDelegation(req.actionType, req.targetType, req.actorId);
      if (delegated) {
        decision = "policy_approved";
        policyKey = "delegation.explicit";
        reasoning.delegation = "explicit_delegation_exists";
      } else {
        decision = "human_approved"; // requires human approval.
        reasoning.reason = "irreversible_action_requires_human_approval";
      }
      break;
    }

    case "critical":
      decision = "human_approved";
      reasoning.reason = "critical_risk_requires_human_approval";
      break;

    case "high": {
      // Evaluate policy.
      const policyResult = evaluatePolicy(req.actionType, {
        actor_reputation: req.actorReputation ?? 50,
        cost: req.costUsd ?? 0,
        action: req.actionType,
      });
      if (policyResult.matched) {
        decision = "policy_approved";
        policyKey = policyResult.policyKey;
        reasoning.policy = policyResult.action;
      } else {
        decision = "human_approved";
        reasoning.reason = "high_risk_no_matching_policy";
      }
      break;
    }

    case "medium": {
      const policyResult = evaluatePolicy(req.actionType, {
        actor_reputation: req.actorReputation ?? 50,
        cost: req.costUsd ?? 0,
      });
      if (policyResult.matched) {
        decision = "policy_approved";
        policyKey = policyResult.policyKey;
        reasoning.policy = policyResult.action;
      } else {
        decision = "human_approved";
        reasoning.reason = "medium_risk_no_matching_policy";
      }
      break;
    }

    case "low":
    default:
      decision = "auto_approved";
      reasoning.reason = "low_risk_auto_approved";
      break;
  }

  // 4. Reversibility.
  const reversible = risk.level !== "irreversible" && !req.isIrreversible;

  // 5. Appealable (all decisions are appealable unless explicitly irreversible).
  const appealable = risk.level !== "irreversible";

  return { decision, riskLevel: risk.level, policyKey, reasoning, reversible, appealable };
}

// ───────────────────────────────────────────────
// Execute decision — log + transparency.
// ───────────────────────────────────────────────

export async function executeDecision(
  req: DecisionRequest,
  result: DecisionResult,
): Promise<{ decisionId: string; decision: GovernanceDecision }> {
  // Log the decision.
  const rows = await db.insert(governanceDecisions).values({
    actionType: req.actionType,
    targetType: req.targetType,
    targetId: req.targetId,
    ...(req.wsId ? { workspaceId: req.wsId as any } : {}),
    actorId: req.actorId,
    riskLevel: result.riskLevel,
    decision: result.decision,
    ...(result.policyKey ? { policyKey: result.policyKey } : {}),
    reasoning: result.reasoning,
    reversible: result.reversible,
    appealable: result.appealable,
  }).returning({ id: governanceDecisions.id });

  const decisionId = rows[0]?.id as string;

  // Log transparency (user-facing + auditor-facing).
  await logTransparency({
    ...(req.wsId ? { wsId: req.wsId } : {}),
    actionType: req.actionType,
    targetType: req.targetType,
    targetId: req.targetId,
    decision: result.decision,
    riskLevel: result.riskLevel,
    ...(result.policyKey ? { policyKey: result.policyKey } : {}),
    reasoningSummary: summarizeReasoning(result),
    userVisible: result.decision !== "blocked",
    userMessage: getUserMessage(result, req),
    auditorVisible: result.riskLevel === "high" || result.riskLevel === "critical" || result.riskLevel === "irreversible",
    auditorEvidence: { riskLevel: result.riskLevel, decision: result.decision, policyKey: result.policyKey },
  });

  return { decisionId, decision: result.decision };
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function summarizeReasoning(result: DecisionResult): string {
  const reasoning = result.reasoning;
  const factors = reasoning.risk_factors as Array<{ factor: string; impact: string }> | undefined;
  const factorStr = factors?.map((f) => `${f.factor}: ${f.impact}`).join("; ") ?? "none";
  return `Risk: ${result.riskLevel}. Decision: ${result.decision}. Factors: ${factorStr}. Policy: ${result.policyKey ?? "none"}.`;
}

function getUserMessage(result: DecisionResult, req: DecisionRequest): string {
  switch (result.decision) {
    case "auto_approved":
      return `Action "${req.actionType}" on ${req.targetType} "${req.targetId}" was automatically approved (low risk).`;
    case "policy_approved":
      return `Action "${req.actionType}" on ${req.targetType} "${req.targetId}" was approved by policy "${result.policyKey}".`;
    case "human_approved":
      return `Action "${req.actionType}" on ${req.targetType} "${req.targetId}" requires human review (risk: ${result.riskLevel}).`;
    case "blocked":
      return `Action "${req.actionType}" on ${req.targetType} "${req.targetId}" was blocked (kill switch active or irreversible without delegation).`;
    case "deferred":
      return `Action "${req.actionType}" on ${req.targetType} "${req.targetId}" was deferred.`;
  }
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getDecision(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(governanceDecisions).where(eq(governanceDecisions.id, id as any)).limit(1);
  return rows[0] as Record<string, unknown> | null ?? null;
}

export async function listDecisions(opts: {
  targetType?: string;
  riskLevel?: RiskLevel;
  decision?: GovernanceDecision;
  wsId?: string;
  limit?: number;
} = {}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const conditions = [];
  if (opts.targetType) conditions.push(eq(governanceDecisions.targetType, opts.targetType));
  if (opts.riskLevel) conditions.push(eq(governanceDecisions.riskLevel, opts.riskLevel));
  if (opts.decision) conditions.push(eq(governanceDecisions.decision, opts.decision));
  if (opts.wsId) conditions.push(eq(governanceDecisions.workspaceId, opts.wsId as any));

  const rows = await db.select().from(governanceDecisions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(governanceDecisions.decidedAt))
    .limit(limit);

  return rows as unknown as Array<Record<string, unknown>>;
}

// ───────────────────────────────────────────────
// Reverse a decision (if reversible).
// ───────────────────────────────────────────────

export async function reverseDecision(decisionId: string, reversedBy: string, reason: string): Promise<void> {
  const result = await db.execute(sql`
    update governance_decisions
       set reversed_at = now(), reversed_by = ${reversedBy}
     where id = ${decisionId}::uuid and reversible = true and reversed_at is null
    returning id
  `);
  if ((result as unknown as Array<{ id: string }>).length === 0) {
    throw new Error("decision_not_found_or_not_reversible");
  }
}

// ───────────────────────────────────────────────
// Appeal a decision (if appealable).
// ───────────────────────────────────────────────

export async function appealDecision(decisionId: string): Promise<void> {
  const result = await db.execute(sql`
    update governance_decisions
       set appealed_at = now(), appeal_status = 'pending'
     where id = ${decisionId}::uuid and appealable = true and appealed_at is null
    returning id
  `);
  if ((result as unknown as Array<{ id: string }>).length === 0) {
    throw new Error("decision_not_found_or_not_appealable");
  }
}
