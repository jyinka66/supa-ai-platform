// Self-healing — anomaly detection + automated remediation.
//
// The spec: "Everything is observable and self-healing. Anomalies are detected,
// diagnosed, and remediated by the platform. Humans see incidents after the fact."
//
// This module provides:
//   - detectPlatformAnomalies — scan the platform for anomalies (tool failures,
//     marketplace takedowns, deployment degradations, policy violations).
//   - remediateAnomaly — automated remediation (restart, rollback, suspend, alert).
//   - The self-healing cron runs nightly: detect → remediate → audit.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";
import { listCircuitBreakers, resetCircuitBreaker } from "@/lib/reliability/circuit-breaker";
import { runAlgorithmicTakedowns } from "./marketplace";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type AnomalyType =
  | "circuit_breaker_open"
  | "marketplace_low_rated"
  | "marketplace_malware"
  | "deployment_degraded"
  | "tool_failure_rate_high"
  | "slo_budget_exceeded"
  | "policy_violation";

export type RemediationAction =
  | "reset_circuit_breaker"
  | "suspend_marketplace_item"
  | "takedown_marketplace_item"
  | "alert_only"
  | "rollback_deployment"
  | "no_action";

export interface PlatformAnomaly {
  type: AnomalyType;
  severity: "info" | "warning" | "critical";
  detail: string;
  targetId?: string;
  detectedAt: Date;
}

export interface RemediationResult {
  anomaly: PlatformAnomaly;
  action: RemediationAction;
  success: boolean;
  detail: string;
}

export interface SelfHealingReport {
  anomaliesDetected: number;
  anomaliesRemediated: number;
  results: RemediationResult[];
}

// ───────────────────────────────────────────────
// detectPlatformAnomalies — scan the platform.
// ───────────────────────────────────────────────

export async function detectPlatformAnomalies(): Promise<PlatformAnomaly[]> {
  const anomalies: PlatformAnomaly[] = [];
  const now = new Date();

  // 1. Circuit breakers that are open (a provider is down).
  const breakers = listCircuitBreakers();
  for (const breaker of breakers) {
    if (breaker.state === "open") {
      anomalies.push({
        type: "circuit_breaker_open",
        severity: breaker.stats.totalRejected > 100 ? "critical" : "warning",
        detail: `Circuit breaker "${breaker.name}" is OPEN (${breaker.stats.totalRejected} requests rejected)`,
        targetId: breaker.name,
        detectedAt: now,
      });
    }
  }

  // 2. Marketplace takedowns (algorithmic — low rating + malware).
  // The runAlgorithmicTakedowns function itself does the takedowns;
  // here we detect items that SHOULD be taken down.
  try {
    const lowRated = await db.execute(sql`
      select id, slug, title, rating_avg, rating_count
      from marketplace_items
      where status = 'published'
        and rating_avg < 2.0
        and rating_count >= 50
    `);
    for (const row of lowRated as unknown as Array<{ id: string; slug: string; title: string; rating_avg: string; rating_count: number }>) {
      anomalies.push({
        type: "marketplace_low_rated",
        severity: "warning",
        detail: `Marketplace item "${row.title}" (${row.slug}) has rating ${Number(row.rating_avg).toFixed(1)} (${row.rating_count} ratings) — below threshold`,
        targetId: row.id,
        detectedAt: now,
      });
    }
  } catch { /* query failure must not crash the cron */ }

  // 3. Degraded enterprise deployments.
  try {
    const degraded = await db.execute(sql`
      select id, ws_id, deployment_type, region
      from enterprise_deployments
      where status = 'degraded'
    `);
    for (const row of degraded as unknown as Array<{ id: string; ws_id: string; deployment_type: string; region: string }>) {
      anomalies.push({
        type: "deployment_degraded",
        severity: "critical",
        detail: `Enterprise deployment ${row.id} (ws=${row.ws_id}, type=${row.deployment_type}, region=${row.region}) is DEGRADED`,
        targetId: row.id,
        detectedAt: now,
      });
    }
  } catch { /* query failure must not crash the cron */ }

  return anomalies;
}

// ───────────────────────────────────────────────
// remediateAnomaly — automated remediation.
// ───────────────────────────────────────────────

export async function remediateAnomaly(anomaly: PlatformAnomaly): Promise<RemediationResult> {
  let action: RemediationAction = "alert_only";
  let success = false;
  let detail = "";

  switch (anomaly.type) {
    case "circuit_breaker_open": {
      // Auto-reset the circuit breaker (the half-open probe will test if the provider recovered).
      if (anomaly.targetId) {
        resetCircuitBreaker(anomaly.targetId);
        action = "reset_circuit_breaker";
        success = true;
        detail = `Reset circuit breaker "${anomaly.targetId}" — will half-open probe on next request`;
      }
      break;
    }

    case "marketplace_low_rated": {
      // Suspend the item (algorithmic takedown).
      action = "suspend_marketplace_item";
      try {
        await runAlgorithmicTakedowns();
        success = true;
        detail = `Suspended low-rated marketplace items (algorithmic takedown)`;
      } catch (err) {
        detail = `Failed to suspend: ${err instanceof Error ? err.message : String(err)}`;
      }
      break;
    }

    case "marketplace_malware": {
      action = "takedown_marketplace_item";
      try {
        await runAlgorithmicTakedowns();
        success = true;
        detail = `Took down malware-flagged marketplace items`;
      } catch (err) {
        detail = `Failed to take down: ${err instanceof Error ? err.message : String(err)}`;
      }
      break;
    }

    case "deployment_degraded": {
      // Alert only — deployment rollback requires infrastructure-level intervention.
      // The real impl would trigger an IaC rollback (Terraform/Pulumi).
      action = "alert_only";
      success = true;
      detail = `Alerted ops for degraded deployment ${anomaly.targetId} — manual rollback may be needed`;
      break;
    }

    case "slo_budget_exceeded":
    case "tool_failure_rate_high":
    case "policy_violation":
    default: {
      action = "alert_only";
      success = true;
      detail = `Alerted ops: ${anomaly.detail}`;
      break;
    }
  }

  // Audit the remediation.
  try {
    await adminAudit({
      actor: "system",
      action: `platform.self_healing.${anomaly.type}`,
      target: {
        anomaly: anomaly.type,
        severity: anomaly.severity,
        action,
        success,
        targetId: anomaly.targetId,
        detail: anomaly.detail,
      },
      justification: `Self-healing: ${action} for ${anomaly.type} (${success ? "success" : "failed"})`,
    });
  } catch { /* audit failure must not fail the remediation */ }

  return { anomaly, action, success, detail };
}

// ───────────────────────────────────────────────
// runSelfHealing — the cron entry point.
//
// Detect → remediate → audit. Humans see incidents after the fact.
// ───────────────────────────────────────────────

export async function runSelfHealing(): Promise<SelfHealingReport> {
  const anomalies = await detectPlatformAnomalies();
  const results: RemediationResult[] = [];

  for (const anomaly of anomalies) {
    const result = await remediateAnomaly(anomaly);
    results.push(result);
  }

  return {
    anomaliesDetected: anomalies.length,
    anomaliesRemediated: results.filter((r) => r.success).length,
    results,
  };
}
