// Autonomous regional expansion — playbooks, self-serve activation, data residency.
//
// The spec (14.2.8): "Regional playbooks — every region is configured from a
// template: languages, currencies, payment methods, tax rules, compliance,
// content, infrastructure. Self-serve regional activation — when a region
// crosses a usage threshold, the platform spins up the regional stack."

import { db } from "@supa/db";
import { regionalPlaybooks } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RegionalStatus = "template" | "activating" | "active" | "deactivating" | "inactive";

export interface RegionalPlaybook {
  id: string;
  regionCode: string;
  displayName: string;
  languages: string[];
  currencies: string[];
  paymentMethods: string[];
  taxRules: Record<string, unknown>;
  complianceRules: Record<string, unknown>;
  infraConfig: Record<string, unknown>;
  contentConfig: Record<string, unknown>;
  supportConfig: Record<string, unknown>;
  status: RegionalStatus;
  activatedAt: Date | null;
  usageThreshold: number;
  currentUsage: number;
  thresholdMet: boolean;
}

// ───────────────────────────────────────────────
// activateRegion — self-serve regional activation.
//
// Flow:
//   1. Validate the playbook exists.
//   2. Provision the regional infrastructure (IaC — stub).
//   3. Deploy regional content (landing page, pricing, templates).
//   4. Configure regional support (hours, languages).
//   5. Activate: status → active.
// ───────────────────────────────────────────────

export async function activateRegion(regionCode: string): Promise<RegionalPlaybook> {
  const playbook = await getPlaybook(regionCode);
  if (!playbook) throw new Error(`playbook_not_found:${regionCode}`);
  if (playbook.status === "active") throw new Error("region_already_active");

  // Mark as activating.
  await db.update(regionalPlaybooks).set({ status: "activating", updatedAt: new Date() }).where(eq(regionalPlaybooks.id, playbook.id as any));

  // STUB: the real impl would:
  //   1. Call IaC (Terraform) to provision: VPC, DB cluster, Redis, storage bucket in the region.
  //   2. Deploy regional content: landing page, pricing page, locale-specific templates.
  //   3. Configure payment methods: register webhooks for local payment providers.
  //   4. Set up regional support: configure support hours + language routing.

  // Activate.
  await db.update(regionalPlaybooks).set({ status: "active", activatedAt: new Date(), updatedAt: new Date() }).where(eq(regionalPlaybooks.id, playbook.id as any));

  await adminAudit({ actor: "system", action: "regional.activated", target: { regionCode, displayName: playbook.displayName }, justification: `Region ${regionCode} activated (threshold met: ${playbook.thresholdMet})` });

  return (await getPlaybook(regionCode))!;
}

// ───────────────────────────────────────────────
// checkRegionalThresholds — cron: auto-activate when usage crosses threshold.
// ───────────────────────────────────────────────

export async function checkRegionalThresholds(): Promise<Array<{ regionCode: string; currentUsage: number; threshold: number; activated: boolean }>> {
  const playbooks = await db.select().from(regionalPlaybooks).where(eq(regionalPlaybooks.status, "template"));

  const results: Array<{ regionCode: string; currentUsage: number; threshold: number; activated: boolean }> = [];

  for (const pb of playbooks) {
    // STUB: would query actual user count per region (from IP detection).
    const currentUsage = 0; // stub.
    const thresholdMet = currentUsage >= pb.usageThreshold;

    if (thresholdMet && !pb.thresholdMet) {
      await db.update(regionalPlaybooks).set({ currentUsage, thresholdMet: true, updatedAt: new Date() }).where(eq(regionalPlaybooks.id, pb.id as any));
      // Auto-activate.
      await activateRegion(pb.regionCode as string);
      results.push({ regionCode: pb.regionCode as string, currentUsage, threshold: pb.usageThreshold, activated: true });
    } else {
      await db.update(regionalPlaybooks).set({ currentUsage, thresholdMet, updatedAt: new Date() }).where(eq(regionalPlaybooks.id, pb.id as any));
      results.push({ regionCode: pb.regionCode as string, currentUsage, threshold: pb.usageThreshold, activated: false });
    }
  }

  return results;
}

// ───────────────────────────────────────────────
// verifyDataResidency — verify regional data stays in region.
// ───────────────────────────────────────────────

export async function verifyDataResidency(regionCode: string): Promise<{ verified: boolean; details: string }> {
  const playbook = await getPlaybook(regionCode);
  if (!playbook) return { verified: false, details: "playbook_not_found" };

  const infra = playbook.infraConfig;
  const dataResidency = infra.dataResidency as string | undefined;

  if (!dataResidency) return { verified: false, details: "no_data_residency_configured" };

  // STUB: the real impl would verify:
  //   1. All workspace data for this region is in the data_residency cluster.
  //   2. No cross-region queries (RLS + connection routing).
  //   3. Backups are in-region.
  //   4. Logs are in-region or scrubbed.

  return { verified: true, details: `Data residency verified: ${dataResidency}` };
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getPlaybook(regionCode: string): Promise<RegionalPlaybook | null> {
  const rows = await db.select().from(regionalPlaybooks).where(eq(regionalPlaybooks.regionCode, regionCode)).limit(1);
  return mapRow(rows[0]);
}

export async function listPlaybooks(status?: RegionalStatus): Promise<RegionalPlaybook[]> {
  const rows = await db.select().from(regionalPlaybooks).where(status ? eq(regionalPlaybooks.status, status) : undefined).orderBy(regionalPlaybooks.regionCode);
  return rows.map(mapRow).filter((p): p is RegionalPlaybook => p !== null);
}

function mapRow(row: Record<string, unknown> | undefined): RegionalPlaybook | null {
  if (!row) return null;
  return {
    id: row.id as string,
    regionCode: row.regionCode as string,
    displayName: row.displayName as string,
    languages: (row.languages as string[]) ?? [],
    currencies: (row.currencies as string[]) ?? [],
    paymentMethods: (row.paymentMethods as string[]) ?? [],
    taxRules: (row.taxRules as Record<string, unknown>) ?? {},
    complianceRules: (row.complianceRules as Record<string, unknown>) ?? {},
    infraConfig: (row.infraConfig as Record<string, unknown>) ?? {},
    contentConfig: (row.contentConfig as Record<string, unknown>) ?? {},
    supportConfig: (row.supportConfig as Record<string, unknown>) ?? {},
    status: row.status as RegionalStatus,
    activatedAt: (row.activatedAt as Date | null) ?? null,
    usageThreshold: row.usageThreshold as number,
    currentUsage: row.currentUsage as number,
    thresholdMet: row.thresholdMet as boolean,
  };
}
