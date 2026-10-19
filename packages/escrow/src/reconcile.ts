// Every 24h, three-way reconciliation:
//   1. Ledger self-check: sum of debits === sum of credits per
//      currency, per ws, platform-wide. Any drift → CRITICAL.
//   2. Ledger ↔ provider: every in_transit/initiated payout has
//      a matching provider object; every provider hold/capture
//      has a matching ledger entry. Mismatches → ops alert.
//   3. Ledger ↔ milestones: every "paid" milestone has a release;
//      every release leg has a paid milestone. Orphans
//      are impossible by construction, but we check anyway —
//      trust is verified, not assumed.
// The report lands as an activity fact in the ops workspace.
// A clean day is a fact; a dirty day is a page.

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import { LedgerEntry } from "./ledger.js";

// FIX: inlined helper (same pattern as all files).
async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

// ───────────────────────────────────────────────
// Severity — the report's urgency
// ───────────────────────────────────────────────

export const ReconciliationSeverity = z.enum([
  "clean",       // all checks passed — a clean day is a fact
  "warning",     // ops alert — mismatches found, not critical
  "critical",    // ledger drift — money integrity at stake
]);

export type ReconciliationSeverity = z.infer<typeof ReconciliationSeverity>;

// ───────────────────────────────────────────────
// Check result — one per check
// ───────────────────────────────────────────────

export interface ReconciliationCheck {
  readonly name: string;
  readonly severity: ReconciliationSeverity;
  readonly passed: boolean;
  readonly details: string;
  readonly mismatches: readonly { id: string; description: string }[];
}

// ───────────────────────────────────────────────
// Reconciliation report — the daily page
// ───────────────────────────────────────────────

export const ReconciliationReport = z.object({
  id: z.string().uuid(),
  runAt: z.string().datetime(),
  overallSeverity: ReconciliationSeverity,
  checks: z.array(z.object({
    name: z.string(),
    severity: ReconciliationSeverity,
    passed: z.boolean(),
    details: z.string(),
    mismatches: z.array(z.object({
      id: z.string(),
      description: z.string(),
    })),
  })),
  cleanDay: z.boolean(),            // true if overallSeverity === "clean"
});

export type ReconciliationReport = z.infer<typeof ReconciliationReport>;

// ───────────────────────────────────────────────
// Check 1: Ledger self-check — sum of debits === sum of credits
// ───────────────────────────────────────────────

/**
 * Check that for every currency + workspace, the sum of debit
 * entries equals the sum of credit entries. Any drift means money
 * was created or destroyed — CRITICAL.
 *
 * In a correct double-entry ledger, every transaction has a debit
 * leg and a credit leg of equal amount. The sum of ALL debits must
 * equal the sum of ALL credits, per currency, per workspace.
 */
export function checkLedgerSelfBalance(
  entries: readonly LedgerEntry[],
): ReconciliationCheck {
  const byWsCurrency = new Map<string, { debits: bigint; credits: bigint }>();

  for (const entry of entries) {
    const money = entry.debit ?? entry.credit;
    if (!money) continue;
    const key = `${entry.wsId}|${money.currency}`;
    const current = byWsCurrency.get(key) ?? { debits: 0n, credits: 0n };
    if (entry.debit) {
      current.debits += BigInt(entry.debit.amountMinor);
    }
    if (entry.credit) {
      current.credits += BigInt(entry.credit.amountMinor);
    }
    byWsCurrency.set(key, current);
  }

  const mismatches: { id: string; description: string }[] = [];
  for (const [key, { debits, credits }] of byWsCurrency) {
    if (debits !== credits) {
      mismatches.push({
        id: key,
        description: `debits (${String(debits)}) !== credits (${String(credits)}), delta = ${String(debits - credits)}`,
      });
    }
  }

  const passed = mismatches.length === 0;
  return {
    name: "ledger_self_balance",
    severity: passed ? "clean" : "critical",
    passed,
    details: passed
      ? "sum of debits === sum of credits per currency, per ws — balanced"
      : `${String(mismatches.length)} currency/ws pair(s) out of balance — CRITICAL: money integrity at stake`,
    mismatches,
  };
}

// ───────────────────────────────────────────────
// Check 2: Ledger ↔ provider — payouts match provider objects
// ───────────────────────────────────────────────

export interface ProviderRecord {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;  // "confirmed" | "failed" | "in_transit"
}

/**
 * Check that every in_transit/initiated payout in the ledger has
 * a matching provider object, and every provider hold/capture has
 * a matching ledger entry. Mismatches → ops alert (not critical —
 * the ledger is the source of truth; provider drift is recoverable).
 */
export function checkLedgerProviderSync(
  entries: readonly LedgerEntry[],
  providerRecords: readonly ProviderRecord[],
): ReconciliationCheck {
  // Ledger payouts: entries with type payout_initiated or payout_confirmed.
  const ledgerPayouts = new Set(
    entries
      .filter((e) => e.type === "payout_initiated" || e.type === "payout_confirmed")
      .map((e) => e.idempotencyKey),
  );

  // Provider records: every record should have a matching ledger entry.
  const providerIds = new Set(providerRecords.map((r) => r.id));

  const mismatches: { id: string; description: string }[] = [];

  // Ledger entries without a matching provider record.
  for (const key of ledgerPayouts) {
    if (!providerIds.has(key)) {
      mismatches.push({
        id: key,
        description: "ledger payout entry has no matching provider record",
      });
    }
  }

  // Provider records without a matching ledger entry.
  for (const record of providerRecords) {
    if (!ledgerPayouts.has(record.id)) {
      mismatches.push({
        id: record.id,
        description: `provider record (status: ${record.status}) has no matching ledger entry`,
      });
    }
  }

  const passed = mismatches.length === 0;
  return {
    name: "ledger_provider_sync",
    severity: passed ? "clean" : "warning",
    passed,
    details: passed
      ? "every in_transit payout has a provider record; every provider record has a ledger entry"
      : `${String(mismatches.length)} mismatches between ledger and provider records — ops alert`,
    mismatches,
  };
}

// ───────────────────────────────────────────────
// Check 3: Ledger ↔ milestones — paid milestones have releases
// ───────────────────────────────────────────────

export interface MilestoneRecord {
  readonly id: string;
  readonly status: string;  // "paid" | "approved" | etc.
  readonly contractId: string;
}

/**
 * Check that every "paid" milestone has a corresponding release
 * entry in the ledger, and every release entry has a paid milestone.
 * Orphans are impossible by construction (the release function
 * transitions the milestone to "paid" in the same tx), but we
 * check anyway — trust is verified, not assumed.
 */
export function checkLedgerMilestoneSync(
  entries: readonly LedgerEntry[],
  milestones: readonly MilestoneRecord[],
): ReconciliationCheck {
  // Release entries reference milestone IDs via refId.
  const releaseEntries = new Set(
    entries
      .filter((e) => e.type === "escrow_released" && e.refType === "milestone")
      .map((e) => e.refId),
  );

  const paidMilestones = new Set(
    milestones.filter((m) => m.status === "paid").map((m) => m.id),
  );

  const mismatches: { id: string; description: string }[] = [];

  // Paid milestones without a release entry.
  for (const milestoneId of paidMilestones) {
    if (!releaseEntries.has(milestoneId)) {
      mismatches.push({
        id: milestoneId,
        description: "paid milestone has no release ledger entry — orphan",
      });
    }
  }

  // Release entries without a paid milestone.
  for (const milestoneId of releaseEntries) {
    if (!paidMilestones.has(milestoneId)) {
      mismatches.push({
        id: milestoneId,
        description: "release ledger entry has no paid milestone — orphan",
      });
    }
  }

  const passed = mismatches.length === 0;
  return {
    name: "ledger_milestone_sync",
    severity: passed ? "clean" : "critical",
    passed,
    details: passed
      ? "every paid milestone has a release; every release has a paid milestone"
      : `${String(mismatches.length)} orphan(s) — should be impossible by construction`,
    mismatches,
  };
}

// ───────────────────────────────────────────────
// runReconciliation — the daily page
// ───────────────────────────────────────────────

const OPS_WS = "00000000-0000-0000-0000-000000000000"; // platform ops workspace

/**
 * Run the daily three-way reconciliation. The report lands as an
 * activity fact in the ops workspace.
 *
 *   A clean day is a fact; a dirty day is a page.
 */
export async function runReconciliation(
  ledgerEntries: readonly LedgerEntry[],
  providerRecords: readonly ProviderRecord[],
  milestones: readonly MilestoneRecord[],
  now: string = new Date().toISOString(),
): Promise<ReconciliationReport> {
  const checks: ReconciliationCheck[] = [
    checkLedgerSelfBalance(ledgerEntries),
    checkLedgerProviderSync(ledgerEntries, providerRecords),
    checkLedgerMilestoneSync(ledgerEntries, milestones),
  ];

  // Overall severity = worst check's severity.
  const severityRank: Record<ReconciliationSeverity, number> = {
    clean: 0,
    warning: 1,
    critical: 2,
  };
  const overall = checks.reduce<ReconciliationSeverity>(
    (worst, check) => severityRank[check.severity] > severityRank[worst] ? check.severity : worst,
    "clean",
  );

  const report: ReconciliationReport = {
    id: crypto.randomUUID(),
    runAt: now,
    overallSeverity: overall,
    checks: checks.map((c) => ({
      name: c.name,
      severity: c.severity,
      passed: c.passed,
      details: c.details,
      mismatches: [...c.mismatches],
    })),
    cleanDay: overall === "clean",
  };

  // The report lands as an activity fact in the ops workspace.
  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: OPS_WS,
      kind: "supa.reconciliation.daily",
      ref: {
        reportId: report.id,
        overallSeverity: report.overallSeverity,
        cleanDay: report.cleanDay,
        checkCount: report.checks.length,
        mismatchCount: report.checks.reduce((sum, c) => sum + c.mismatches.length, 0),
      },
    });
  });

  return report;
}
