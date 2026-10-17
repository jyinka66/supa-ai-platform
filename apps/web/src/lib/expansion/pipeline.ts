// Autonomous globalization expansion — onboarding pipelines + thresholds.
//
// The spec: "New language onboarding — pipeline runs autonomously once a language
// is prioritized." + "Threshold-based expansion — regions and languages onboard
// automatically when usage thresholds are crossed."
//
// Pipeline stages (for all 4 kinds):
//   prioritized → extracting → translating → reviewing → qa → publishing → live
//
// Each stage has a checklist (stored as JSONB on the expansion_task). The
// pipeline advances when the checklist for the current stage is complete.
// Threshold-based auto-expansion: when usage for a locale/region crosses a
// threshold, a new expansion_task is auto-created with status='prioritized'.
//
// The 4 kinds:
//   - language: a new UI locale (en/fr/ar/...).
//   - region: a new regional config (us/eu/apac/...).
//   - jurisdiction: a new legal jurisdiction (global/us/eu/uk/...).
//   - support_language: a new support language (added to a region's support_languages).

import { db } from "@supa/db";
import { expansionTasks } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ExpansionKind = "language" | "region" | "jurisdiction" | "support_language";
export type ExpansionStatus =
  | "prioritized" | "extracting" | "translating" | "reviewing"
  | "qa" | "publishing" | "live" | "abandoned";

export interface ExpansionChecklist {
  extracted: boolean;
  translated: boolean;
  reviewed: boolean;
  qa_passed: boolean;
  published: boolean;
  verified: boolean;
}

export interface ExpansionTask {
  id: string;
  kind: ExpansionKind;
  target: string;
  status: ExpansionStatus;
  thresholdMet: boolean;
  usageThreshold: number | null;
  currentUsage: number | null;
  assignedTo: string | null;
  checklist: ExpansionChecklist;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export class ExpansionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ExpansionError";
  }
}

// ───────────────────────────────────────────────
// Pipeline stage order.
// ───────────────────────────────────────────────

export const PIPELINE_STAGES: ExpansionStatus[] = [
  "prioritized", "extracting", "translating", "reviewing", "qa", "publishing", "live",
];

// ───────────────────────────────────────────────
// Thresholds for auto-expansion.
// ───────────────────────────────────────────────

export const EXPANSION_THRESHOLDS: Record<ExpansionKind, number> = {
  language: 500,           // 500 users with this locale → auto-onboard.
  region: 1000,            // 1000 users from this region → auto-onboard.
  jurisdiction: 50,        // 50 enterprise users in this jurisdiction → auto-onboard legal.
  support_language: 200,    // 200 support tickets in this language → auto-onboard support.
};

// ───────────────────────────────────────────────
// createExpansionTask — start a new onboarding pipeline.
// ───────────────────────────────────────────────

export async function createExpansionTask(
  kind: ExpansionKind,
  target: string,
  thresholdMet: boolean = false,
  usageThreshold?: number,
): Promise<ExpansionTask> {
  const checklist: ExpansionChecklist = {
    extracted: false,
    translated: false,
    reviewed: false,
    qa_passed: false,
    published: false,
    verified: false,
  };

  try {
    const rows = await db
      .insert(expansionTasks)
      .values({
        kind,
        target,
        status: "prioritized",
        thresholdMet,
        ...(usageThreshold !== undefined ? { usageThreshold: usageThreshold.toString() } : {}),
        checklist,
      })
      .returning({ id: expansionTasks.id });
    const row = rows[0];
    if (!row) throw new ExpansionError("expansion_task_insert_failed", 500);

    await auditExpansion("expansion.task.created", row.id as string, { kind, target, thresholdMet });
    return (await getExpansionTask(row.id as string))!;
  } catch (err) {
    if (err instanceof ExpansionError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      throw new ExpansionError("expansion_task_already_exists", 409);
    }
    throw err;
  }
}

// ───────────────────────────────────────────────
// advanceStage — move to the next pipeline stage.
// ───────────────────────────────────────────────

/**
 * Advance an expansion task to the next pipeline stage.
 *
 * Validates that the current stage's checklist is complete before advancing.
 *
 * @throws ExpansionError(400) if the current stage's checklist is incomplete.
 * @throws ExpansionError(409) if already at 'live' (terminal).
 */
export async function advanceStage(taskId: string): Promise<ExpansionTask> {
  const task = await getExpansionTask(taskId);
  if (!task) throw new ExpansionError("task_not_found", 404);
  if (task.status === "live") throw new ExpansionError("already_live", 409);
  if (task.status === "abandoned") throw new ExpansionError("task_abandoned", 409);

  const currentIdx = PIPELINE_STAGES.indexOf(task.status);
  if (currentIdx === -1) throw new ExpansionError(`invalid_status:${task.status}`, 400);

  // Validate the checklist for the current stage.
  const checklist = task.checklist;
  const stageChecks: Record<string, boolean> = {
    prioritized: true, // no checklist item for this stage.
    extracting: checklist.extracted,
    translating: checklist.translated,
    reviewing: checklist.reviewed,
    qa: checklist.qa_passed,
    publishing: checklist.published,
    live: checklist.verified,
  };

  if (!stageChecks[task.status]) {
    throw new ExpansionError(`checklist_incomplete:${task.status}`, 400);
  }

  const nextStatus = PIPELINE_STAGES[currentIdx + 1] ?? "live";
  const now = new Date();
  const isComplete = nextStatus === "live";

  await db
    .update(expansionTasks)
    .set({
      status: nextStatus,
      updatedAt: now,
      ...(isComplete ? { completedAt: now } : {}),
    })
    .where(eq(expansionTasks.id, taskId as any));

  await auditExpansion("expansion.task.advanced", taskId, { from: task.status, to: nextStatus });

  return (await getExpansionTask(taskId))!;
}

// ───────────────────────────────────────────────
// updateChecklist — mark a checklist item as done.
// ───────────────────────────────────────────────

export async function updateChecklist(
  taskId: string,
  item: keyof ExpansionChecklist,
  done: boolean = true,
): Promise<ExpansionTask> {
  const task = await getExpansionTask(taskId);
  if (!task) throw new ExpansionError("task_not_found", 404);

  const checklist = { ...task.checklist, [item]: done };

  await db
    .update(expansionTasks)
    .set({ checklist, updatedAt: new Date() })
    .where(eq(expansionTasks.id, taskId as any));

  await auditExpansion("expansion.task.checklist_updated", taskId, { item, done });

  return (await getExpansionTask(taskId))!;
}

// ───────────────────────────────────────────────
// checkThresholds — auto-create tasks when usage crosses thresholds.
//
// The cron calls this. For each kind, it checks the current usage metrics
// + creates a new expansion_task if the threshold is crossed + no task exists.
// ───────────────────────────────────────────────

export interface ThresholdCheckResult {
  kind: ExpansionKind;
  target: string;
  currentUsage: number;
  threshold: number;
  taskCreated: boolean;
}

export async function checkThresholds(): Promise<ThresholdCheckResult[]> {
  const results: ThresholdCheckResult[] = [];

  // Language thresholds — count users per locale (from auth.users.user_metadata.locale).
  // STUB: would query `select user_metadata->>'locale', count(*) from auth.users group by 1`.
  // For now, returns empty (no auto-expansion triggered).

  // Region thresholds — count users per region (from support_tickets.user_region or workspace region).
  // STUB: would query `select user_region, count(*) from support_tickets group by 1`.

  // Jurisdiction thresholds — count enterprise workspaces per jurisdiction.
  // STUB: would query `select billing->>'jurisdiction', count(*) from workspaces where plan='enterprise' group by 1`.

  // Support language thresholds — count tickets per user_locale.
  try {
    const ticketLocales = await db.execute(sql`
      select user_locale, count(*)::integer as n
      from support_tickets
      where created_at > now() - interval '30 days'
      group by user_locale
      having count(*) > ${EXPANSION_THRESHOLDS.support_language}
    `);

    for (const row of ticketLocales as unknown as Array<{ user_locale: string; n: number }>) {
      const locale = row.user_locale;
      const existing = await db
        .select({ id: expansionTasks.id })
        .from(expansionTasks)
        .where(and(eq(expansionTasks.kind, "support_language"), eq(expansionTasks.target, locale)))
        .limit(1);

      if (existing.length === 0) {
        await createExpansionTask("support_language", locale, true, EXPANSION_THRESHOLDS.support_language);
        results.push({
          kind: "support_language",
          target: locale,
          currentUsage: row.n,
          threshold: EXPANSION_THRESHOLDS.support_language,
          taskCreated: true,
        });
      } else {
        results.push({
          kind: "support_language",
          target: locale,
          currentUsage: row.n,
          threshold: EXPANSION_THRESHOLDS.support_language,
          taskCreated: false,
        });
      }
    }
  } catch {
    // Query failure must not crash the cron.
  }

  return results;
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getExpansionTask(id: string): Promise<ExpansionTask | null> {
  const rows = await db
    .select()
    .from(expansionTasks)
    .where(eq(expansionTasks.id, id as any))
    .limit(1);
  return mapRow(rows[0]);
}

export async function listExpansionTasks(opts: {
  kind?: ExpansionKind;
  status?: ExpansionStatus;
} = {}): Promise<ExpansionTask[]> {
  const conditions = [];
  if (opts.kind) conditions.push(eq(expansionTasks.kind, opts.kind));
  if (opts.status) conditions.push(eq(expansionTasks.status, opts.status));

  const rows = await db
    .select()
    .from(expansionTasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${expansionTasks.createdAt} desc`);

  return rows.map(mapRow).filter((t): t is ExpansionTask => t !== null);
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function mapRow(row: Record<string, unknown> | undefined): ExpansionTask | null {
  if (!row) return null;
  return {
    id: row.id as string,
    kind: row.kind as ExpansionKind,
    target: row.target as string,
    status: row.status as ExpansionStatus,
    thresholdMet: row.thresholdMet as boolean,
    usageThreshold: row.usageThreshold != null ? Number(row.usageThreshold) : null,
    currentUsage: row.currentUsage != null ? Number(row.currentUsage) : null,
    assignedTo: (row.assignedTo as string | null) ?? null,
    checklist: (row.checklist as ExpansionChecklist) ?? {
      extracted: false, translated: false, reviewed: false, qa_passed: false, published: false, verified: false,
    },
    notes: (row.notes as string | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    completedAt: (row.completedAt as Date | null) ?? null,
  };
}

async function auditExpansion(action: string, taskId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await adminAudit({
      actor: "system",
      action,
      target: { taskId, ...target },
      justification: `expansion pipeline: ${action}`,
    });
  } catch {
    // audit failure must not fail the operation.
  }
}
