/**
 * @supa/expenses/recurring
 * ----------------------------------------------------------------
 * Recurring expenses: rent, subscriptions, salaries. Same
 *   generator pattern as recurring invoices — one scheduler,
 *   two consumers (the schedule engine is shared infrastructure,
 *   not duplicated): cron fires, materializes the next instance
 *   as a draft for confirmation if amounts vary (salary with a
 *   bonus line), auto-records if identical and confirmed by user
 *   at setup. Missed-run recovery: idempotent per period key —
 *   a server restart never double-charges March's rent.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Money } from "@supa/money/money";

// ───────────────────────────────────────────────
// Recurrence frequency
// ───────────────────────────────────────────────

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

// ───────────────────────────────────────────────
// Recurring rule — the template
// ───────────────────────────────────────────────

/**
 * A recurring expense rule. The rule is a TEMPLATE — it doesn't
 * create expenses directly; the scheduler materializes instances
 * based on the rule's frequency + start date.
 *
 *   amountMode:
 *     "fixed" — every instance has the same amount (e.g. rent).
 *       Auto-records (no confirmation needed) if the user confirmed
 *       at setup.
 *     "variable" — amount may vary (e.g. salary with a bonus line).
 *       Materializes as a draft for confirmation.
 *
 *   periodKey — idempotency key per period. "2024-03" for monthly
 *   March rent. A server restart never double-charges March's rent
 *   because the period key is unique — the second run is a no-op.
 */
export interface RecurringExpenseRule {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  readonly merchant: string;
  readonly amount: Money;
  readonly category: string;
  readonly taxDeductible: boolean;
  readonly taxRate: string | null;
  readonly frequency: RecurrenceFrequency;
  /** Start date (ms epoch) — first instance is on or after this. */
  readonly startDate: number;
  /** End date (null = open-ended). */
  readonly endDate: number | null;
  readonly amountMode: "fixed" | "variable";
  /** Whether to auto-record fixed-amount instances (no confirmation). */
  readonly autoRecord: boolean;
  readonly createdBy: string;
  readonly createdAt: number;
  /** Active or paused. */
  readonly active: boolean;
}

// ───────────────────────────────────────────────
// Period key — idempotency
// ───────────────────────────────────────────────

/**
 * Compute the period key for a given date + frequency. Used as the
 * idempotency key — a server restart never double-charges March's
 * rent because "2024-03" is unique.
 *
 *   daily:   "2024-03-15"
 *   weekly:  "2024-W11"
 *   monthly: "2024-03"
 *   yearly:  "2024"
 */
export function computePeriodKey(date: number, frequency: RecurrenceFrequency): string {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  switch (frequency) {
    case "daily":
      return `${year}-${month}-${day}`;
    case "weekly": {
      const weekNum = getISOWeek(d);
      return `${year}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "monthly":
      return `${year}-${month}`;
    case "yearly":
      return `${year}`;
  }
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

// ───────────────────────────────────────────────
// Instance materialization — the scheduler's job
// ───────────────────────────────────────────────

/**
 * A materialized instance of a recurring rule. The scheduler
 * produces these; the consumer either auto-records (fixed + autoRecord)
 * or creates a draft for confirmation (variable).
 */
export interface RecurringInstance {
  readonly ruleId: string;
  readonly periodKey: string;
  /** The date this instance is due (ms epoch). */
  readonly dueDate: number;
  /** Whether to auto-record or create a draft for confirmation. */
  readonly requiresConfirmation: boolean;
}

/**
 * Materialize the next instance of a recurring rule for a given
 * target date. Returns null if the rule is paused, ended, or the
 * target date is before the start date.
 *
 * The caller (scheduler) checks if an instance with this periodKey
 * already exists — if so, it's a no-op (idempotent). Missed-run
 * recovery: a server restart never double-charges.
 */
export function materializeInstance(
  rule: RecurringExpenseRule,
  targetDate: number,
): RecurringInstance | null {
  if (!rule.active) return null;
  if (targetDate < rule.startDate) return null;
  if (rule.endDate !== null && targetDate > rule.endDate) return null;

  const periodKey = computePeriodKey(targetDate, rule.frequency);
  const requiresConfirmation = rule.amountMode === "variable" || !rule.autoRecord;

  return {
    ruleId: rule.id,
    periodKey,
    dueDate: targetDate,
    requiresConfirmation,
  };
}

/**
 * Compute the next due date for a recurring rule, given the last
 * materialized date (or the start date if never materialized).
 */
export function computeNextDueDate(
  rule: RecurringExpenseRule,
  lastMaterializedDate: number | null,
): number | null {
  const baseDate = lastMaterializedDate ?? rule.startDate;
  const d = new Date(baseDate);
  switch (rule.frequency) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  const nextDate = d.getTime();
  if (rule.endDate !== null && nextDate > rule.endDate) return null;
  return nextDate;
}

// ───────────────────────────────────────────────
// Scheduler contract — one scheduler, two consumers
// ───────────────────────────────────────────────

/**
 * The scheduler contract. One scheduler handles BOTH recurring
 * invoices AND recurring expenses — the schedule engine is shared
 * infrastructure, not duplicated.
 *
 * The cron fires, calls `runDue(now)`, which materializes all
 * due instances (invoices + expenses) + checks idempotency per
 * period key. Missed-run recovery is automatic.
 */
export interface RecurringScheduler {
  /**
   * Run all due instances as of `now`. Returns the instances
   * materialized (for both invoices + expenses). Idempotent per
   * period key — a server restart never double-charges.
   */
  runDue(now: number): Promise<readonly RecurringInstance[]>;

  /** Pause a rule (stops materialization). */
  pause(ruleId: string): Promise<void>;

  /** Resume a rule. */
  resume(ruleId: string): Promise<void>;
}
