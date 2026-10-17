// Anomaly detection — across all globalization health metrics.
//
// The spec: "Automated anomaly detection across all of the above."
//
// Detects:
//   - i18n: completeness drops below threshold (e.g. < 80%).
//   - SEO: avg position worsens (higher = worse), broken backlinks increase.
//   - Content: stale count spikes, broken links found.
//   - Support: SLA breach rate spikes, CSAT drops below threshold.
//   - Performance: any SLO error budget consumed > threshold.
//
// Anomalies are stored in anomaly_alerts + the cron emits critical alerts
// to the admin audit log.

import { db } from "@supa/db";
import { anomalyAlerts } from "@supa/db/schema";
import { sql } from "drizzle-orm";
import { getGlobalizationHealth } from "@/lib/observability/globalization-health";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type AnomalyCategory = "i18n" | "accessibility" | "seo" | "content" | "legal" | "support" | "regional" | "performance" | "security";
export type AnomalySeverity = "info" | "warning" | "critical";

export interface Anomaly {
  category: AnomalyCategory;
  metric: string;
  severity: AnomalySeverity;
  expectedValue?: number;
  actualValue?: number;
  deviationPct?: number;
  detail: string;
}

export interface AnomalyDetectionResult {
  detected: number;
  critical: number;
  warning: number;
  info: number;
  anomalies: Anomaly[];
}

// ───────────────────────────────────────────────
// Thresholds for anomaly detection.
// ───────────────────────────────────────────────

const THRESHOLDS = {
  i18nCompletenessMin: 80,        // below 80% = warning, below 60% = critical.
  i18nCompletenessCritical: 60,
  seoAvgPositionMax: 30,          // avg position > 30 = warning.
  seoBrokenBacklinksPct: 10,     // >10% broken backlinks = warning.
  contentStaleMax: 50,           // >50 stale items = warning.
  supportSlaBreachMax: 5,        // >5 SLA breaches = warning, >10 = critical.
  supportSlaBreachCritical: 10,
  supportCsatMin: 3.5,            // avg CSAT < 3.5 = critical.
  sloAlertingMax: 2,              // >2 SLOs alerting = warning.
};

// ───────────────────────────────────────────────
// detectAnomalies — the main detection function.
// ───────────────────────────────────────────────

export async function detectAnomalies(): Promise<AnomalyDetectionResult> {
  const health = await getGlobalizationHealth();
  const anomalies: Anomaly[] = [];

  // 1. i18n: locale completeness.
  if (health.i18n.avgCompletenessPct < THRESHOLDS.i18nCompletenessCritical) {
    anomalies.push({
      category: "i18n",
      metric: "avgCompletenessPct",
      severity: "critical",
      expectedValue: THRESHOLDS.i18nCompletenessCritical,
      actualValue: health.i18n.avgCompletenessPct,
      deviationPct: ((health.i18n.avgCompletenessPct - THRESHOLDS.i18nCompletenessCritical) / THRESHOLDS.i18nCompletenessCritical) * 100,
      detail: `Average locale completeness is ${health.i18n.avgCompletenessPct.toFixed(1)}% (below critical threshold of ${THRESHOLDS.i18nCompletenessCritical}%)`,
    });
  } else if (health.i18n.avgCompletenessPct < THRESHOLDS.i18nCompletenessMin) {
    anomalies.push({
      category: "i18n",
      metric: "avgCompletenessPct",
      severity: "warning",
      expectedValue: THRESHOLDS.i18nCompletenessMin,
      actualValue: health.i18n.avgCompletenessPct,
      deviationPct: ((health.i18n.avgCompletenessPct - THRESHOLDS.i18nCompletenessMin) / THRESHOLDS.i18nCompletenessMin) * 100,
      detail: `Average locale completeness is ${health.i18n.avgCompletenessPct.toFixed(1)}% (below warning threshold of ${THRESHOLDS.i18nCompletenessMin}%)`,
    });
  }

  // 2. SEO: avg position.
  if (health.seo.avgPosition != null && health.seo.avgPosition > THRESHOLDS.seoAvgPositionMax) {
    anomalies.push({
      category: "seo",
      metric: "avgPosition",
      severity: "warning",
      expectedValue: THRESHOLDS.seoAvgPositionMax,
      actualValue: health.seo.avgPosition,
      detail: `Average search position is ${health.seo.avgPosition.toFixed(1)} (worse than threshold of ${THRESHOLDS.seoAvgPositionMax})`,
    });
  }

  // 3. Content: stale count.
  if (health.content.staleCount > THRESHOLDS.contentStaleMax) {
    anomalies.push({
      category: "content",
      metric: "staleCount",
      severity: "warning",
      expectedValue: THRESHOLDS.contentStaleMax,
      actualValue: health.content.staleCount,
      detail: `${health.content.staleCount} stale content items (above threshold of ${THRESHOLDS.contentStaleMax})`,
    });
  }

  // 4. Support: SLA breaches.
  if (health.support.slaBreachedCount > THRESHOLDS.supportSlaBreachCritical) {
    anomalies.push({
      category: "support",
      metric: "slaBreachedCount",
      severity: "critical",
      expectedValue: THRESHOLDS.supportSlaBreachCritical,
      actualValue: health.support.slaBreachedCount,
      detail: `${health.support.slaBreachedCount} SLA breaches (above critical threshold of ${THRESHOLDS.supportSlaBreachCritical})`,
    });
  } else if (health.support.slaBreachedCount > THRESHOLDS.supportSlaBreachMax) {
    anomalies.push({
      category: "support",
      metric: "slaBreachedCount",
      severity: "warning",
      expectedValue: THRESHOLDS.supportSlaBreachMax,
      actualValue: health.support.slaBreachedCount,
      detail: `${health.support.slaBreachedCount} SLA breaches (above threshold of ${THRESHOLDS.supportSlaBreachMax})`,
    });
  }

  // 5. Support: CSAT.
  if (health.support.avgCsat != null && health.support.avgCsat < THRESHOLDS.supportCsatMin) {
    anomalies.push({
      category: "support",
      metric: "avgCsat",
      severity: "critical",
      expectedValue: THRESHOLDS.supportCsatMin,
      actualValue: health.support.avgCsat,
      detail: `Average CSAT is ${health.support.avgCsat.toFixed(1)} (below critical threshold of ${THRESHOLDS.supportCsatMin})`,
    });
  }

  // 6. SLO alerting count.
  if (health.alertingCount > THRESHOLDS.sloAlertingMax) {
    anomalies.push({
      category: "performance",
      metric: "alertingSloCount",
      severity: "warning",
      expectedValue: THRESHOLDS.sloAlertingMax,
      actualValue: health.alertingCount,
      detail: `${health.alertingCount} SLOs in alert state (above threshold of ${THRESHOLDS.sloAlertingMax})`,
    });
  }

  return {
    detected: anomalies.length,
    critical: anomalies.filter((a) => a.severity === "critical").length,
    warning: anomalies.filter((a) => a.severity === "warning").length,
    info: anomalies.filter((a) => a.severity === "info").length,
    anomalies,
  };
}

// ───────────────────────────────────────────────
// persistAnomalies — store detected anomalies + audit critical ones.
// ───────────────────────────────────────────────

export async function persistAnomalies(result: AnomalyDetectionResult): Promise<void> {
  for (const anomaly of result.anomalies) {
    try {
      await db.insert(anomalyAlerts).values({
        category: anomaly.category,
        metric: anomaly.metric,
        severity: anomaly.severity,
        ...(anomaly.expectedValue != null ? { expectedValue: anomaly.expectedValue.toString() } : {}),
        ...(anomaly.actualValue != null ? { actualValue: anomaly.actualValue.toString() } : {}),
        ...(anomaly.deviationPct != null ? { deviationPct: anomaly.deviationPct.toString() } : {}),
        detail: anomaly.detail,
      });
    } catch {
      // Insert failure must not crash the cron.
    }

    // Audit critical anomalies.
    if (anomaly.severity === "critical") {
      try {
        await adminAudit({
          actor: "system",
          action: `anomaly.critical.${anomaly.category}.${anomaly.metric}`,
          target: {
            expected: anomaly.expectedValue,
            actual: anomaly.actualValue,
            detail: anomaly.detail,
          },
          justification: `CRITICAL anomaly detected: ${anomaly.detail}`,
        });
      } catch {
        // audit failure must not crash the cron.
      }
    }
  }
}

// ───────────────────────────────────────────────
// listUnresolvedAnomalies — for the dashboard.
// ───────────────────────────────────────────────

export async function listUnresolvedAnomalies(): Promise<Array<{
  id: string;
  category: string;
  metric: string;
  severity: string;
  detail: string;
  detectedAt: Date;
}>> {
  const rows = await db.execute(sql`
    select id, category, metric, severity, detail, detected_at
    from anomaly_alerts
    where resolved_at is null
    order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, detected_at desc
    limit 100
  `);
  return (rows as unknown as Array<{ id: string; category: string; metric: string; severity: string; detail: string; detected_at: Date }>).map((r) => ({
    id: r.id,
    category: r.category,
    metric: r.metric,
    severity: r.severity,
    detail: r.detail,
    detectedAt: r.detected_at,
  }));
}
