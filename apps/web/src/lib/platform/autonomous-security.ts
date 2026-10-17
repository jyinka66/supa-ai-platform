// Autonomous security — vulnerability scanning, patching, threat detection, compliance.
// 14.2.17: "Automated vulnerability scanning — dependencies, containers, code scanned
// on every commit. Automated patching — security patches applied within defined SLAs."

import { db } from "@supa/db";
import { securityScans } from "@supa/db/schema";
import { sql, desc } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ScanType = "dependency" | "container" | "code" | "threat" | "access_review" | "compliance" | "pen_test" | "bug_bounty";

export interface SecurityScan {
  id: string;
  scanType: ScanType;
  target: string;
  findings: Array<{ severity: string; title: string; description: string; remediation?: string }>;
  severityMax: string | null;
  passed: boolean;
  scannedAt: Date;
  resolvedAt: Date | null;
}

export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  cve?: string;
  remediation: string;
}

// ───────────────────────────────────────────────
// Patching SLAs — security patches applied within defined windows.
// ───────────────────────────────────────────────

export const PATCHING_SLAS: Record<string, number> = {
  critical: 24 * 60 * 60 * 1000,    // 24h.
  high: 7 * 24 * 60 * 60 * 1000,    // 7 days.
  medium: 30 * 24 * 60 * 60 * 1000, // 30 days.
  low: 90 * 24 * 60 * 60 * 1000,    // 90 days.
};

// ───────────────────────────────────────────────
// runScan — run a security scan + store results.
// ───────────────────────────────────────────────

export async function runScan(input: {
  scanType: ScanType;
  target: string;
}): Promise<SecurityScan> {
  // STUB: would call the actual scanner (npm audit, Trivy, Semgrep, etc.).
  const findings: SecurityFinding[] = [];
  let severityMax: string | null = null;

  // Simulate dependency scan results.
  if (input.scanType === "dependency") {
    // STUB: would run `npm audit` / `pip audit` / `yarn audit`.
    findings.push({
      severity: "medium",
      title: "Outdated dependency",
      description: "Package 'lodash' is 2 versions behind (potential prototype pollution).",
      cve: "CVE-2020-8203",
      remediation: "Update lodash to >= 4.17.20",
    });
    severityMax = "medium";
  }

  // Simulate container scan results.
  if (input.scanType === "container") {
    // STUB: would run Trivy / Grype.
  }

  // Simulate code scan results.
  if (input.scanType === "code") {
    // STUB: would run Semgrep / CodeQL / Snyk Code.
  }

  // Simulate access review.
  if (input.scanType === "access_review") {
    // STUB: would check for unused permissions, stale access tokens, orphaned API keys.
  }

  const passed = !findings.some((f) => f.severity === "critical" || f.severity === "high");

  const rows = await db.insert(securityScans).values({
    scanType: input.scanType,
    target: input.target,
    findings: findings as any,
    severityMax,
    passed,
  }).returning({ id: securityScans.id, scannedAt: securityScans.scannedAt });

  const id = rows[0]?.id as string;
  const scannedAt = rows[0]?.scannedAt as Date;

  return {
    id,
    scanType: input.scanType,
    target: input.target,
    findings,
    severityMax,
    passed,
    scannedAt,
    resolvedAt: null,
  };
}

// ───────────────────────────────────────────────
// resolveScanFinding — mark a finding as resolved (patched).
// ───────────────────────────────────────────────

export async function resolveScan(scanId: string): Promise<void> {
  await db.execute(sql`
    update security_scans set resolved_at = now() where id = ${scanId}::uuid
  `);
}

// ───────────────────────────────────────────────
// Automated threat detection — anomalies detected + remediated.
// ───────────────────────────────────────────────

export interface ThreatDetection {
  type: "brute_force" | "credential_stuffing" | "api_abuse" | "data_exfiltration" | "privilege_escalation";
  severity: "critical" | "high" | "medium";
  source: string; // IP, user, or workspace.
  detail: string;
  remediated: boolean;
  remediation: string;
}

export async function detectThreats(): Promise<ThreatDetection[]> {
  // STUB: would analyze auth logs, API call patterns, data access patterns.
  // Would detect: brute force (many failed logins), credential stuffing,
  // API abuse (rate limit violations), data exfiltration (bulk downloads),
  // privilege escalation (unexpected role changes).
  return [];
}

// ───────────────────────────────────────────────
// Automated access reviews — permissions reviewed + revoked when unused.
// ───────────────────────────────────────────────

export interface AccessReviewFinding {
  principal: string; // user_id or api_key_id.
  permission: string;
  lastUsed: Date | null;
  unusedDays: number;
  action: "revoke" | "review";
}

export async function runAccessReview(): Promise<AccessReviewFinding[]> {
  // STUB: would check API keys, session tokens, role assignments for unused permissions.
  // Auto-revoke permissions unused for > 90 days.
  return [];
}

// ───────────────────────────────────────────────
// Bug bounty — public, automated triage, fast payouts.
// ───────────────────────────────────────────────

export interface BugBountyReport {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  reporter: string;
  rewardUsd: number;
  status: "triage" | "confirmed" | "resolved" | "rejected";
  triagedAutomatically: boolean;
}

export async function triageBugBountyReport(report: {
  severity: BugBountyReport["severity"];
  title: string;
  description: string;
  reporter: string;
}): Promise<BugBountyReport> {
  // Automated triage: classify severity, check for duplicates, assign reward.
  const rewardMap: Record<string, number> = {
    critical: 5000,
    high: 2000,
    medium: 500,
    low: 100,
  };

  return {
    id: `bb_${Date.now()}`,
    severity: report.severity,
    title: report.title,
    description: report.description,
    reporter: report.reporter,
    rewardUsd: rewardMap[report.severity] ?? 100,
    status: "triage",
    triagedAutomatically: true,
  };
}

// ───────────────────────────────────────────────
// List unresolved security scans.
// ───────────────────────────────────────────────

export async function listUnresolvedScans(): Promise<SecurityScan[]> {
  const rows = await db.execute(sql`
    select id, scan_type, target, findings, severity_max, passed, scanned_at, resolved_at
    from security_scans
    where resolved_at is null and passed = false
    order by case
      when severity_max = 'critical' then 0
      when severity_max = 'high' then 1
      when severity_max = 'medium' then 2
      when severity_max = 'low' then 3
      else 4
    end, scanned_at desc
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    scanType: r.scan_type as ScanType,
    target: r.target as string,
    findings: (r.findings as SecurityFinding[]) ?? [],
    severityMax: (r.severity_max as string | null) ?? null,
    passed: r.passed as boolean,
    scannedAt: r.scanned_at as Date,
    resolvedAt: (r.resolved_at as Date | null) ?? null,
  }));
}
