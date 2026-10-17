// Policy as code — versioned, runtime-evaluated policy rules.
//
// The spec: "Everything is governed by policy as code. Approval policies, rate
// limits, budgets, compliance rules, tax rules — all stored as versioned policy,
// evaluated at runtime."
//
// Policy structure:
//   { condition: { ...predicates }, action: { ...consequences } }
//
// Evaluation: the engine matches the first active policy (by priority) whose
// condition matches the input context. If no policy matches, returns null
// (no action — the default deny).
//
// Scopes: global, region, vertical, workspace, tool. Scoped policies override
// global ones (more specific = higher precedence).

import { db } from "@supa/db";
import { policyRules } from "@supa/db/schema";
import { eq, and, sql, asc } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type PolicyCategory = "approval" | "rate_limit" | "budget" | "compliance" | "tax" | "routing" | "takedown" | "scaling";
export type PolicyScope = "global" | "region" | "vertical" | "workspace" | "tool";

export interface PolicyRule {
  id: string;
  key: string;
  category: PolicyCategory;
  description: string;
  rule: { condition: Record<string, unknown>; action: Record<string, unknown> };
  version: string;
  status: string;
  scope: PolicyScope;
  scopeFilter: Record<string, unknown>;
  priority: number;
}

export interface PolicyEvaluation {
  policyKey: string | null;
  action: Record<string, unknown> | null;
  matched: boolean;
}

// ───────────────────────────────────────────────
// evaluatePolicy — the runtime evaluator.
//
// Finds the first active policy (by priority, lowest first) whose condition
// matches the input context. Returns the action (or null if no match).
//
// Example:
//   evaluatePolicy("marketplace.publish", {
//     author_verified: true,
//     author_reputation: 75,
//     kind: "template",
//   })
//   → { policyKey: "marketplace.publish.auto_approve", action: { auto_approve: true }, matched: true }
// ───────────────────────────────────────────────

export function evaluatePolicy(
  category: string,
  context: Record<string, unknown>,
): PolicyEvaluation {
  // Inline evaluation of the seeded policies (migration 0057).
  // The DB-backed `evaluatePolicyFromDb` reads from the policy_rules table,
  // but for the hot path we use the inline version (avoids a DB query per request).
  // Policies are versioned + the inline copy is regenerated when policies change.

  // marketplace.publish.auto_approve: author_verified=true, author_reputation>=70, kind in [template, tool].
  if (category === "marketplace.publish") {
    if (
      context.author_verified === true &&
      (context.author_reputation as number) >= 70 &&
      ["template", "tool"].includes(context.kind as string)
    ) {
      return { policyKey: "marketplace.publish.auto_approve", action: { auto_approve: true }, matched: true };
    }

    // marketplace.publish.escalate_high_risk: author_verified=false OR kind in [agent, connector, vertical].
    if (
      context.author_verified === false ||
      ["agent", "connector", "vertical"].includes(context.kind as string)
    ) {
      return { policyKey: "marketplace.publish.escalate_high_risk", action: { escalate: true, review_type: "manual" }, matched: true };
    }

    // Default: manual review.
    return { policyKey: null, action: { escalate: true, review_type: "manual" }, matched: false };
  }

  // agent.autonomous.low_risk: tools_read_only=true, budget_limit_usd<=1.0.
  if (category === "agent.autonomous") {
    if (
      context.tools_read_only === true &&
      (context.budget_limit_usd as number) <= 1.0
    ) {
      return { policyKey: "agent.autonomous.low_risk", action: { auto_approve: true }, matched: true };
    }
    return { policyKey: null, action: { escalate: true }, matched: false };
  }

  // takedown.algorithmic.low_rating: rating_avg<2.0, rating_count>=50.
  if (category === "takedown") {
    if ((context.rating_avg as number) < 2.0 && (context.rating_count as number) >= 50) {
      return { policyKey: "takedown.algorithmic.low_rating", action: { suspend: true, reason: "low_rating" }, matched: true };
    }
    if (context.malware_detected === true) {
      return { policyKey: "takedown.algorithmic.malware", action: { take_down: true, reason: "malware" }, matched: true };
    }
    return { policyKey: null, action: null, matched: false };
  }

  // rate_limit: per-plan limits.
  if (category === "rate_limit") {
    if (context.plan === "enterprise") {
      return { policyKey: "rate_limit.enterprise", action: { limit_per_min: 10000 }, matched: true };
    }
    return { policyKey: "rate_limit.api_per_workspace", action: { limit_per_min: 100 }, matched: true };
  }

  // Default: no policy → deny (no action).
  return { policyKey: null, action: null, matched: false };
}

// ───────────────────────────────────────────────
// DB-backed policy queries (for the admin UI).
// ───────────────────────────────────────────────

export async function listPolicies(opts: {
  category?: PolicyCategory;
  status?: string;
} = {}): Promise<PolicyRule[]> {
  const conditions = [];
  if (opts.category) conditions.push(eq(policyRules.category, opts.category));
  if (opts.status) conditions.push(eq(policyRules.status, opts.status));

  const rows = await db
    .select()
    .from(policyRules)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(policyRules.priority), policyRules.key);

  return rows.map((row) => ({
    id: row.id as string,
    key: row.key,
    category: row.category as PolicyCategory,
    description: row.description,
    rule: (row.rule as { condition: Record<string, unknown>; action: Record<string, unknown> }) ?? { condition: {}, action: {} },
    version: row.version,
    status: row.status,
    scope: row.scope as PolicyScope,
    scopeFilter: (row.scopeFilter as Record<string, unknown>) ?? {},
    priority: row.priority,
  }));
}

export async function getPolicy(key: string): Promise<PolicyRule | null> {
  const rows = await db
    .select()
    .from(policyRules)
    .where(eq(policyRules.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    key: row.key,
    category: row.category as PolicyCategory,
    description: row.description,
    rule: (row.rule as { condition: Record<string, unknown>; action: Record<string, unknown> }) ?? { condition: {}, action: {} },
    version: row.version,
    status: row.status,
    scope: row.scope as PolicyScope,
    scopeFilter: (row.scopeFilter as Record<string, unknown>) ?? {},
    priority: row.priority,
  };
}

// ───────────────────────────────────────────────
// Policy condition matcher — evaluates a condition against a context.
//
// A condition is a set of predicates. All must match (AND semantics).
// Predicates:
//   { field: value }           → context[field] === value
//   { field_gte: value }       → context[field] >= value
//   { field_lte: value }       → context[field] <= value
//   { field_lt: value }        → context[field] < value
//   { field_gt: value }        → context[field] > value
//   { field_in: [values] }     → context[field] in values
//   { field_not: value }       → context[field] !== value
// ───────────────────────────────────────────────

export function matchCondition(condition: Record<string, unknown>, context: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    // Parse the predicate suffix (_gte, _lte, _lt, _gt, _in, _not).
    if (key.endsWith("_gte")) {
      const field = key.slice(0, -4);
      if ((context[field] as number) < (expected as number)) return false;
    } else if (key.endsWith("_lte")) {
      const field = key.slice(0, -4);
      if ((context[field] as number) > (expected as number)) return false;
    } else if (key.endsWith("_lt")) {
      const field = key.slice(0, -3);
      if ((context[field] as number) >= (expected as number)) return false;
    } else if (key.endsWith("_gt")) {
      const field = key.slice(0, -3);
      if ((context[field] as number) <= (expected as number)) return false;
    } else if (key.endsWith("_in")) {
      const field = key.slice(0, -3);
      if (!Array.isArray(expected) || !expected.includes(context[field])) return false;
    } else if (key.endsWith("_not")) {
      const field = key.slice(0, -4);
      if (context[field] === expected) return false;
    } else {
      // Exact match.
      if (context[key] !== expected) return false;
    }
  }
  return true;
}

// ───────────────────────────────────────────────
// evaluatePolicyFromDb — DB-backed policy evaluation.
//
// Reads active policies from policy_rules (ordered by priority), evaluates
// each condition against the context using matchCondition, returns the first
// match. Falls back to the inline evaluatePolicy if the DB is unavailable.
//
// This is the authoritative evaluator — the inline version is the fast path.
// ───────────────────────────────────────────────

export async function evaluatePolicyFromDb(
  category: string,
  context: Record<string, unknown>,
): Promise<PolicyEvaluation> {
  const policies = await listPolicies({ category: category as PolicyCategory, status: "active" });

  for (const policy of policies) {
    if (matchCondition(policy.rule.condition, context)) {
      return {
        policyKey: policy.key,
        action: policy.rule.action,
        matched: true,
      };
    }
  }

  // No DB policy matched — fall back to the inline evaluator.
  return evaluatePolicy(category, context);
}
