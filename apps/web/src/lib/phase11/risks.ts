// Risk Registry (11.8) — risk catalog with mitigation status.
//
// The spec defines 14 risks with mitigations. These are tracked in the
// risk_registry table (seeded in migration 0056). This module provides the
// query/management service.

import { db } from "@supa/db";
import { riskRegistry } from "@supa/db/schema";
import { eq } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type RiskMitigationStatus = "implemented" | "in_progress" | "planned" | "not_started";

export interface Risk {
  id: string;
  riskId: string;
  category: string;
  title: string;
  description: string;
  mitigation: string;
  mitigationStatus: RiskMitigationStatus;
  owner: string;
  lastReviewedAt: Date | null;
  createdAt: Date;
}

// ───────────────────────────────────────────────
// Queries.
// ───────────────────────────────────────────────

export async function listRisks(opts: {
  category?: string;
  status?: RiskMitigationStatus;
} = {}): Promise<Risk[]> {
  const conditions = [];
  if (opts.category) conditions.push(eq(riskRegistry.category, opts.category));
  if (opts.status) conditions.push(eq(riskRegistry.mitigationStatus, opts.status));

  const rows = await db
    .select()
    .from(riskRegistry)
    .where(conditions.length > 0 ? (await import("drizzle-orm")).and(...conditions) : undefined)
    .orderBy(riskRegistry.category, riskRegistry.riskId);

  return rows.map((row) => ({
    id: row.id as string,
    riskId: row.riskId,
    category: row.category,
    title: row.title,
    description: row.description,
    mitigation: row.mitigation,
    mitigationStatus: row.mitigationStatus as RiskMitigationStatus,
    owner: row.owner,
    lastReviewedAt: row.lastReviewedAt ?? null,
    createdAt: row.createdAt,
  }));
}

export async function getRisk(riskId: string): Promise<Risk | null> {
  const rows = await db
    .select()
    .from(riskRegistry)
    .where(eq(riskRegistry.riskId, riskId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    riskId: row.riskId,
    category: row.category,
    title: row.title,
    description: row.description,
    mitigation: row.mitigation,
    mitigationStatus: row.mitigationStatus as RiskMitigationStatus,
    owner: row.owner,
    lastReviewedAt: row.lastReviewedAt ?? null,
    createdAt: row.createdAt,
  };
}

export async function getRiskSummary(): Promise<{
  total: number;
  implemented: number;
  inProgress: number;
  planned: number;
  notStarted: number;
}> {
  const all = await listRisks();
  return {
    total: all.length,
    implemented: all.filter((r) => r.mitigationStatus === "implemented").length,
    inProgress: all.filter((r) => r.mitigationStatus === "in_progress").length,
    planned: all.filter((r) => r.mitigationStatus === "planned").length,
    notStarted: all.filter((r) => r.mitigationStatus === "not_started").length,
  };
}
