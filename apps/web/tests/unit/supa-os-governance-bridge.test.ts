/**
 * Tests for the Supa OS ↔ Governance integration bridge.
 *
 * Verifies that:
 *   1. Every Supa OS action type has a risk profile (target type + risk level).
 *   2. Risk profiles reflect the expected severity (e.g. deploy = high,
 *      kill_switch.activate = critical, sandbox.write_file = low).
 *   3. governSupaOsAction calls the decision engine + returns a gate.
 *   4. Blocked decisions return allowed=false + a decisionId (for appeal).
 *   5. The transparency log + decision log are called (best-effort).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the governance modules so governSupaOsAction doesn't actually hit
// the DB. We capture calls so we can assert on them.
const routeDecisionMock = vi.fn();
const appendDecisionLogMock = vi.fn();
const logTransparencyMock = vi.fn();
const recordDecisionMock = vi.fn();

vi.mock("@/lib/governance/decision-engine", () => ({
  routeDecision: (...args: unknown[]) => routeDecisionMock(...args),
  assessRisk: vi.fn().mockReturnValue({ riskLevel: "medium", factors: [] }),
}));

vi.mock("@/lib/governance/governance-decision-log", () => ({
  appendDecisionLog: (...args: unknown[]) => appendDecisionLogMock(...args),
}));

vi.mock("@/lib/governance/transparency", () => ({
  logTransparency: (...args: unknown[]) => logTransparencyMock(...args),
}));

vi.mock("@/lib/governance/governance-metrics", () => ({
  recordDecision: (...args: unknown[]) => recordDecisionMock(...args),
}));

import {
  governSupaOsAction,
  getActionRiskProfile,
  type SupaOsActionType,
} from "@/lib/integration/supa-os-governance-bridge";

beforeEach(() => {
  routeDecisionMock.mockReset();
  appendDecisionLogMock.mockReset();
  logTransparencyMock.mockReset();
  recordDecisionMock.mockReset();

  // Defaults — most tests use these.
  routeDecisionMock.mockResolvedValue({
    decision: "auto_approved",
    riskLevel: "medium",
    policyKey: "supa_os.default",
    reasoning: { test: true },
    decisionId: "dec_test_001",
  });
  appendDecisionLogMock.mockResolvedValue({
    id: "log_test_001",
    seq: 1,
    hash: "abc123",
  });
  logTransparencyMock.mockResolvedValue({});
});

// ───────────────────────────────────────────────
// Risk profiles
// ───────────────────────────────────────────────

describe("getActionRiskProfile", () => {
  const cases: Array<{ action: SupaOsActionType; expectedRisk: string; expectedTarget: string }> = [
    { action: "supa_os.build.create",           expectedRisk: "low",      expectedTarget: "build_session" },
    { action: "supa_os.build.cancel",           expectedRisk: "low",      expectedTarget: "build_session" },
    { action: "supa_os.build.deploy",           expectedRisk: "high",     expectedTarget: "deployment" },
    { action: "supa_os.build.publish",          expectedRisk: "critical", expectedTarget: "deployment" },
    { action: "supa_os.build.rollback",         expectedRisk: "high",     expectedTarget: "deployment" },
    { action: "supa_os.marketplace.submit",     expectedRisk: "low",      expectedTarget: "marketplace_item" },
    { action: "supa_os.marketplace.publish",    expectedRisk: "high",     expectedTarget: "marketplace_item" },
    { action: "supa_os.marketplace.yank",       expectedRisk: "medium",   expectedTarget: "marketplace_item" },
    { action: "supa_os.sandbox.write_file",     expectedRisk: "low",      expectedTarget: "sandbox_file" },
    { action: "supa_os.sandbox.delete_file",    expectedRisk: "medium",   expectedTarget: "sandbox_file" },
    { action: "supa_os.sandbox.execute_command", expectedRisk: "medium",  expectedTarget: "sandbox_command" },
    { action: "supa_os.kill_switch.activate",   expectedRisk: "critical", expectedTarget: "kill_switch" },
    { action: "supa_os.kill_switch.deactivate", expectedRisk: "high",     expectedTarget: "kill_switch" },
  ];

  for (const { action, expectedRisk, expectedTarget } of cases) {
    it(`${action} → risk=${expectedRisk}, target=${expectedTarget}`, () => {
      const profile = getActionRiskProfile(action);
      expect(profile.defaultRisk).toBe(expectedRisk);
      expect(profile.targetType).toBe(expectedTarget);
    });
  }

  it("the yank action is irreversible", () => {
    expect(getActionRiskProfile("supa_os.marketplace.yank").isIrreversible).toBe(true);
  });

  it("all other actions are reversible by default", () => {
    const reversible: SupaOsActionType[] = [
      "supa_os.build.create", "supa_os.build.cancel", "supa_os.build.deploy",
      "supa_os.build.publish", "supa_os.build.rollback",
      "supa_os.marketplace.submit", "supa_os.marketplace.publish",
      "supa_os.sandbox.write_file", "supa_os.sandbox.delete_file",
      "supa_os.sandbox.execute_command",
      "supa_os.kill_switch.activate", "supa_os.kill_switch.deactivate",
    ];
    for (const action of reversible) {
      expect(getActionRiskProfile(action).isIrreversible).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────
// governSupaOsAction
// ───────────────────────────────────────────────

describe("governSupaOsAction", () => {
  it("routes through the decision engine + returns an allowed gate for auto_approved", async () => {
    const gate = await governSupaOsAction({
      actionType: "supa_os.build.create",
      actorId: "admin_001",
      targetId: "build_001",
    });

    expect(gate.allowed).toBe(true);
    expect(gate.decision).toBe("auto_approved");
    expect(gate.riskLevel).toBe("medium");
    expect(gate.decisionId).toBe("log_test_001");
    expect(gate.policyKey).toBe("supa_os.default");
    expect(gate.appealable).toBe(true);

    // Verify the decision engine was called with the right action type + target.
    expect(routeDecisionMock).toHaveBeenCalledTimes(1);
    const decisionReq = routeDecisionMock.mock.calls[0]![0];
    expect(decisionReq.actionType).toBe("supa_os.build.create");
    expect(decisionReq.targetType).toBe("build_session");
    expect(decisionReq.targetId).toBe("build_001");
    expect(decisionReq.actorId).toBe("admin_001");
  });

  it("returns allowed=false when the decision is 'blocked'", async () => {
    routeDecisionMock.mockResolvedValue({
      decision: "blocked",
      riskLevel: "critical",
      policyKey: "supa_os.kill_switch.active",
      reasoning: { kill_switch: "active" },
      decisionId: "dec_blocked_001",
    });

    const gate = await governSupaOsAction({
      actionType: "supa_os.build.deploy",
      actorId: "admin_001",
      targetId: "build_001",
    });

    expect(gate.allowed).toBe(false);
    expect(gate.decision).toBe("blocked");
    expect(gate.riskLevel).toBe("critical");
  });

  it("returns allowed=false when the decision is 'deferred' (pending human review)", async () => {
    routeDecisionMock.mockResolvedValue({
      decision: "deferred",
      riskLevel: "high",
      policyKey: "supa_os.human_review_required",
      reasoning: { needs_human_review: true },
      decisionId: "dec_deferred_001",
    });

    const gate = await governSupaOsAction({
      actionType: "supa_os.build.publish",
      actorId: "admin_001",
      targetId: "build_001",
    });

    expect(gate.allowed).toBe(false);
    expect(gate.decision).toBe("deferred");
  });

  it("appends to the immutable decision log with the right shape", async () => {
    await governSupaOsAction({
      actionType: "supa_os.marketplace.publish",
      actorId: "admin_001",
      targetId: "item_001",
      wsId: "00000000-0000-0000-0000-000000000001",
      costUsd: 5.0,
    });

    expect(appendDecisionLogMock).toHaveBeenCalledTimes(1);
    const logEntry = appendDecisionLogMock.mock.calls[0]![0];
    expect(logEntry.actor).toBe("admin_001");
    expect(logEntry.action).toBe("supa_os.marketplace.publish");
    expect(logEntry.context.targetType).toBe("marketplace_item");
    expect(logEntry.context.targetId).toBe("item_001");
    expect(logEntry.decision).toBe("auto_approved");
    expect(logEntry.policyApplied.result).toBe("allow");
  });

  it("records metrics (counter + latency)", async () => {
    await governSupaOsAction({
      actionType: "supa_os.build.deploy",
      actorId: "admin_001",
      targetId: "build_001",
    });

    expect(recordDecisionMock).toHaveBeenCalledTimes(1);
    const metricsInput = recordDecisionMock.mock.calls[0]![0];
    expect(metricsInput.domain).toBe("deployment");
    expect(metricsInput.outcome).toBe("auto_approved");
    expect(metricsInput.riskLevel).toBe("medium");
  });

  it("logs to the transparency log (best-effort — failures don't fail the request)", async () => {
    logTransparencyMock.mockRejectedValue(new Error("transparency log write failed"));

    const gate = await governSupaOsAction({
      actionType: "supa_os.build.deploy",
      actorId: "admin_001",
      targetId: "build_001",
    });

    // The transparency log failed, but the action still proceeds.
    expect(gate.allowed).toBe(true);
    expect(logTransparencyMock).toHaveBeenCalledTimes(1);
  });

  it("passes the cost to the decision engine when provided", async () => {
    await governSupaOsAction({
      actionType: "supa_os.build.deploy",
      actorId: "admin_001",
      targetId: "build_001",
      costUsd: 12.34,
    });

    const decisionReq = routeDecisionMock.mock.calls[0]![0];
    expect(decisionReq.costUsd).toBe(12.34);
  });

  it("marks deploy actions as irreversible when caller confirms", async () => {
    await governSupaOsAction({
      actionType: "supa_os.build.publish",
      actorId: "admin_001",
      targetId: "build_001",
      isIrreversible: true,
    });

    const decisionReq = routeDecisionMock.mock.calls[0]![0];
    expect(decisionReq.isIrreversible).toBe(true);
  });

  it("falls back to governUnknown for unmapped action types", async () => {
    const gate = await governSupaOsAction({
      actionType: "supa_os.unknown.action" as SupaOsActionType,
      actorId: "admin_001",
      targetId: "unknown_001",
    });

    expect(routeDecisionMock).toHaveBeenCalledTimes(1);
    const decisionReq = routeDecisionMock.mock.calls[0]![0];
    expect(decisionReq.targetType).toBe("unknown");
    // The reasoning should include a warning that the action type is unknown.
    expect(gate.reasoning).toHaveProperty("warning", "unknown_action_type");
  });
});
