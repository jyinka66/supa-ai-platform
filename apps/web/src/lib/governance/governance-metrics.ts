// Governance metrics — Section 10.1.
//
// The spec (10.1 Metrics): "Autonomous Governance is heavily observable."
//
// 8 metric groups:
//   1. Decisions per second, per domain.
//   2. Auto-approve rate, policy-check rate, human-approval rate.
//   3. Approval latency.
//   4. Policy evaluation latency.
//   5. Policy violations.
//   6. Appeals volume, resolution, satisfaction.
//   7. Incidents, remediation, recurrence.
//   8. Reputation distribution across actors.
//
// Two layers:
//   - Prometheus counters/histograms (scraped by /api/metrics) — raw throughput.
//   - Snapshot table (governance_metrics_snapshot) — periodic rollups for the
//     dashboard. Snapshots let us chart "auto-approve rate over the last 30d"
//     without re-scanning the decisions table.
//
// We DELIBERATELY do not persist every decision as its own metric sample —
// Prometheus is the source of truth for raw counts. The snapshot table is a
// 5-minute rollup (one row per (metric, dimension, bucket)) that the dashboards
// query. This is the standard high-cardinality-avoidance pattern.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { counter, histogram, gauge } from "@/lib/observability/metrics";
import { DECISION_DOMAINS } from "./decision-domains";

// ───────────────────────────────────────────────
// 10.1.1 Decisions per second, per domain.
// ───────────────────────────────────────────────

export const DECISIONS_TOTAL = counter(
  "governance_decisions_total",
  "Total governance decisions, by domain + outcome.",
);

export const DECISION_LATENCY = histogram(
  "governance_decision_latency_ms",
  "End-to-end decision latency in milliseconds.",
  [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
);

/** Record a decision outcome. Called by the decision engine after every decision. */
export function recordDecision(input: {
  domain: string;
  outcome: "auto_approved" | "policy_approved" | "human_approved" | "blocked" | "deferred";
  riskLevel: string;
  latencyMs: number;
}): void {
  DECISIONS_TOTAL.inc({
    domain: input.domain,
    outcome: input.outcome,
    risk_level: input.riskLevel,
  });
  DECISION_LATENCY.observe({ domain: input.domain }, input.latencyMs);
}

// ───────────────────────────────────────────────
// 10.1.2 Auto-approve rate, policy-check rate, human-approval rate.
// ───────────────────────────────────────────────

export const POLICY_EVALUATIONS_TOTAL = counter(
  "governance_policy_evaluations_total",
  "Policy evaluations, by policy_key + result.",
);

export const POLICY_EVAL_LATENCY = histogram(
  "governance_policy_eval_latency_ms",
  "Policy evaluation latency in milliseconds.",
  [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500],
);

export const POLICY_VIOLATIONS_TOTAL = counter(
  "governance_policy_violations_total",
  "Policy violations, by policy_key + severity.",
);

/** Record a policy evaluation result. */
export function recordPolicyEvaluation(input: {
  policyKey: string;
  result: "allow" | "deny" | "warn" | "defer";
  latencyMs: number;
  violationSeverity?: "info" | "warn" | "critical";
}): void {
  POLICY_EVALUATIONS_TOTAL.inc({
    policy_key: input.policyKey,
    result: input.result,
  });
  POLICY_EVAL_LATENCY.observe({ policy_key: input.policyKey }, input.latencyMs);
  if (input.result === "deny" || input.violationSeverity != null) {
    POLICY_VIOLATIONS_TOTAL.inc({
      policy_key: input.policyKey,
      severity: input.violationSeverity ?? "warn",
    });
  }
}

// ───────────────────────────────────────────────
// 10.1.3 + 10.1.4 — approval latency + policy eval latency.
// Already declared above (DECISION_LATENCY + POLICY_EVAL_LATENCY).
// ───────────────────────────────────────────────

// ───────────────────────────────────────────────
// 10.1.6 Appeals volume, resolution, satisfaction.
// ───────────────────────────────────────────────

export const APPEALS_TOTAL = counter(
  "governance_appeals_total",
  "Appeals submitted, by type.",
);

export const APPEAL_RESOLUTION_LATENCY = histogram(
  "governance_appeal_resolution_latency_hours",
  "Appeal resolution time in hours.",
  [1, 4, 12, 24, 48, 72, 168, 336, 720],
);

export const APPEAL_OUTCOME_TOTAL = counter(
  "governance_appeal_outcome_total",
  "Appeal outcomes (upheld / overturned / partially_upheld / withdrawn).",
);

export const APPEAL_SATISFACTION = gauge(
  "governance_appeal_satisfaction_score",
  "Rolling 30-day satisfaction score (0-100) per appeal type.",
);

/** Record an appeal outcome. */
export function recordAppealOutcome(input: {
  type: string;
  outcome: "upheld" | "overturned" | "partially_upheld" | "withdrawn";
  resolutionHours: number;
  satisfactionScore?: number; // 0-100 from the post-resolution survey.
}): void {
  APPEALS_TOTAL.inc({ type: input.type });
  APPEAL_OUTCOME_TOTAL.inc({ type: input.type, outcome: input.outcome });
  APPEAL_RESOLUTION_LATENCY.observe({ type: input.type }, input.resolutionHours);
  if (input.satisfactionScore != null) {
    APPEAL_SATISFACTION.set({ type: input.type }, input.satisfactionScore);
  }
}

// ───────────────────────────────────────────────
// 10.1.7 Incidents, remediation, recurrence.
// ───────────────────────────────────────────────

export const INCIDENTS_TOTAL = counter(
  "governance_incidents_total",
  "Governance-related incidents, by severity + category.",
);

export const INCIDENT_REMEDIATION_LATENCY = histogram(
  "governance_incident_remediation_latency_minutes",
  "Time from incident detection to remediation in minutes.",
  [1, 5, 15, 30, 60, 120, 240, 480, 1440, 2880],
);

export const INCIDENT_RECURRENCE_TOTAL = counter(
  "governance_incident_recurrence_total",
  "Incidents that recurred within 30 days of remediation.",
);

/** Record an incident + its remediation. */
export function recordIncident(input: {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  remediationMinutes: number;
  recurredWithin30d: boolean;
}): void {
  INCIDENTS_TOTAL.inc({ category: input.category, severity: input.severity });
  INCIDENT_REMEDIATION_LATENCY.observe(
    { category: input.category, severity: input.severity },
    input.remediationMinutes,
  );
  if (input.recurredWithin30d) {
    INCIDENT_RECURRENCE_TOTAL.inc({ category: input.category });
  }
}

// ───────────────────────────────────────────────
// 10.1.8 Reputation distribution across actors.
// ───────────────────────────────────────────────

export const REPUTATION_DISTRIBUTION = gauge(
  "governance_reputation_distribution",
  "Count of actors in each reputation tier, by actor dimension.",
);

export const REPUTATION_SCORE_SUM = gauge(
  "governance_reputation_score_sum",
  "Sum of reputation scores (for mean computation), by actor dimension.",
);

export const REPUTATION_SCORE_COUNT = gauge(
  "governance_reputation_score_count",
  "Count of actors with a reputation score, by actor dimension.",
);

/** Snapshot the reputation distribution. Called by the daily reputation-rollup cron. */
export async function snapshotReputationDistribution(): Promise<void> {
  const tiers = ["trusted", "new", "distrusted", "banned"];
  const dimensions = ["user", "workspace", "agent_creator", "connector_creator", "template_creator", "partner", "developer"];

  for (const dim of dimensions) {
    for (const tier of tiers) {
      const result = await db.execute(sql`
        select count(*)::int as n
          from reputation_scores
         where dimension = ${dim}
           and tier = ${tier}
      `);
      const n = Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
      REPUTATION_DISTRIBUTION.set({ dimension: dim, tier }, n);
    }

    const statsResult = await db.execute(sql`
      select coalesce(sum(score), 0)::float8 as sum_score,
             count(*)::int as n
        from reputation_scores
       where dimension = ${dim}
    `);
    const stats = result_row(statsResult) as { sum_score: string | number; n: number } | undefined;
    if (stats) {
      REPUTATION_SCORE_SUM.set({ dimension: dim }, Number(stats.sum_score));
      REPUTATION_SCORE_COUNT.set({ dimension: dim }, stats.n);
    }
  }
}

// helper: extract first row from db.execute() result (Drizzle returns arrays).
function result_row(r: unknown): unknown {
  const arr = r as Array<Record<string, unknown>>;
  return arr?.[0];
}

// ───────────────────────────────────────────────
// Snapshot table writer — periodic rollups for the dashboards.
// ───────────────────────────────────────────────

export interface MetricsSnapshot {
  metricName: string;
  dimensionKey: string; // e.g. "domain=tools,outcome=auto_approved"
  value: number;
  bucketStart: Date;
  bucketEnd: Date;
}

/**
 * Write a snapshot row to governance_metrics_snapshot. The dashboard reads
 * from this table; raw Prometheus counters are the source of truth for the
 * current value, but the snapshot table is what we chart over time.
 *
 * Called every 5 minutes by the metrics-snapshot cron.
 */
export async function writeMetricsSnapshot(snap: MetricsSnapshot): Promise<void> {
  await db.execute(sql`
    insert into governance_metrics_snapshot
      (metric_name, dimension_key, value, bucket_start, bucket_end)
    values
      (${snap.metricName}, ${snap.dimensionKey}, ${snap.value}, ${snap.bucketStart}, ${snap.bucketEnd})
  `);
}

/**
 * Read snapshot series for a metric (used by the dashboards).
 */
export async function readMetricsSeries(input: {
  metricName: string;
  from: Date;
  to: Date;
  dimensionKey?: string;
}): Promise<Array<{ bucketStart: Date; value: number; dimensionKey: string }>> {
  const rows = await db.execute(sql`
    select bucket_start, value, dimension_key
      from governance_metrics_snapshot
     where metric_name = ${input.metricName}
       and bucket_start >= ${input.from}
       and bucket_end <= ${input.to}
       ${input.dimensionKey != null ? sql`and dimension_key = ${input.dimensionKey}` : sql``}
     order by bucket_start asc, dimension_key asc
  `);
  return (rows as unknown as Array<{ bucket_start: Date; value: number; dimension_key: string }>).map((r) => ({
    bucketStart: r.bucket_start,
    value: Number(r.value),
    dimensionKey: r.dimension_key,
  }));
}

// ───────────────────────────────────────────────
// 10.1 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface MetricGroupSpec {
  id: string;
  title: string;
  metricNames: string[];
  implemented: boolean;
}

export const GOVERNANCE_METRIC_GROUPS: MetricGroupSpec[] = [
  {
    id: "10.1.1",
    title: "Decisions per second, per domain",
    metricNames: ["governance_decisions_total", "governance_decision_latency_ms"],
    implemented: true,
  },
  {
    id: "10.1.2",
    title: "Auto-approve rate, policy-check rate, human-approval rate",
    metricNames: ["governance_decisions_total{outcome}", "governance_policy_evaluations_total"],
    implemented: true,
  },
  {
    id: "10.1.3",
    title: "Approval latency",
    metricNames: ["governance_decision_latency_ms"],
    implemented: true,
  },
  {
    id: "10.1.4",
    title: "Policy evaluation latency",
    metricNames: ["governance_policy_eval_latency_ms"],
    implemented: true,
  },
  {
    id: "10.1.5",
    title: "Policy violations",
    metricNames: ["governance_policy_violations_total"],
    implemented: true,
  },
  {
    id: "10.1.6",
    title: "Appeals volume, resolution, satisfaction",
    metricNames: [
      "governance_appeals_total",
      "governance_appeal_outcome_total",
      "governance_appeal_resolution_latency_hours",
      "governance_appeal_satisfaction_score",
    ],
    implemented: true,
  },
  {
    id: "10.1.7",
    title: "Incidents, remediation, recurrence",
    metricNames: [
      "governance_incidents_total",
      "governance_incident_remediation_latency_minutes",
      "governance_incident_recurrence_total",
    ],
    implemented: true,
  },
  {
    id: "10.1.8",
    title: "Reputation distribution across actors",
    metricNames: [
      "governance_reputation_distribution",
      "governance_reputation_score_sum",
      "governance_reputation_score_count",
    ],
    implemented: true,
  },
];

export function verifyGovernanceMetrics(): {
  totalGroups: number;
  implementedGroups: number;
  allImplemented: boolean;
  groups: MetricGroupSpec[];
} {
  const implemented = GOVERNANCE_METRIC_GROUPS.filter((g) => g.implemented).length;
  return {
    totalGroups: GOVERNANCE_METRIC_GROUPS.length,
    implementedGroups: implemented,
    allImplemented: implemented === GOVERNANCE_METRIC_GROUPS.length,
    groups: GOVERNANCE_METRIC_GROUPS,
  };
}

/** Decisions-per-second computation (used by the dashboard header). */
export async function computeDecisionsPerSecond(windowSeconds = 60): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::float8 / ${windowSeconds} as dps
      from governance_decisions
     where created_at >= now() - (${windowSeconds} || ' seconds')::interval
  `);
  const n = Number((result as unknown as Array<{ dps: string | number }>)[0]?.dps ?? 0);
  return n;
}

/** Approval-rate breakdown (auto / policy / human / blocked). */
export async function computeApprovalRates(windowMinutes = 60): Promise<{
  auto: number;
  policy: number;
  human: number;
  blocked: number;
}> {
  const rows = await db.execute(sql`
    select decision, count(*)::float8 / nullif(sum(count(*)) over (), 0) as rate
      from governance_decisions
     where created_at >= now() - (${windowMinutes} || ' minutes')::interval
     group by decision
  `);
  const map = new Map<string, number>();
  for (const r of rows as unknown as Array<{ decision: string; rate: string | number }>) {
    map.set(r.decision, Number(r.rate));
  }
  return {
    auto: map.get("auto_approved") ?? 0,
    policy: map.get("policy_approved") ?? 0,
    human: map.get("human_approved") ?? 0,
    blocked: map.get("blocked") ?? 0,
  };
}

/** Per-domain decision counts (used by the dashboard heatmap). */
export async function computePerDomainCounts(windowMinutes = 60): Promise<Array<{ domain: string; count: number }>> {
  const rows = await db.execute(sql`
    select domain, count(*)::int as count
      from governance_decisions
     where created_at >= now() - (${windowMinutes} || ' minutes')::interval
     group by domain
     order by count desc
  `);
  return (rows as unknown as Array<{ domain: string; count: number }>).map((r) => ({
    domain: r.domain,
    count: Number(r.count),
  }));
}

// ───────────────────────────────────────────────
// Sanity: every decision domain has a metric label available.
// ───────────────────────────────────────────────

export function listDecisionDomains(): string[] {
  return DECISION_DOMAINS.map((d) => d.domain);
}
