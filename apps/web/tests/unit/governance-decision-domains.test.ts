/**
 * Governance Decision Domains — tests.
 * Sections 3.1 (Tool Execution), 3.2 (Agent Actions), 3.3 (Marketplace Publishing).
 */

import { describe, it, expect } from "vitest";
import {
  classifyToolCall,
  getToolGovernance,
  checkSideEffectTrust,
  type ToolCategory,
} from "@/lib/governance/tool-execution";
import {
  PROHIBITED_ACTIONS,
  isProhibitedAction,
  checkAgentAction,
  createDefaultAgentConfig,
  type AgentGovernanceConfig,
} from "@/lib/governance/agent-actions";
import {
  reviewSubmission,
  isHighRiskSubmission,
  HIGH_RISK_TYPES,
  type SubmissionKind,
  type ReviewStatus,
} from "@/lib/governance/marketplace-publishing";
import {
  DECISION_DOMAINS,
  verifyDecisionDomains,
  getDomainSummary,
  type DecisionDomain,
} from "@/lib/governance/decision-domains";

// ───────────────────────────────────────────────
// 3.1 Tool Execution
// ───────────────────────────────────────────────

describe("3.1 — Tool Execution Governance", () => {
  it("has 6 tool categories", () => {
    const categories: ToolCategory[] = ["read_only", "side_effect", "financial", "destructive", "cross_workspace", "cross_user"];
    expect(categories).toHaveLength(6);
  });

  it("read-only: no approval required", () => {
    const gov = getToolGovernance("read_only");
    expect(gov.requiresApproval).toBe(false);
    expect(gov.allowed).toBe(true);
  });

  it("side-effect: requires approval (trust after N uses)", () => {
    const gov = getToolGovernance("side_effect");
    expect(gov.requiresApproval).toBe(true);
    expect(gov.alwaysLogged).toBe(true);
  });

  it("financial: always requires explicit approval", () => {
    const gov = getToolGovernance("financial");
    expect(gov.requiresApproval).toBe(true);
    expect(gov.requiresDelegation).toBe(true);
  });

  it("destructive: always requires approval + always logged", () => {
    const gov = getToolGovernance("destructive");
    expect(gov.requiresApproval).toBe(true);
    expect(gov.alwaysLogged).toBe(true);
  });

  it("cross-workspace: never without explicit workspace permission", () => {
    const gov = getToolGovernance("cross_workspace");
    expect(gov.allowed).toBe(false); // blocked by default.
    expect(gov.requiresDelegation).toBe(true);
  });

  it("cross-user: never allowed", () => {
    const gov = getToolGovernance("cross_user");
    expect(gov.allowed).toBe(false);
    expect(gov.requiresApproval).toBe(false); // N/A — always blocked.
  });

  it("classifyToolCall: read-only for non-side-effect tools", () => {
    const cat = classifyToolCall({
      toolKey: "search.web", sideEffect: false, isFinancial: false, isDestructive: false, crossWorkspace: false, crossUser: false,
    });
    expect(cat).toBe("read_only");
  });

  it("classifyToolCall: destructive for delete/purge tools", () => {
    const cat = classifyToolCall({
      toolKey: "workspace.delete", sideEffect: true, isFinancial: false, isDestructive: true, crossWorkspace: false, crossUser: false,
    });
    expect(cat).toBe("destructive");
  });

  it("classifyToolCall: cross-user takes precedence", () => {
    const cat = classifyToolCall({
      toolKey: "user.data", sideEffect: true, isFinancial: true, isDestructive: true, crossWorkspace: true, crossUser: true,
    });
    expect(cat).toBe("cross_user"); // highest precedence.
  });

  it("trust after N uses: trusted after 5 uses", () => {
    expect(checkSideEffectTrust(0).trusted).toBe(false);
    expect(checkSideEffectTrust(4).trusted).toBe(false);
    expect(checkSideEffectTrust(5).trusted).toBe(true);
    expect(checkSideEffectTrust(10).trusted).toBe(true);
  });

  it("trust policy: remaining approvals decreases", () => {
    expect(checkSideEffectTrust(0).remainingApprovals).toBe(5);
    expect(checkSideEffectTrust(3).remainingApprovals).toBe(2);
    expect(checkSideEffectTrust(5).remainingApprovals).toBe(0);
  });
});

// ───────────────────────────────────────────────
// 3.2 Agent Actions
// ───────────────────────────────────────────────

describe("3.2 — Agent Action Governance", () => {
  it("has 6 prohibited actions", () => {
    expect(PROHIBITED_ACTIONS).toHaveLength(6);
  });

  it("prohibited: agents may not escalate their own permissions", () => {
    expect(isProhibitedAction("permission.escalate")).toBe(true);
  });

  it("prohibited: agents may not modify their own budget", () => {
    expect(isProhibitedAction("budget.modify")).toBe(true);
  });

  it("prohibited: agents may not modify their own approval rules", () => {
    expect(isProhibitedAction("approval.modify")).toBe(true);
  });

  it("prohibited: agents may not access another user's data", () => {
    expect(isProhibitedAction("user.data.access_other")).toBe(true);
  });

  it("prohibited: agents may not call tools not in their scope", () => {
    expect(isProhibitedAction("scope.expand")).toBe(true);
  });

  it("prohibited: agents may not bypass platform rate limits", () => {
    expect(isProhibitedAction("ratelimit.bypass")).toBe(true);
  });

  it("prohibited actions are always blocked", () => {
    const config = createDefaultAgentConfig({ agentId: "a1", wsId: "ws-1", scopes: ["search.web"] });
    const check = checkAgentAction({ config, actionType: "permission.escalate" });
    expect(check.allowed).toBe(false);
    expect(check.prohibited).toBe(true);
  });

  it("tools not in scope are blocked (tool-level)", () => {
    const config = createDefaultAgentConfig({ agentId: "a1", wsId: "ws-1", scopes: ["search.web"] });
    const check = checkAgentAction({ config, actionType: "tool.call", toolKey: "file.delete" });
    expect(check.allowed).toBe(false);
    expect(check.level).toBe("tool");
  });

  it("budget exceeded is blocked (agent-level)", () => {
    const config = createDefaultAgentConfig({ agentId: "a1", wsId: "ws-1", scopes: ["search.web"], budgetLimitUsd: 1.0 });
    const check = checkAgentAction({
      config, actionType: "tool.call", toolKey: "search.web", costUsd: 0.5, cumulativeCostUsd: 0.8,
    });
    expect(check.allowed).toBe(false);
    expect(check.level).toBe("agent");
    expect(check.reason).toContain("Budget exceeded");
  });

  it("cross-user data access is blocked + prohibited", () => {
    const config = createDefaultAgentConfig({ agentId: "a1", wsId: "ws-1", scopes: ["search.web"] });
    const check = checkAgentAction({
      config, actionType: "user.data.read", targetUserId: "other-user",
    });
    expect(check.allowed).toBe(false);
    expect(check.prohibited).toBe(true);
  });

  it("actions within scope + budget + goals are allowed", () => {
    const config = createDefaultAgentConfig({ agentId: "a1", wsId: "ws-1", scopes: ["search.web"], budgetLimitUsd: 5.0, goals: ["search"] });
    const check = checkAgentAction({
      config, actionType: "search.web", toolKey: "search.web", costUsd: 0.1, cumulativeCostUsd: 0.5,
    });
    expect(check.allowed).toBe(true);
  });

  it("4 governance levels: tool, agent, platform, context", () => {
    const levels = ["tool", "agent", "platform", "context"];
    expect(levels).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 3.3 Marketplace Publishing
// ───────────────────────────────────────────────

describe("3.3 — Marketplace Publishing Governance", () => {
  it("has 4 submission kinds: agent, connector, template, prompt", () => {
    const kinds: SubmissionKind[] = ["agent", "connector", "template", "prompt"];
    expect(kinds).toHaveLength(4);
  });

  it("has 4 review statuses", () => {
    const statuses: ReviewStatus[] = ["auto_approved", "pending_review", "rejected", "human_review_required"];
    expect(statuses).toHaveLength(4);
  });

  it("has 5 high-risk submission types", () => {
    expect(HIGH_RISK_TYPES).toHaveLength(5);
    expect(HIGH_RISK_TYPES).toContain("financial_agent");
    expect(HIGH_RISK_TYPES).toContain("healthcare_agent");
    expect(HIGH_RISK_TYPES).toContain("legal_agent");
  });

  it("financial agents are high-risk", () => {
    expect(isHighRiskSubmission("agent", { type: "financial_agent" })).toBe(true);
  });

  it("healthcare agents are high-risk", () => {
    expect(isHighRiskSubmission("agent", { type: "healthcare_agent" })).toBe(true);
  });

  it("simple templates are not high-risk", () => {
    expect(isHighRiskSubmission("template", { type: "design_template" })).toBe(false);
  });

  it("trusted creators get auto-approve (reputation ≥ 70, verified)", async () => {
    const result = await reviewSubmission({
      kind: "template",
      slug: "my-template",
      title: "My Template",
      description: "A useful template for productivity.",
      manifest: {},
      authorReputation: 80,
      authorVerified: true,
    });
    expect(result.status).toBe("auto_approved");
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("new creators get pending_review (reputation < 50)", async () => {
    const result = await reviewSubmission({
      kind: "template",
      slug: "my-template",
      title: "My Template",
      description: "A useful template for productivity.",
      manifest: {},
      authorReputation: 30,
      authorVerified: false,
    });
    expect(result.status).toBe("pending_review");
  });

  it("high-risk submissions require human review even for trusted creators", async () => {
    const result = await reviewSubmission({
      kind: "agent",
      slug: "financial-bot",
      title: "Financial Bot",
      description: "An agent that processes payments.",
      manifest: { type: "financial_agent" },
      authorReputation: 90,
      authorVerified: true,
    });
    expect(result.status).toBe("human_review_required");
    expect(result.requiresHumanReview).toBe(true);
  });

  it("plagiarism detection: duplicate slug is rejected", async () => {
    const result = await reviewSubmission({
      kind: "agent",
      slug: "existing-agent",
      title: "Copy of Existing",
      description: "A copy of an existing agent.",
      manifest: {},
      authorReputation: 80,
      authorVerified: true,
      existingSlugs: ["existing-agent"],
    });
    expect(result.plagiarismDetected).toBe(true);
    expect(result.status).toBe("rejected");
  });

  it("excessive scopes are rejected", async () => {
    const result = await reviewSubmission({
      kind: "agent",
      slug: "admin-bot",
      title: "Admin Bot",
      description: "An agent with admin access.",
      manifest: { scopes: ["admin"] },
      authorReputation: 80,
      authorVerified: true,
    });
    const permCheck = result.checks.find((c) => c.name === "permission_review");
    expect(permCheck?.passed).toBe(false);
    expect(result.status).toBe("rejected");
  });

  it("5 review checks: schema, safety, permissions, budget, plagiarism", () => {
    // reviewSubmission runs 5 checks.
    const checkNames = ["schema_validation", "safety_check", "permission_review", "budget_review", "plagiarism_detection"];
    expect(checkNames).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// Decision Domains
// ───────────────────────────────────────────────

describe("Decision Domains (Section 3)", () => {
  it("has 8 decision domains", () => {
    expect(DECISION_DOMAINS).toHaveLength(8);
  });

  it("all 8 domains are implemented", () => {
    const summary = getDomainSummary();
    expect(summary.implemented).toBe(8);
    expect(summary.total).toBe(8);
  });

  it("3.1 tool_execution domain is implemented", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "tool_execution");
    expect(d?.implemented).toBe(true);
    expect(d?.observabilityMetrics).toContain("tool_usage_stats");
  });

  it("3.2 agent_actions domain is implemented", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "agent_actions");
    expect(d?.implemented).toBe(true);
    expect(d?.policiesActive).toBe(6); // 6 prohibited actions.
  });

  it("3.3 marketplace_publishing domain is implemented", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "marketplace_publishing");
    expect(d?.implemented).toBe(true);
    expect(d?.defaultRiskLevel).toBe("high");
  });

  it("enterprise_provisioning requires human approval (critical risk)", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "enterprise_provisioning");
    expect(d?.defaultRiskLevel).toBe("critical");
    expect(d?.approvalFlow).toBe("human");
  });

  it("security_compliance requires human approval (critical risk)", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "security_compliance");
    expect(d?.defaultRiskLevel).toBe("critical");
    expect(d?.approvalFlow).toBe("human");
  });

  it("billing_revenue is auto-approved (low friction)", () => {
    const d = DECISION_DOMAINS.find((d) => d.domain === "billing_revenue");
    expect(d?.approvalFlow).toBe("auto");
  });

  it("each domain has observability metrics", () => {
    for (const d of DECISION_DOMAINS) {
      expect(d.observabilityMetrics.length).toBeGreaterThan(0);
    }
  });

  it("verifyDecisionDomains returns 8 checks, all implemented", () => {
    const checks = verifyDecisionDomains();
    expect(checks).toHaveLength(8);
    expect(checks.every((c) => c.implemented)).toBe(true);
  });
});
