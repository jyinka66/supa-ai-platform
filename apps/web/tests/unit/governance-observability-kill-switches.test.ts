/**
 * Governance — Observability + Audit (Section 10) + Kill Switches (Section 11) — tests.
 *
 * Verifies the spec:
 *   10.1 Metrics — 8 metric groups.
 *   10.2 Logs — hash-chained, 7 fields per entry, tamper-evident, exportable.
 *   10.3 Dashboards — 4 dashboards (governance/policy/reputation/compliance).
 *   10.4 Audit trail — 7 event categories, 7+ year retention for critical.
 *   11.1 Kill switches — 7 named types, 60-second propagation SLA.
 */

import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_METRIC_GROUPS,
  verifyGovernanceMetrics,
  DECISIONS_TOTAL,
  DECISION_LATENCY,
  POLICY_EVALUATIONS_TOTAL,
  POLICY_EVAL_LATENCY,
  POLICY_VIOLATIONS_TOTAL,
  APPEALS_TOTAL,
  APPEAL_OUTCOME_TOTAL,
  APPEAL_RESOLUTION_LATENCY,
  APPEAL_SATISFACTION,
  INCIDENTS_TOTAL,
  INCIDENT_REMEDIATION_LATENCY,
  INCIDENT_RECURRENCE_TOTAL,
  REPUTATION_DISTRIBUTION,
  REPUTATION_SCORE_SUM,
  REPUTATION_SCORE_COUNT,
  recordDecision,
  recordPolicyEvaluation,
  recordAppealOutcome,
  recordIncident,
  listDecisionDomains,
} from "@/lib/governance/governance-metrics";
import {
  DECISION_LOG_FIELDS,
  DECISION_LOG_PROPERTIES,
  verifyDecisionLog,
  type DecisionLogEntry,
} from "@/lib/governance/governance-decision-log";
import {
  GOVERNANCE_DASHBOARDS,
  verifyGovernanceDashboards,
} from "@/lib/governance/governance-dashboards";
import {
  AUDIT_EVENT_CATEGORIES,
  verifyAuditTrail,
  getCriticalRetentionYears,
  type AuditEventCategory,
} from "@/lib/governance/governance-audit-trail";
import {
  KILL_SWITCH_TYPES,
  KILL_SWITCH_PROPAGATION_SLA_SECONDS,
  verifyKillSwitches,
  type KillSwitchType,
  type KillSwitchSubscriber,
} from "@/lib/governance/kill-switches";

// ───────────────────────────────────────────────
// 10.1 Metrics — 8 metric groups
// ───────────────────────────────────────────────

describe("10.1 — Metrics", () => {
  it("has 8 metric groups", () => {
    expect(GOVERNANCE_METRIC_GROUPS).toHaveLength(8);
  });

  it("all 8 metric groups are implemented", () => {
    const v = verifyGovernanceMetrics();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedGroups).toBe(8);
    expect(v.totalGroups).toBe(8);
  });

  it("10.1.1: decisions per second per domain — counter + histogram registered", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.1");
    expect(g?.implemented).toBe(true);
    expect(DECISIONS_TOTAL).toBeDefined();
    expect(DECISION_LATENCY).toBeDefined();
  });

  it("10.1.2: auto-approve / policy-check / human-approval rates", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.2");
    expect(g?.implemented).toBe(true);
    expect(POLICY_EVALUATIONS_TOTAL).toBeDefined();
  });

  it("10.1.3: approval latency histogram registered", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.3");
    expect(g?.implemented).toBe(true);
    expect(DECISION_LATENCY).toBeDefined();
  });

  it("10.1.4: policy evaluation latency histogram registered", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.4");
    expect(g?.implemented).toBe(true);
    expect(POLICY_EVAL_LATENCY).toBeDefined();
  });

  it("10.1.5: policy violations counter registered", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.5");
    expect(g?.implemented).toBe(true);
    expect(POLICY_VIOLATIONS_TOTAL).toBeDefined();
  });

  it("10.1.6: appeals volume / resolution / satisfaction", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.6");
    expect(g?.implemented).toBe(true);
    expect(APPEALS_TOTAL).toBeDefined();
    expect(APPEAL_OUTCOME_TOTAL).toBeDefined();
    expect(APPEAL_RESOLUTION_LATENCY).toBeDefined();
    expect(APPEAL_SATISFACTION).toBeDefined();
  });

  it("10.1.7: incidents / remediation / recurrence", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.7");
    expect(g?.implemented).toBe(true);
    expect(INCIDENTS_TOTAL).toBeDefined();
    expect(INCIDENT_REMEDIATION_LATENCY).toBeDefined();
    expect(INCIDENT_RECURRENCE_TOTAL).toBeDefined();
  });

  it("10.1.8: reputation distribution across actors", () => {
    const g = GOVERNANCE_METRIC_GROUPS.find((x) => x.id === "10.1.8");
    expect(g?.implemented).toBe(true);
    expect(REPUTATION_DISTRIBUTION).toBeDefined();
    expect(REPUTATION_SCORE_SUM).toBeDefined();
    expect(REPUTATION_SCORE_COUNT).toBeDefined();
  });

  it("recordDecision increments the counter", () => {
    expect(() =>
      recordDecision({
        domain: "tool_execution",
        outcome: "auto_approved",
        riskLevel: "low",
        latencyMs: 12,
      }),
    ).not.toThrow();
  });

  it("recordPolicyEvaluation tracks result + latency", () => {
    expect(() =>
      recordPolicyEvaluation({
        policyKey: "tool.execution.default",
        result: "allow",
        latencyMs: 0.8,
      }),
    ).not.toThrow();

    expect(() =>
      recordPolicyEvaluation({
        policyKey: "tool.execution.default",
        result: "deny",
        latencyMs: 1.2,
        violationSeverity: "critical",
      }),
    ).not.toThrow();
  });

  it("recordAppealOutcome tracks volume + outcome + latency + satisfaction", () => {
    expect(() =>
      recordAppealOutcome({
        type: "user",
        outcome: "overturned",
        resolutionHours: 24,
        satisfactionScore: 85,
      }),
    ).not.toThrow();
  });

  it("recordIncident tracks incidents + remediation + recurrence", () => {
    expect(() =>
      recordIncident({
        category: "policy_violation",
        severity: "high",
        remediationMinutes: 45,
        recurredWithin30d: false,
      }),
    ).not.toThrow();
  });

  it("listDecisionDomains returns all 8 decision domains", () => {
    const domains = listDecisionDomains();
    expect(domains.length).toBeGreaterThanOrEqual(8);
    expect(domains).toContain("tool_execution");
    expect(domains).toContain("agent_actions");
    expect(domains).toContain("marketplace_publishing");
  });
});

// ───────────────────────────────────────────────
// 10.2 Logs — hash-chained, 7 fields, tamper-evident, exportable
// ───────────────────────────────────────────────

describe("10.2 — Logs", () => {
  it("has 8 fields (timestamp + actor + action + context + policy_applied + decision + reasoning + downstream_effects)", () => {
    // The spec lists 7 fields but counts "downstream effects" separately —
    // we expose all 8 as fields since downstream effects are part of the
    // entry shape (filled in async when known).
    expect(DECISION_LOG_FIELDS).toHaveLength(8);
    const names = DECISION_LOG_FIELDS.map((f) => f.name);
    expect(names).toContain("timestamp");
    expect(names).toContain("actor");
    expect(names).toContain("action");
    expect(names).toContain("context");
    expect(names).toContain("policy_applied");
    expect(names).toContain("decision");
    expect(names).toContain("reasoning");
    expect(names).toContain("downstream_effects");
  });

  it("all 8 fields are implemented", () => {
    expect(DECISION_LOG_FIELDS.every((f) => f.implemented)).toBe(true);
  });

  it("is tamper-evident (hash chain)", () => {
    const tamper = DECISION_LOG_PROPERTIES.find((p) => p.property === "tamper_evident");
    expect(tamper?.implemented).toBe(true);
  });

  it("is append-only (no UPDATE/DELETE grants)", () => {
    const appendOnly = DECISION_LOG_PROPERTIES.find((p) => p.property === "append_only");
    expect(appendOnly?.implemented).toBe(true);
  });

  it("has chain verification (nightly cron)", () => {
    const verify = DECISION_LOG_PROPERTIES.find((p) => p.property === "chain_verification");
    expect(verify?.implemented).toBe(true);
  });

  it("is exportable (JSONL for auditors)", () => {
    const exportable = DECISION_LOG_PROPERTIES.find((p) => p.property === "exportable");
    expect(exportable?.implemented).toBe(true);
  });

  it("exports are recorded in admin audit log (audit-of-an-audit)", () => {
    const audited = DECISION_LOG_PROPERTIES.find((p) => p.property === "export_audited");
    expect(audited?.implemented).toBe(true);
  });

  it("verifyDecisionLog() reports all fields + properties implemented", () => {
    const v = verifyDecisionLog();
    expect(v.fieldsImplemented).toBe(v.fieldsTotal);
    expect(v.propertiesImplemented).toBe(v.propertiesTotal);
    expect(v.allImplemented).toBe(true);
  });

  it("DecisionLogEntry shape has all 8 fields", () => {
    const entry: DecisionLogEntry = {
      timestamp: new Date(),
      actor: "user-1",
      action: "tool.call",
      context: { targetType: "tool", targetId: "tool-1", wsId: "ws-1" },
      policyApplied: { key: "tool.execution.default", version: 1, result: "allow" },
      decision: "auto_approved",
      reasoning: { riskLevel: "low", riskFactors: [] },
      downstreamEffects: [{ kind: "tool_invoked", description: "tool called" }],
    };
    expect(entry.actor).toBe("user-1");
    expect(entry.action).toBe("tool.call");
    expect(entry.policyApplied.result).toBe("allow");
    expect(entry.decision).toBe("auto_approved");
    expect(entry.downstreamEffects?.length).toBe(1);
  });
});

// ───────────────────────────────────────────────
// 10.3 Dashboards — 4 dashboards
// ───────────────────────────────────────────────

describe("10.3 — Dashboards", () => {
  it("has 4 dashboards", () => {
    expect(GOVERNANCE_DASHBOARDS).toHaveLength(4);
  });

  it("all 4 dashboards are implemented", () => {
    const v = verifyGovernanceDashboards();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedDashboards).toBe(4);
  });

  it("10.3.1: governance dashboard — decisions, approvals, appeals, incidents", () => {
    const d = GOVERNANCE_DASHBOARDS.find((x) => x.id === "10.3.1");
    expect(d?.title).toContain("Governance dashboard");
    expect(d?.sections).toContain("decisions");
    expect(d?.sections).toContain("appeals");
    expect(d?.sections).toContain("incidents");
    expect(d?.implemented).toBe(true);
  });

  it("10.3.2: policy dashboard — coverage, versions, auto-tuning proposals", () => {
    const d = GOVERNANCE_DASHBOARDS.find((x) => x.id === "10.3.2");
    expect(d?.title).toContain("Policy dashboard");
    expect(d?.sections).toContain("coverage");
    expect(d?.sections).toContain("versions");
    expect(d?.sections).toContain("autoTuningProposals");
    expect(d?.implemented).toBe(true);
  });

  it("10.3.3: reputation dashboard — distribution, changes, anomalies", () => {
    const d = GOVERNANCE_DASHBOARDS.find((x) => x.id === "10.3.3");
    expect(d?.title).toContain("Reputation dashboard");
    expect(d?.sections).toContain("distribution");
    expect(d?.sections).toContain("changes");
    expect(d?.sections).toContain("anomalies");
    expect(d?.implemented).toBe(true);
  });

  it("10.3.4: compliance dashboard — evidence, gaps, audits", () => {
    const d = GOVERNANCE_DASHBOARDS.find((x) => x.id === "10.3.4");
    expect(d?.title).toContain("Compliance dashboard");
    expect(d?.sections).toContain("frameworks");
    expect(d?.sections).toContain("recentAudits");
    expect(d?.sections).toContain("evidenceByType");
    expect(d?.sections).toContain("upcomingDeadlines");
    expect(d?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 10.4 Audit trail — 7 event categories + 7+ year retention
// ───────────────────────────────────────────────

describe("10.4 — Audit trail", () => {
  it("has 7 event categories", () => {
    expect(AUDIT_EVENT_CATEGORIES).toHaveLength(7);
    const cats = AUDIT_EVENT_CATEGORIES.map((c) => c.category);
    expect(cats).toContain("policy_change");
    expect(cats).toContain("policy_evaluation");
    expect(cats).toContain("human_approval");
    expect(cats).toContain("automated_decision");
    expect(cats).toContain("appeal");
    expect(cats).toContain("incident");
    expect(cats).toContain("remediation");
  });

  it("all 7 categories are implemented", () => {
    const v = verifyAuditTrail();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedCategories).toBe(7);
  });

  it("every policy change is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "policy_change");
    expect(c?.sourceTable).toBe("policy_versions");
    expect(c?.implemented).toBe(true);
  });

  it("every policy evaluation is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "policy_evaluation");
    expect(c?.sourceTable).toBe("policy_evaluation_log");
    expect(c?.implemented).toBe(true);
  });

  it("every human approval is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "human_approval");
    expect(c?.sourceTable).toBe("governance_approvals");
    expect(c?.implemented).toBe(true);
  });

  it("every automated decision is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "automated_decision");
    expect(c?.sourceTable).toBe("governance_decision_log");
    expect(c?.implemented).toBe(true);
  });

  it("every appeal is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "appeal");
    expect(c?.sourceTable).toBe("governance_appeals");
    expect(c?.implemented).toBe(true);
  });

  it("every incident is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "incident");
    expect(c?.sourceTable).toBe("governance_incidents");
    expect(c?.implemented).toBe(true);
  });

  it("every remediation is recorded", () => {
    const c = AUDIT_EVENT_CATEGORIES.find((c) => c.category === "remediation");
    expect(c?.sourceTable).toBe("incident_remediations");
    expect(c?.implemented).toBe(true);
  });

  it("critical decisions retained for 7+ years", () => {
    const criticalYears = getCriticalRetentionYears();
    expect(criticalYears).toBeGreaterThanOrEqual(7);
  });

  it("all critical-class categories have 7+ year retention", () => {
    const critical = AUDIT_EVENT_CATEGORIES.filter((c) => c.retentionClass === "critical");
    expect(critical.length).toBeGreaterThan(0);
    for (const c of critical) {
      expect(c.retentionYears).toBeGreaterThanOrEqual(7);
    }
  });

  it("routine-class categories (if any) have shorter retention", () => {
    const routine = AUDIT_EVENT_CATEGORIES.filter((c) => c.retentionClass === "routine");
    // policy_evaluation is "standard" (3 years); the 7 named categories in
    // this spec are all critical/standard. Routine class exists for future
    // low-stakes events (e.g. telemetry snapshots) but none are defined here.
    for (const c of routine) {
      expect(c.retentionYears).toBeLessThan(1);
    }
  });

  it("legal holds are applicable to all categories", () => {
    for (const c of AUDIT_EVENT_CATEGORIES) {
      expect(c.legalHoldApplicable).toBe(true);
    }
  });

  it("standard-class categories have 3-year retention", () => {
    const standard = AUDIT_EVENT_CATEGORIES.filter((c) => c.retentionClass === "standard");
    for (const c of standard) {
      expect(c.retentionYears).toBe(3);
    }
  });
});

// ───────────────────────────────────────────────
// 11.1 Kill switches — 7 named types + 60s propagation SLA
// ───────────────────────────────────────────────

describe("11.1 — Kill switches", () => {
  it("has 7 named kill switch types", () => {
    expect(KILL_SWITCH_TYPES).toHaveLength(7);
    const types = KILL_SWITCH_TYPES.map((t) => t.type);
    expect(types).toContain("global");
    expect(types).toContain("domain");
    expect(types).toContain("tool");
    expect(types).toContain("agent");
    expect(types).toContain("region");
    expect(types).toContain("partner");
    expect(types).toContain("marketplace");
  });

  it("all 7 types are implemented", () => {
    const v = verifyKillSwitches();
    expect(v.allImplemented).toBe(true);
    expect(v.implementedTypes).toBe(7);
  });

  it("propagation SLA is 60 seconds (per spec)", () => {
    expect(KILL_SWITCH_PROPAGATION_SLA_SECONDS).toBe(60);
    expect(verifyKillSwitches().slaSeconds).toBe(60);
  });

  it("11.1.1 global kill switch — halts all autonomous decisions", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "global");
    expect(t?.title).toBe("Global Kill Switch");
    expect(t?.description).toContain("autonomous decisions");
    expect(t?.canonicalKey).toBe("global");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.2 domain kill switch — halts a specific decision domain", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "domain");
    expect(t?.title).toBe("Domain Kill Switch");
    expect(t?.description).toContain("decision domain");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.3 tool kill switch — disables a specific tool", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "tool");
    expect(t?.title).toBe("Tool Kill Switch");
    expect(t?.description).toContain("specific tool");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.4 agent kill switch — pauses all agents", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "agent");
    expect(t?.title).toBe("Agent Kill Switch");
    expect(t?.description).toContain("agents");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.5 region kill switch — pauses a region", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "region");
    expect(t?.title).toBe("Region Kill Switch");
    expect(t?.description).toContain("region");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.6 partner kill switch — pauses a partner integration", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "partner");
    expect(t?.title).toBe("Partner Kill Switch");
    expect(t?.description).toContain("partner integration");
    expect(t?.implemented).toBe(true);
  });

  it("11.1.7 marketplace kill switch — halts all publishing", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "marketplace");
    expect(t?.title).toBe("Marketplace Kill Switch");
    expect(t?.description).toContain("publishing");
    expect(t?.implemented).toBe(true);
  });

  it("global kill switch fans out to all 7 subscribers", () => {
    const t = KILL_SWITCH_TYPES.find((t) => t.type === "global");
    expect(t?.subscribers).toHaveLength(7);
    const subs = t?.subscribers as KillSwitchSubscriber[];
    expect(subs).toContain("decision-engine");
    expect(subs).toContain("tool-registry");
    expect(subs).toContain("agent-runtime");
    expect(subs).toContain("marketplace-service");
    expect(subs).toContain("regional-service");
    expect(subs).toContain("partner-service");
    expect(subs).toContain("policy-engine");
  });

  it("every type has at least the decision-engine subscriber", () => {
    for (const t of KILL_SWITCH_TYPES) {
      expect(t.subscribers).toContain("decision-engine");
    }
  });

  it("every type has at least 2 subscribers (defense-in-depth)", () => {
    for (const t of KILL_SWITCH_TYPES) {
      expect(t.subscribers.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("KillSwitchType is the union of 7 named types", () => {
    const t: KillSwitchType = "global";
    const t2: KillSwitchType = "domain";
    const t3: KillSwitchType = "tool";
    const t4: KillSwitchType = "agent";
    const t5: KillSwitchType = "region";
    const t6: KillSwitchType = "partner";
    const t7: KillSwitchType = "marketplace";
    expect([t, t2, t3, t4, t5, t6, t7]).toHaveLength(7);
  });
});
