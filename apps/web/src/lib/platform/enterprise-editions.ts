// Autonomous enterprise editions — licenses, SLAs, compliance automation, QBRs.
//
// The spec (14.2.10): "Deployment templates — VPC, on-prem, and dedicated capacity
// are provisioned from infrastructure-as-code templates. License enforcement —
// self-hosted installs use license keys with entitlement checks. Custom SLAs —
// SLA terms defined per customer, monitored automatically. Compliance automation —
// SOC 2, HIPAA, GDPR evidence collected and reported automatically."

import { db } from "@supa/db";
import { enterpriseLicenses, enterpriseSlas, complianceEvidence } from "@supa/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type LicenseEdition = "standard" | "enterprise" | "enterprise_plus";
export type LicenseStatus = "active" | "expired" | "suspended" | "revoked";
export type ComplianceFramework = "soc2" | "hipaa" | "gdpr" | "iso27001" | "pci_dss" | "fedramp";

export interface EnterpriseLicense {
  id: string;
  licenseKeyHash: string;
  wsId: string;
  deploymentId: string | null;
  edition: LicenseEdition;
  maxSeats: number;
  maxApiCallsPerDay: number;
  features: string[];
  expiresAt: Date | null;
  status: LicenseStatus;
  lastVerifiedAt: Date | null;
}

export interface EnterpriseSla {
  id: string;
  wsId: string;
  uptimeTarget: number;
  responseTimeP95Ms: number;
  supportResponseTimeHrs: number;
  resolutionTimeHrs: number;
  currentUptime: number;
  currentP95Ms: number | null;
  lastIncidentAt: Date | null;
  creditPolicy: Record<string, unknown>;
}

export interface ComplianceEvidenceRecord {
  id: string;
  wsId: string | null;
  framework: ComplianceFramework;
  controlId: string;
  evidenceType: string;
  evidenceData: Record<string, unknown>;
  collectedAt: Date;
  verified: boolean;
  expiresAt: Date | null;
}

// ───────────────────────────────────────────────
// License management.
// ───────────────────────────────────────────────

/** Generate a license key (returned only once — the hash is stored). */
export function generateLicenseKey(): string {
  return `lic_${randomBytes(32).toString("base64url")}`;
}

/** Create a license for a workspace. */
export async function createLicense(input: {
  wsId: string;
  deploymentId?: string;
  edition: LicenseEdition;
  maxSeats?: number;
  maxApiCallsPerDay?: number;
  features?: string[];
  expiresAt?: Date;
}): Promise<{ licenseKey: string; licenseId: string }> {
  const licenseKey = generateLicenseKey();
  const licenseKeyHash = createHash("sha256").update(licenseKey).digest("hex");

  const editionDefaults: Record<LicenseEdition, { maxSeats: number; maxApiCallsPerDay: number; features: string[] }> = {
    standard: { maxSeats: 50, maxApiCallsPerDay: 100000, features: ["agents", "connectors"] },
    enterprise: { maxSeats: 500, maxApiCallsPerDay: 1000000, features: ["agents", "connectors", "sso", "audit_log", "custom_roles"] },
    enterprise_plus: { maxSeats: 10000, maxApiCallsPerDay: 10000000, features: ["agents", "connectors", "sso", "audit_log", "custom_roles", "dedicated", "on_prem", "custom_sla"] },
  };

  const defaults = editionDefaults[input.edition];

  const rows = await db.insert(enterpriseLicenses).values({
    licenseKeyHash,
    workspaceId: input.wsId as any,
    ...(input.deploymentId ? { deploymentId: input.deploymentId as any } : {}),
    edition: input.edition,
    maxSeats: input.maxSeats ?? defaults.maxSeats,
    maxApiCallsPerDay: input.maxApiCallsPerDay ?? defaults.maxApiCallsPerDay,
    features: input.features ?? defaults.features,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }).returning({ id: enterpriseLicenses.id });

  const licenseId = rows[0]?.id as string;
  if (!licenseId) throw new Error("license_insert_failed");

  await adminAudit({ actor: "system", action: "enterprise.license.created", target: { wsId: input.wsId, edition: input.edition }, justification: `License created (${input.edition} edition)` });

  return { licenseKey, licenseId };
}

/** Verify a license key (entitlement check). */
export async function verifyLicense(licenseKey: string): Promise<{ valid: boolean; license: EnterpriseLicense | null }> {
  const hash = createHash("sha256").update(licenseKey).digest("hex");
  const rows = await db.select().from(enterpriseLicenses).where(eq(enterpriseLicenses.licenseKeyHash, hash)).limit(1);
  const row = rows[0];
  if (!row) return { valid: false, license: null };

  const license: EnterpriseLicense = {
    id: row.id as string,
    licenseKeyHash: row.licenseKeyHash,
    wsId: row.workspaceId as string,
    deploymentId: (row.deploymentId as string | null) ?? null,
    edition: row.edition as LicenseEdition,
    maxSeats: row.maxSeats,
    maxApiCallsPerDay: row.maxApiCallsPerDay,
    features: (row.features as string[]) ?? [],
    expiresAt: row.expiresAt,
    status: row.status as LicenseStatus,
    lastVerifiedAt: row.lastVerifiedAt,
  };

  // Check expiry.
  const expired = license.expiresAt != null && license.expiresAt < new Date();
  const valid = license.status === "active" && !expired;

  // Update last_verified_at.
  await db.update(enterpriseLicenses).set({ lastVerifiedAt: new Date() }).where(eq(enterpriseLicenses.id, license.id as any));

  return { valid, license: valid ? license : { ...license, status: expired ? "expired" : license.status } };
}

// ───────────────────────────────────────────────
// Custom SLAs.
// ───────────────────────────────────────────────

export async function createSla(input: {
  wsId: string;
  uptimeTarget?: number;
  responseTimeP95Ms?: number;
  supportResponseTimeHrs?: number;
  resolutionTimeHrs?: number;
  creditPolicy?: Record<string, unknown>;
}): Promise<EnterpriseSla> {
  const rows = await db.insert(enterpriseSlas).values({
    workspaceId: input.wsId as any,
    uptimeTarget: (input.uptimeTarget ?? 0.9999).toString(),
    responseTimeP95Ms: input.responseTimeP95Ms ?? 300,
    supportResponseTimeHrs: input.supportResponseTimeHrs ?? 1,
    resolutionTimeHrs: input.resolutionTimeHrs ?? 4,
    creditPolicy: input.creditPolicy ?? { breach_pct: 10, max_credit_pct: 50 },
  }).returning({ id: enterpriseSlas.id });

  const id = rows[0]?.id as string;
  if (!id) throw new Error("sla_insert_failed");
  return (await getSla(id))!;
}

export async function getSla(id: string): Promise<EnterpriseSla | null> {
  const rows = await db.select().from(enterpriseSlas).where(eq(enterpriseSlas.id, id as any)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    wsId: row.workspaceId as string,
    uptimeTarget: Number(row.uptimeTarget),
    responseTimeP95Ms: row.responseTimeP95Ms,
    supportResponseTimeHrs: row.supportResponseTimeHrs,
    resolutionTimeHrs: row.resolutionTimeHrs,
    currentUptime: Number(row.currentUptime),
    currentP95Ms: row.currentP95Ms ?? null,
    lastIncidentAt: row.lastIncidentAt,
    creditPolicy: (row.creditPolicy as Record<string, unknown>) ?? {},
  };
}

export async function getSlaByWs(wsId: string): Promise<EnterpriseSla | null> {
  const rows = await db.select().from(enterpriseSlas).where(eq(enterpriseSlas.workspaceId, wsId as any)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    wsId: row.workspaceId as string,
    uptimeTarget: Number(row.uptimeTarget),
    responseTimeP95Ms: row.responseTimeP95Ms,
    supportResponseTimeHrs: row.supportResponseTimeHrs,
    resolutionTimeHrs: row.resolutionTimeHrs,
    currentUptime: Number(row.currentUptime),
    currentP95Ms: row.currentP95Ms ?? null,
    lastIncidentAt: row.lastIncidentAt,
    creditPolicy: (row.creditPolicy as Record<string, unknown>) ?? {},
  };
}

// ───────────────────────────────────────────────
// Compliance evidence — automated collection.
// ───────────────────────────────────────────────

export async function collectEvidence(input: {
  wsId?: string;
  framework: ComplianceFramework;
  controlId: string;
  evidenceType: "config" | "log" | "screenshot" | "report" | "test_result";
  evidenceData: Record<string, unknown>;
  expiresAt?: Date;
}): Promise<ComplianceEvidenceRecord> {
  const rows = await db.insert(complianceEvidence).values({
    ...(input.wsId ? { workspaceId: input.wsId as any } : {}),
    framework: input.framework,
    controlId: input.controlId,
    evidenceType: input.evidenceType,
    evidenceData: input.evidenceData as any,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }).returning({ id: complianceEvidence.id, collectedAt: complianceEvidence.collectedAt });

  const id = rows[0]?.id as string;
  const collectedAt = rows[0]?.collectedAt as Date;
  if (!id) throw new Error("evidence_insert_failed");

  return {
    id,
    wsId: input.wsId ?? null,
    framework: input.framework,
    controlId: input.controlId,
    evidenceType: input.evidenceType,
    evidenceData: input.evidenceData,
    collectedAt,
    verified: false,
    expiresAt: input.expiresAt ?? null,
  };
}

export async function listEvidence(opts: {
  wsId?: string;
  framework?: ComplianceFramework;
} = {}): Promise<ComplianceEvidenceRecord[]> {
  const conditions = [];
  if (opts.wsId) conditions.push(eq(complianceEvidence.workspaceId, opts.wsId as any));
  if (opts.framework) conditions.push(eq(complianceEvidence.framework, opts.framework));

  const rows = await db.select().from(complianceEvidence).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(complianceEvidence.collectedAt));

  return rows.map((row) => ({
    id: row.id as string,
    wsId: (row.workspaceId as string | null) ?? null,
    framework: row.framework as ComplianceFramework,
    controlId: row.controlId,
    evidenceType: row.evidenceType,
    evidenceData: (row.evidenceData as Record<string, unknown>) ?? {},
    collectedAt: row.collectedAt,
    verified: row.verified,
    expiresAt: row.expiresAt,
  }));
}

// ───────────────────────────────────────────────
// Quarterly business reviews (QBR) — automated reports.
// ───────────────────────────────────────────────

export async function generateQbr(wsId: string): Promise<{
  wsId: string;
  period: string;
  usage: { totalApiCalls: number; totalCostUsd: number; activeUsers: number };
  sla: EnterpriseSla | null;
  license: EnterpriseLicense | null;
  compliance: { framework: string; controlsCovered: number; verified: number }[];
}> {
  // Fetch SLA + license + compliance evidence for this workspace.
  const [sla, licenseRows, evidenceRows] = await Promise.all([
    getSlaByWs(wsId),
    db.select().from(enterpriseLicenses).where(eq(enterpriseLicenses.workspaceId, wsId as any)).limit(1),
    listEvidence({ wsId }),
  ]);

  const license = licenseRows[0] ? {
    id: licenseRows[0].id as string,
    licenseKeyHash: licenseRows[0].licenseKeyHash,
    wsId: licenseRows[0].workspaceId as string,
    deploymentId: (licenseRows[0].deploymentId as string | null) ?? null,
    edition: licenseRows[0].edition as LicenseEdition,
    maxSeats: licenseRows[0].maxSeats,
    maxApiCallsPerDay: licenseRows[0].maxApiCallsPerDay,
    features: (licenseRows[0].features as string[]) ?? [],
    expiresAt: licenseRows[0].expiresAt,
    status: licenseRows[0].status as LicenseStatus,
    lastVerifiedAt: licenseRows[0].lastVerifiedAt,
  } : null;

  // Aggregate compliance by framework.
  const frameworks = new Map<string, { controls: number; verified: number }>();
  for (const ev of evidenceRows) {
    const f = frameworks.get(ev.framework) ?? { controls: 0, verified: 0 };
    f.controls++;
    if (ev.verified) f.verified++;
    frameworks.set(ev.framework, f);
  }

  const compliance = Array.from(frameworks.entries()).map(([framework, data]) => ({
    framework,
    controlsCovered: data.controls,
    verified: data.verified,
  }));

  return {
    wsId,
    period: new Date().toISOString(),
    usage: { totalApiCalls: 0, totalCostUsd: 0, activeUsers: 0 }, // stub — would aggregate from tool_usage_stats.
    sla,
    license,
    compliance,
  };
}
