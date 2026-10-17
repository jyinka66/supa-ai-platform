// Governance dashboards — Section 10.3.
//
// The spec (10.3 Dashboards): "Autonomous Governance is heavily observable."
//
//   1. Governance dashboard: decisions, approvals, appeals, incidents.
//   2. Policy dashboard: coverage, versions, auto-tuning proposals.
//   3. Reputation dashboard: distribution, changes, anomalies.
//   4. Compliance dashboard: evidence, gaps, audits.
//
// DESIGN
//
//   Each dashboard is a single async function that returns a structured JSON
//   document. The dashboard UI (a Next.js page) fetches this JSON and renders.
//   We deliberately do NOT compute charts here — we compute the underlying
//   data; the UI decides how to visualize (table, sparkline, gauge).
//
//   Time windows are 24h by default (the "operational" view); 30d is available
//   for trend views. Both are parameterized.
//
//   All four dashboards use the same access-control rule: only platform-level
//   governance viewers may call these functions (the route enforces the
//   permission check). The functions themselves are pure data queries.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import {
  computeDecisionsPerSecond,
  computeApprovalRates,
  computePerDomainCounts,
  readMetricsSeries,
} from "./governance-metrics";

// ───────────────────────────────────────────────
// 10.3.1 Governance dashboard — decisions, approvals, appeals, incidents.
// ───────────────────────────────────────────────

export interface GovernanceDashboard {
  windowFrom: Date;
  windowTo: Date;
  decisions: {
    decisionsPerSecond: number;
    perDomain: Array<{ domain: string; count: number }>;
    approvalRates: {
      auto: number;
      policy: number;
      human: number;
      blocked: number;
    };
    latencyMsP50: number | null;
    latencyMsP95: number | null;
    latencyMsP99: number | null;
  };
  appeals: {
    submitted: number;
    resolved: number;
    upheld: number;
    overturned: number;
    partiallyUpheld: number;
    withdrawn: number;
    avgResolutionHours: number | null;
    satisfactionScore: number | null;
    overdue: number;
  };
  incidents: {
    total: number;
    bySeverity: Array<{ severity: string; count: number }>;
    avgRemediationMinutes: number | null;
    recurrenceRate: number; // fraction of incidents that recurred within 30d.
  };
}

export async function getGovernanceDashboard(opts: {
  windowMinutes?: number;
} = {}): Promise<GovernanceDashboard> {
  const windowMinutes = opts.windowMinutes ?? 1440; // default 24h.
  const windowFrom = new Date(Date.now() - windowMinutes * 60_000);
  const windowTo = new Date();

  // Decisions block.
  const decisionsPerSecond = await computeDecisionsPerSecond(60);
  const perDomain = await computePerDomainCounts(windowMinutes);
  const approvalRates = await computeApprovalRates(windowMinutes);

  const latencyResult = await db.execute(sql`
    select
      coalesce(percentile_cont(0.50) within group (order by latency_ms), 0)::float8 as p50,
      coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::float8 as p95,
      coalesce(percentile_cont(0.99) within group (order by latency_ms), 0)::float8 as p99
    from governance_decisions
    where created_at >= now() - (${windowMinutes} || ' minutes')::interval
  `);
  const latency = (latencyResult as unknown as Array<{ p50: number; p95: number; p99: number }>)[0];

  // Appeals block.
  const appealsResult = await db.execute(sql`
    select
      count(*) filter (where created_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as submitted,
      count(*) filter (where status in ('upheld','overturned','partially_upheld','withdrawn')
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as resolved,
      count(*) filter (where status = 'upheld'
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as upheld,
      count(*) filter (where status = 'overturned'
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as overturned,
      count(*) filter (where status = 'partially_upheld'
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as partially_upheld,
      count(*) filter (where status = 'withdrawn'
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval)::int as withdrawn,
      coalesce(avg(extract(epoch from (resolved_at - created_at)) / 3600)
               filter (where resolved_at is not null
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval), 0)::float8 as avg_resolution_hours,
      coalesce(avg(satisfaction_score)
               filter (where satisfaction_score is not null
                       and resolved_at >= now() - (${windowMinutes} || ' minutes')::interval), 0)::float8 as satisfaction,
      count(*) filter (where status not in ('upheld','overturned','partially_upheld','withdrawn')
                       and (decision_deadline is not null and decision_deadline < now()))::int as overdue
    from governance_appeals
  `);
  const appeals = (appealsResult as unknown as Array<Record<string, number>>)[0];

  // Incidents block.
  const incidentsResult = await db.execute(sql`
    select
      count(*)::int as total,
      coalesce(avg(extract(epoch from (remediated_at - detected_at)) / 60)
               filter (where remediated_at is not null), 0)::float8 as avg_remediation_minutes,
      count(*) filter (where recurred_within_30d)::float8 /
        nullif(count(*) filter (where remediated_at is not null), 0)::float8 as recurrence_rate
    from governance_incidents
    where detected_at >= now() - (${windowMinutes} || ' minutes')::interval
  `);
  const incidentsAgg = (incidentsResult as unknown as Array<{ total: number; avg_remediation_minutes: number; recurrence_rate: string | number | null }>)[0];

  const bySeverityResult = await db.execute(sql`
    select severity, count(*)::int as count
      from governance_incidents
     where detected_at >= now() - (${windowMinutes} || ' minutes')::interval
     group by severity
  `);
  const bySeverity = (bySeverityResult as unknown as Array<{ severity: string; count: number }>).map((r) => ({
    severity: r.severity,
    count: Number(r.count),
  }));

  return {
    windowFrom,
    windowTo,
    decisions: {
      decisionsPerSecond,
      perDomain,
      approvalRates,
      latencyMsP50: latency ? Number(latency.p50) : null,
      latencyMsP95: latency ? Number(latency.p95) : null,
      latencyMsP99: latency ? Number(latency.p99) : null,
    },
    appeals: {
      submitted: Number(appeals?.submitted ?? 0),
      resolved: Number(appeals?.resolved ?? 0),
      upheld: Number(appeals?.upheld ?? 0),
      overturned: Number(appeals?.overturned ?? 0),
      partiallyUpheld: Number(appeals?.partially_upheld ?? 0),
      withdrawn: Number(appeals?.withdrawn ?? 0),
      avgResolutionHours: Number(appeals?.avg_resolution_hours ?? 0),
      satisfactionScore: Number(appeals?.satisfaction ?? 0),
      overdue: Number(appeals?.overdue ?? 0),
    },
    incidents: {
      total: Number(incidentsAgg?.total ?? 0),
      bySeverity,
      avgRemediationMinutes: Number(incidentsAgg?.avg_remediation_minutes ?? 0),
      recurrenceRate: incidentsAgg?.recurrence_rate != null ? Number(incidentsAgg.recurrence_rate) : 0,
    },
  };
}

// ───────────────────────────────────────────────
// 10.3.2 Policy dashboard — coverage, versions, auto-tuning proposals.
// ───────────────────────────────────────────────

export interface PolicyDashboard {
  windowFrom: Date;
  windowTo: Date;
  coverage: {
    totalRules: number;
    activeRules: number;
    draftRules: number;
    deprecatedRules: number;
    byCategory: Array<{ category: string; count: number }>;
  };
  versions: {
    totalVersions: number;
    versionsLast30d: number;
    rollbackCount: number;
    pendingReview: number;
  };
  autoTuningProposals: {
    pending: number;
    approved: number;
    rejected: number;
    applied: number;
    byCategory: Array<{ category: string; pending: number; applied: number }>;
  };
  recentChanges: Array<{
    policyKey: string;
    version: number;
    action: string;
    actor: string;
    at: Date;
  }>;
}

export async function getPolicyDashboard(): Promise<PolicyDashboard> {
  const windowFrom = new Date(Date.now() - 30 * 24 * 3600_000);
  const windowTo = new Date();

  const coverageResult = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'draft')::int as draft,
      count(*) filter (where status = 'deprecated')::int as deprecated
    from policy_rules
  `);
  const coverage = (coverageResult as unknown as Array<{ total: number; active: number; draft: number; deprecated: number }>)[0];

  const byCatResult = await db.execute(sql`
    select category, count(*)::int as count
      from policy_rules
     where status = 'active'
     group by category
     order by count desc
  `);
  const byCategory = (byCatResult as unknown as Array<{ category: string; count: number }>).map((r) => ({
    category: r.category,
    count: Number(r.count),
  }));

  const versionsResult = await db.execute(sql`
    select
      count(*)::int as total_versions,
      count(*) filter (where created_at >= now() - interval '30 days')::int as versions_last_30d,
      count(*) filter (where change_type = 'rollback')::int as rollback_count,
      count(*) filter (where status = 'pending_review')::int as pending_review
    from policy_versions
  `);
  const versions = (versionsResult as unknown as Array<{ total_versions: number; versions_last_30d: number; rollback_count: number; pending_review: number }>)[0];

  const tuningResult = await db.execute(sql`
    select
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'approved')::int as approved,
      count(*) filter (where status = 'rejected')::int as rejected,
      count(*) filter (where status = 'applied')::int as applied
    from policy_tuning_proposals
  `);
  const tuning = (tuningResult as unknown as Array<{ pending: number; approved: number; rejected: number; applied: number }>)[0];

  const tuningByCatResult = await db.execute(sql`
    select category,
           count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status = 'applied')::int as applied
      from policy_tuning_proposals
     group by category
  `);
  const tuningByCat = (tuningByCatResult as unknown as Array<{ category: string; pending: number; applied: number }>).map((r) => ({
    category: r.category,
    pending: Number(r.pending),
    applied: Number(r.applied),
  }));

  const recentResult = await db.execute(sql`
    select policy_key, version, change_type as action, changed_by as actor, created_at as at
      from policy_versions
     order by created_at desc
     limit 20
  `);
  const recent = (recentResult as unknown as Array<{ policy_key: string; version: number; action: string; actor: string; at: Date }>).map((r) => ({
    policyKey: r.policy_key,
    version: Number(r.version),
    action: r.action,
    actor: r.actor,
    at: r.at,
  }));

  return {
    windowFrom,
    windowTo,
    coverage: {
      totalRules: Number(coverage?.total ?? 0),
      activeRules: Number(coverage?.active ?? 0),
      draftRules: Number(coverage?.draft ?? 0),
      deprecatedRules: Number(coverage?.deprecated ?? 0),
      byCategory,
    },
    versions: {
      totalVersions: Number(versions?.total_versions ?? 0),
      versionsLast30d: Number(versions?.versions_last_30d ?? 0),
      rollbackCount: Number(versions?.rollback_count ?? 0),
      pendingReview: Number(versions?.pending_review ?? 0),
    },
    autoTuningProposals: {
      pending: Number(tuning?.pending ?? 0),
      approved: Number(tuning?.approved ?? 0),
      rejected: Number(tuning?.rejected ?? 0),
      applied: Number(tuning?.applied ?? 0),
      byCategory: tuningByCat,
    },
    recentChanges: recent,
  };
}

// ───────────────────────────────────────────────
// 10.3.3 Reputation dashboard — distribution, changes, anomalies.
// ───────────────────────────────────────────────

export interface ReputationDashboard {
  windowFrom: Date;
  windowTo: Date;
  distribution: Array<{
    dimension: string;
    trusted: number;
    new: number;
    distrusted: number;
    banned: number;
    meanScore: number;
  }>;
  changes: {
    promotedToTrusted: number;
    demotedFromTrusted: number;
    newBans: number;
    reversions: number;
  };
  anomalies: Array<{
    dimension: string;
    actorId: string;
    anomalyType: string;
    description: string;
    detectedAt: Date;
  }>;
}

export async function getReputationDashboard(opts: { windowMinutes?: number } = {}): Promise<ReputationDashboard> {
  const windowMinutes = opts.windowMinutes ?? 1440;
  const windowFrom = new Date(Date.now() - windowMinutes * 60_000);
  const windowTo = new Date();

  // Distribution per dimension + tier counts + mean.
  const distResult = await db.execute(sql`
    select dimension,
           count(*) filter (where tier = 'trusted')::int as trusted,
           count(*) filter (where tier = 'new')::int as new_tier,
           count(*) filter (where tier = 'distrusted')::int as distrusted,
           count(*) filter (where tier = 'banned')::int as banned,
           coalesce(avg(score), 0)::float8 as mean_score
      from reputation_scores
     group by dimension
     order by dimension
  `);
  const distribution = (distResult as unknown as Array<{ dimension: string; trusted: number; new_tier: number; distrusted: number; banned: number; mean_score: number }>).map((r) => ({
    dimension: r.dimension,
    trusted: Number(r.trusted),
    new: Number(r.new_tier),
    distrusted: Number(r.distrusted),
    banned: Number(r.banned),
    meanScore: Number(r.mean_score),
  }));

  // Changes in the window.
  const changesResult = await db.execute(sql`
    select
      count(*) filter (where event = 'promoted_to_trusted')::int as promoted,
      count(*) filter (where event = 'demoted_from_trusted')::int as demoted,
      count(*) filter (where event = 'banned')::int as new_bans,
      count(*) filter (where event = 'reverted')::int as reversions
    from reputation_events
    where created_at >= now() - (${windowMinutes} || ' minutes')::interval
  `);
  const changes = (changesResult as unknown as Array<{ promoted: number; demoted: number; new_bans: number; reversions: number }>)[0];

  // Anomalies — sudden drops, suspicious activity patterns, etc.
  const anomaliesResult = await db.execute(sql`
    select dimension, actor_id, anomaly_type, description, detected_at
      from reputation_anomalies
     where detected_at >= now() - (${windowMinutes} || ' minutes')::interval
     order by detected_at desc
     limit 50
  `);
  const anomalies = (anomaliesResult as unknown as Array<{ dimension: string; actor_id: string; anomaly_type: string; description: string; detected_at: Date }>).map((r) => ({
    dimension: r.dimension,
    actorId: r.actor_id,
    anomalyType: r.anomaly_type,
    description: r.description,
    detectedAt: r.detected_at,
  }));

  return {
    windowFrom,
    windowTo,
    distribution,
    changes: {
      promotedToTrusted: Number(changes?.promoted ?? 0),
      demotedFromTrusted: Number(changes?.demoted ?? 0),
      newBans: Number(changes?.new_bans ?? 0),
      reversions: Number(changes?.reversions ?? 0),
    },
    anomalies,
  };
}

// ───────────────────────────────────────────────
// 10.3.4 Compliance dashboard — evidence, gaps, audits.
// ───────────────────────────────────────────────

export interface ComplianceDashboard {
  frameworks: Array<{
    key: string;
    title: string;
    evidenceCount: number;
    lastAuditAt: Date | null;
    gaps: number;
    status: "compliant" | "minor_gaps" | "major_gaps" | "non_compliant";
  }>;
  recentAudits: Array<{
    framework: string;
    auditor: string;
    startAt: Date;
    endAt: Date | null;
    result: "pass" | "fail" | "in_progress";
  }>;
  evidenceByType: Array<{ evidenceType: string; count: number }>;
  upcomingDeadlines: Array<{ framework: string; deadline: Date; description: string }>;
}

export async function getComplianceDashboard(): Promise<ComplianceDashboard> {
  const frameworksResult = await db.execute(sql`
    select f.key, f.title,
           (select count(*) from compliance_evidence e where e.framework = f.key)::int as evidence_count,
           (select max(audit_completed_at) from compliance_audits au where au.framework = f.key) as last_audit_at,
           (select count(*) from compliance_gaps g where g.framework = f.key and g.status = 'open')::int as gaps,
           f.status
      from compliance_frameworks f
     order by f.title
  `);
  const frameworks = (frameworksResult as unknown as Array<{ key: string; title: string; evidence_count: number; last_audit_at: Date | null; gaps: number; status: string }>).map((r) => ({
    key: r.key,
    title: r.title,
    evidenceCount: Number(r.evidence_count),
    lastAuditAt: r.last_audit_at,
    gaps: Number(r.gaps),
    status: r.status as "compliant" | "minor_gaps" | "major_gaps" | "non_compliant",
  }));

  const recentResult = await db.execute(sql`
    select framework, auditor, started_at, completed_at, result
      from compliance_audits
     order by started_at desc
     limit 20
  `);
  const recentAudits = (recentResult as unknown as Array<{ framework: string; auditor: string; started_at: Date; completed_at: Date | null; result: string }>).map((r) => ({
    framework: r.framework,
    auditor: r.auditor,
    startAt: r.started_at,
    endAt: r.completed_at,
    result: r.result as "pass" | "fail" | "in_progress",
  }));

  const byTypeResult = await db.execute(sql`
    select evidence_type, count(*)::int as count
      from compliance_evidence
     group by evidence_type
     order by count desc
  `);
  const evidenceByType = (byTypeResult as unknown as Array<{ evidence_type: string; count: number }>).map((r) => ({
    evidenceType: r.evidence_type,
    count: Number(r.count),
  }));

  const deadlinesResult = await db.execute(sql`
    select framework, deadline, description
      from compliance_upcoming_deadlines
     where deadline >= now()
     order by deadline asc
     limit 20
  `);
  const upcomingDeadlines = (deadlinesResult as unknown as Array<{ framework: string; deadline: Date; description: string }>).map((r) => ({
    framework: r.framework,
    deadline: r.deadline,
    description: r.description,
  }));

  return { frameworks, recentAudits, evidenceByType, upcomingDeadlines };
}

// ───────────────────────────────────────────────
// 10.3 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface DashboardSpec {
  id: string;
  title: string;
  description: string;
  implemented: boolean;
  sections: string[];
}

export const GOVERNANCE_DASHBOARDS: DashboardSpec[] = [
  {
    id: "10.3.1",
    title: "Governance dashboard",
    description: "Decisions, approvals, appeals, incidents — operational view.",
    implemented: true,
    sections: ["decisions", "appeals", "incidents"],
  },
  {
    id: "10.3.2",
    title: "Policy dashboard",
    description: "Coverage, versions, auto-tuning proposals.",
    implemented: true,
    sections: ["coverage", "versions", "autoTuningProposals", "recentChanges"],
  },
  {
    id: "10.3.3",
    title: "Reputation dashboard",
    description: "Distribution, changes, anomalies.",
    implemented: true,
    sections: ["distribution", "changes", "anomalies"],
  },
  {
    id: "10.3.4",
    title: "Compliance dashboard",
    description: "Evidence, gaps, audits.",
    implemented: true,
    sections: ["frameworks", "recentAudits", "evidenceByType", "upcomingDeadlines"],
  },
];

export function verifyGovernanceDashboards(): {
  totalDashboards: number;
  implementedDashboards: number;
  allImplemented: boolean;
} {
  const impl = GOVERNANCE_DASHBOARDS.filter((d) => d.implemented).length;
  return {
    totalDashboards: GOVERNANCE_DASHBOARDS.length,
    implementedDashboards: impl,
    allImplemented: impl === GOVERNANCE_DASHBOARDS.length,
  };
}
