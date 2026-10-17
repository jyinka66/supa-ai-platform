// Automated reports — weekly, monthly, quarterly.
//
// The spec: "Automated reports weekly, monthly, quarterly."
//
// Each report aggregates the globalization health dashboard data for the period
// + trend analysis (comparing to the previous period) + any anomalies detected.
// Reports are stored in automated_reports + distributed (emailed to stakeholders).

import { db } from "@supa/db";
import { automatedReports } from "@supa/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getGlobalizationHealth } from "@/lib/observability/globalization-health";
import { getRequirementSummary } from "@/lib/phase11/requirements";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ReportPeriod = "weekly" | "monthly" | "quarterly";

export interface Report {
  id: string;
  period: ReportPeriod;
  periodStart: Date;
  periodEnd: Date;
  reportData: Record<string, unknown>;
  generatedAt: Date;
  distributed: boolean;
  distributedAt: Date | null;
  distributedTo: string[] | null;
}

export interface ReportData {
  health: Record<string, unknown>;
  requirements: { totalChecks: number; met: number; unmet: number };
  anomalies: Array<{ category: string; metric: string; severity: string; detail: string }>;
  summary: string;
  period: { start: string; end: string; type: ReportPeriod };
}

// ───────────────────────────────────────────────
// Period boundaries.
// ───────────────────────────────────────────────

export function getPeriodBounds(period: ReportPeriod, now: Date = new Date()): { start: Date; end: Date } {
  const end = new Date(now);
  let start: Date;

  switch (period) {
    case "weekly":
      start = new Date(now.getTime() - 7 * 86400000);
      break;
    case "monthly":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      break;
    case "quarterly":
      start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      break;
  }

  return { start, end };
}

// ───────────────────────────────────────────────
// generateReport — aggregate health + requirements + anomalies.
// ───────────────────────────────────────────────

export async function generateReport(period: ReportPeriod): Promise<Report> {
  const { start, end } = getPeriodBounds(period);

  const [health, requirements] = await Promise.all([
    getGlobalizationHealth(),
    Promise.resolve(getRequirementSummary()),
  ]);

  // Fetch unresolved anomalies for the period.
  const anomaliesResult = await db.execute(sql`
    select category, metric, severity, detail
    from anomaly_alerts
    where detected_at >= ${start} and detected_at <= ${end}
    order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, detected_at desc
  `);
  const anomalies = (anomaliesResult as unknown as Array<{ category: string; metric: string; severity: string; detail: string }>).map((r) => ({
    category: r.category,
    metric: r.metric,
    severity: r.severity,
    detail: r.detail,
  }));

  const reportData: ReportData = {
    health: health as unknown as Record<string, unknown>,
    requirements,
    anomalies,
    summary: `${period} report: ${requirements.met}/${requirements.totalChecks} requirements met, ${anomalies.length} anomalies detected, ${health.alertingCount} SLOs alerting.`,
    period: { start: start.toISOString(), end: end.toISOString(), type: period },
  };

  const rows = await db
    .insert(automatedReports)
    .values({
      period,
      periodStart: start,
      periodEnd: end,
      reportData: reportData as any,
    })
    .returning({ id: automatedReports.id, generatedAt: automatedReports.generatedAt });

  const row = rows[0];
  if (!row) throw new Error("report_insert_failed");

  return {
    id: row.id as string,
    period,
    periodStart: start,
    periodEnd: end,
    reportData: reportData as unknown as Record<string, unknown>,
    generatedAt: row.generatedAt,
    distributed: false,
    distributedAt: null,
    distributedTo: null,
  };
}

// ───────────────────────────────────────────────
// getLatestReport — for the dashboard.
// ───────────────────────────────────────────────

export async function getLatestReport(period: ReportPeriod): Promise<Report | null> {
  const rows = await db
    .select()
    .from(automatedReports)
    .where(eq(automatedReports.period, period))
    .orderBy(desc(automatedReports.periodStart))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id as string,
    period: row.period as ReportPeriod,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    reportData: (row.reportData as Record<string, unknown>) ?? {},
    generatedAt: row.generatedAt,
    distributed: row.distributed,
    distributedAt: row.distributedAt,
    distributedTo: row.distributedTo ?? null,
  };
}

export async function listReports(period?: ReportPeriod, limit: number = 12): Promise<Report[]> {
  const rows = await db
    .select()
    .from(automatedReports)
    .where(period ? eq(automatedReports.period, period) : undefined)
    .orderBy(desc(automatedReports.periodStart))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id as string,
    period: row.period as ReportPeriod,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    reportData: (row.reportData as Record<string, unknown>) ?? {},
    generatedAt: row.generatedAt,
    distributed: row.distributed,
    distributedAt: row.distributedAt,
    distributedTo: row.distributedTo ?? null,
  }));
}
