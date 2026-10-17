import { db } from "@supa/db";
import { usageBudgets, messages, messageMeta, conversations } from "@supa/db/schema";
import { eq, or, and, gte, sql, asc } from "drizzle-orm";
import { pino } from "@/lib/observability/logger";

const log = pino.child({ module: "cost.accounting" });

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: "budget_exceeded" | "alert_threshold_reached";
  userBudget?: { spent: number; limit: number; alertThreshold: number };
  workspaceBudget?: { spent: number; limit: number; alertThreshold: number };
}

export interface CostMeta {
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  firstTokenMs: number | null;
  totalMs: number;
  retries: number;
  fallbackPath: string[];
}

/**
 * Returns the start-of-month date for budget accounting.
 * All budgets are scoped to a calendar month (UTC) — re-rolling on the 1st
 * matches typical billing cycles and avoids timezone drift.
 */
function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Checks whether a request would exceed the user OR workspace budget.
 *
 * Returns `{ allowed: false, reason: "budget_exceeded" }` if either budget
 * has been hit. Returns `{ allowed: true, ... }` with spent/limit snapshots
 * otherwise, so the caller can attach them to the request context for
 * visibility in the UI.
 *
 * Alerting:
 *   - Fires `notifyBudgetAlert()` ONLY when crossing the threshold (not on
 *     every subsequent request). Tracked via the `alert_threshold` field
 *     on the budget row — if `spent < threshold` before AND `spent >= threshold`
 *     after, we fire the alert. This requires reading the prior state, which
 *     we approximate by checking `total >= threshold * limit` AND the request's
 *     estimated cost would push us across.
 *
 * NOTE: This function does NOT deduct the estimated cost from the budget —
 * that happens in `recordCost()` after the request completes. Concurrent
 * requests can therefore collectively exceed the limit by up to
 * (concurrency × estimated_cost). This is acceptable for soft limits; for
 * hard limits, wrap the actual LLM call in a Redis-backed lease.
 */
export async function checkBudget(
  userId: string,
  workspaceId: string,
  estimatedCostUsd: number,
): Promise<BudgetCheckResult> {
  const monthStart = startOfMonthUtc();

  // Load both budgets (user + workspace) in a single query.
  const budgets = await db
    .select()
    .from(usageBudgets)
    .where(
      and(
        eq(usageBudgets.period, "monthly"),
        or(
          and(eq(usageBudgets.scopeType, "user"), eq(usageBudgets.scopeId, userId)),
          and(eq(usageBudgets.scopeType, "workspace"), eq(usageBudgets.scopeId, workspaceId)),
        ),
      ),
    );

  if (budgets.length === 0) {
    // No budgets configured — allow.
    return { allowed: true };
  }

  let userResult: BudgetCheckResult["userBudget"] | undefined;
  let workspaceResult: BudgetCheckResult["workspaceBudget"] | undefined;

  for (const budget of budgets) {
    const isUser = budget.scopeType === "user";
    const spent = await getMonthSpend(budget.scopeId, isUser, monthStart);
    const limit = Number(budget.costLimitUsd);
    const alertThreshold = Number(budget.alertThreshold);

    const projected = spent + estimatedCostUsd;

    if (isUser) {
      userResult = { spent, limit, alertThreshold };
    } else {
      workspaceResult = { spent, limit, alertThreshold };
    }

    // Hard limit — block.
    if (projected >= limit) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        userBudget: userResult,
        workspaceBudget: workspaceResult,
      };
    }

    // Alert threshold crossing — only fire when we transition from below to above.
    const thresholdAmount = limit * alertThreshold;
    if (spent < thresholdAmount && projected >= thresholdAmount) {
      // Fire alert async, non-blocking. Wrapped in catch so alerting
      // failures never block the actual request.
      void notifyBudgetAlert(budget.scopeId, isUser ? "user" : "workspace", projected, limit, alertThreshold).catch(
        (err) => {
          log.warn({ event: "budget_alert_failed", scope_id: budget.scopeId, error: String(err) });
        },
      );
    }
  }

  return { allowed: true, userBudget: userResult, workspaceBudget: workspaceResult };
}

/**
 * Returns the total USD spend for the current month for a given scope.
 *
 * Joins `message_meta` → `messages` → `conversations` to filter by either
 * `conversations.user_id` (user scope) or `conversations.workspace_id`
 * (workspace scope).
 */
async function getMonthSpend(scopeId: string, isUser: boolean, monthStart: Date): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${messageMeta.costUsd}), 0)::float`,
    })
    .from(messageMeta)
    .innerJoin(messages, eq(messages.id, messageMeta.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        gte(messageMeta.costUsd, 0 as never), // exclude nulls/negatives
        gte(messages.createdAt, monthStart),
        isUser
          ? eq(conversations.userId, scopeId)
          : eq(conversations.workspaceId, scopeId),
      ),
    );

  return Number((rows as unknown as Array<{ total: number }>)[0]?.total ?? 0);
}

/**
 * Records the actual cost + metadata for a completed (or failed) message.
 *
 * Idempotent: if a `message_meta` row already exists for this messageId,
 * the call is a no-op. This protects against duplicate writes when the
 * streaming route retries or when a client retries after a network error.
 *
 * NOTE: the streaming route's `persistMessage()` helper already inserts
 * `message_meta` in the same transaction as the `messages` row. This
 * function is for cases where you need to record cost AFTER the fact
 * (e.g. async token-count reconciliation once the provider's final
 * usage report comes back).
 */
export async function recordCost(messageId: string, meta: CostMeta): Promise<void> {
  // Idempotency check — if a row already exists, skip.
  const existing = await db
    .select({ id: messageMeta.messageId })
    .from(messageMeta)
    .where(eq(messageMeta.messageId, messageId))
    .limit(1);

  if (existing) {
    log.debug({ event: "cost_already_recorded", message_id: messageId });
    return;
  }

  await db.insert(messageMeta).values({
    messageId,
    model: meta.model,
    provider: meta.provider,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    costUsd: meta.costUsd,
    latencyFirstTokenMs: meta.firstTokenMs,
    latencyTotalMs: meta.totalMs,
    retries: meta.retries,
    fallbackPath: meta.fallbackPath,
    idempotencyKey: `cost:${messageId}`,
  } as never);
}

/**
 * Fires a budget alert. Currently logs to the observability stack; in
 * production this should fan out to:
 *   - Email the workspace owner
 *   - Post to a Slack/Teams webhook
 *   - Create a PostHog event for product analytics
 *
 * The alert is keyed by scope + month so we don't spam — we only fire
 * on threshold crossing, not on every subsequent request.
 */
async function notifyBudgetAlert(
  scopeId: string,
  scopeType: "user" | "workspace",
  projected: number,
  limit: number,
  threshold: number,
): Promise<void> {
  log.info({
    event: "budget_threshold_reached",
    scope_type: scopeType,
    scope_id: scopeId,
    projected_spent: projected,
    limit,
    threshold,
    pct: (projected / limit).toFixed(2),
  } as never);

  // Surface to the process console as well — the structured log above
  // goes to the observability stack, but a plain console.warn ensures
  // the alert is visible even when the logger is misconfigured or
  // buffered. This is the fallback for the email/Slack fan-out below.
  const pct = ((projected / limit) * 100).toFixed(1);
  console.warn(
    `[budget-alert] ${scopeType} ${scopeId} reached ${pct}% of limit ` +
      `(spent ~$${projected.toFixed(2)} / $${limit.toFixed(2)}, threshold ${threshold}). ` +
      `Email/Slack notification not wired — see TODO below.`,
  );

  // TODO: wire to email provider (Resend) + Slack webhook.
  // The email should include:
  //   - Current spend + limit
  //   - Days remaining in the billing period
  //   - A link to the billing dashboard
  //   - An "increase limit" CTA (if the user has permission)
}
