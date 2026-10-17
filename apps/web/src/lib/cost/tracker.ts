// Cost tracking — per-user / per-workspace / per-feature.
//
// Every cost-incurring action appends a row to `cost_ledger`. The ledger is
// append-only (financial audit trail — corrections are new rows with negative
// amounts). A nightly job aggregates the ledger into per-user/per-ws/per-feature
// summaries for the cost dashboard.
//
// The spec: "Cost first-class metric. Cost per user, per workspace, per
// feature tracked." + "Cost optimization — cost per user, per workspace, per
// feature. AI, storage, CDN, database, monthly review, alerts."
//
// Cost sources:
//   - AI: per-token cost (OpenAI/Anthropic pricing). Recorded in real-time
//     from the chat/agent request path.
//   - Storage: per-byte cost (S3/R2/Supabase Storage). Recorded hourly by
//     a reconciliation job (sums the storage_used counter).
//   - CDN: per-request bandwidth cost (Cloudflare). Recorded hourly.
//   - DB: connection time / query cost (Supabase). Recorded hourly.
//   - Webhooks/Emails: per-delivery cost. Recorded per-delivery.
//
// The tracker is fire-and-forget (the cost append never blocks the request —
// if the DB is down, the cost is logged + dropped, not propagated to the user).

import { db } from "@supa/db";
import { costLedger } from "@supa/db/schema";
import { sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type CostFeature =
  | "ai.chat"
  | "ai.agents"
  | "ai.embeddings"
  | "storage"
  | "cdn"
  | "db"
  | "webhooks"
  | "emails";

export interface CostEvent {
  wsId?: string | null;
  userId?: string | null;
  feature: CostFeature;
  provider?: string;
  costUsd: number;
  quantity?: number;
  quantityUnit?: string;
  metadata?: Record<string, unknown>;
}

export interface CostSummary {
  feature: CostFeature;
  totalCostUsd: number;
  totalQuantity: number;
  quantityUnit: string | null;
  eventCount: number;
}

export interface CostBreakdown {
  totalCostUsd: number;
  byFeature: CostSummary[];
  byWorkspace: Array<{ wsId: string; totalCostUsd: number }>;
  byUser: Array<{ userId: string; totalCostUsd: number }>;
}

// ───────────────────────────────────────────────
// recordCost — fire-and-forget append to the ledger
// ───────────────────────────────────────────────

/**
 * Record a cost event. Fire-and-forget — the append never throws to the caller
 * (if the DB is down, the cost is logged + dropped, not propagated to the user).
 *
 * Usage:
 *   recordCost({ wsId, userId, feature: 'ai.chat', provider: 'openai',
 *     costUsd: 0.0123, quantity: 1500, quantityUnit: 'tokens',
 *     metadata: { model: 'gpt-4o', prompt_tokens: 500, completion_tokens: 1000 } });
 */
export function recordCost(event: CostEvent): void {
  // Fire-and-forget — don't await (the caller doesn't need to wait for the cost
  // to be recorded). Errors are logged, not propagated.
  recordCostAsync(event).catch((err) => {
    console.error("[cost] failed to record cost event:", err, event);
  });
}

async function recordCostAsync(event: CostEvent): Promise<void> {
  await db.insert(costLedger).values({
    ...(event.wsId ? { workspaceId: event.wsId as any } : {}),
    ...(event.userId ? { userId: event.userId as any } : {}),
    feature: event.feature,
    provider: event.provider ?? null,
    costUsd: event.costUsd.toString(),
    ...(event.quantity !== undefined ? { quantity: event.quantity.toString() } : {}),
    ...(event.quantityUnit ? { quantityUnit: event.quantityUnit } : {}),
    metadata: event.metadata ?? {},
  });
}

// ───────────────────────────────────────────────
// AI cost helpers (the most common cost source)
// ───────────────────────────────────────────────

/** OpenAI pricing (per 1M tokens, as of 2024 — update when prices change). */
export const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

/** Anthropic pricing (per 1M tokens). */
export const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
};

/**
 * Compute the cost of an AI call + record it.
 *
 * @param model — the model name (e.g. 'gpt-4o').
 * @param inputTokens — the prompt token count.
 * @param outputTokens — the completion token count.
 */
export function recordAiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  ctx: { wsId?: string; userId?: string; provider?: string },
): number {
  const provider = ctx.provider ?? (model.startsWith("claude") ? "anthropic" : "openai");
  const pricing = provider === "anthropic"
    ? ANTHROPIC_PRICING[model]
    : OPENAI_PRICING[model];

  if (!pricing) {
    // Unknown model — can't compute cost. Log + skip (don't record a 0 cost).
    console.warn(`[cost] unknown model pricing: ${model} (provider=${provider})`);
    return 0;
  }

  const costUsd =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  recordCost({
    ...(ctx.wsId ? { wsId: ctx.wsId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    feature: model.includes("embedding") ? "ai.embeddings" : "ai.chat",
    provider,
    costUsd,
    quantity: inputTokens + outputTokens,
    quantityUnit: "tokens",
    metadata: { model, inputTokens, outputTokens },
  });

  return costUsd;
}

// ───────────────────────────────────────────────
// Aggregation — for the cost dashboard
// ───────────────────────────────────────────────

/**
 * Get a cost breakdown for a time range. Used by the /api/admin/costs endpoint.
 *
 * @param fromTs — start of the range.
 * @param toTs — end of the range (default: now).
 * @param wsId — filter to a specific workspace (optional).
 */
export async function getCostBreakdown(
  fromTs: Date,
  toTs: Date = new Date(),
  wsId?: string,
): Promise<CostBreakdown> {
  const wsFilter = wsId ? sql`and ws_id = ${wsId}::uuid` : sql``;

  // Aggregate by feature.
  const byFeatureRows = await db.execute(sql`
    select
      feature,
      sum(cost_usd)::numeric as total_cost,
      coalesce(sum(quantity), 0)::numeric as total_quantity,
      max(quantity_unit) as quantity_unit,
      count(*)::integer as event_count
    from cost_ledger
    where ts >= ${fromTs} and ts <= ${toTs} ${wsFilter}
    group by feature
    order by total_cost desc
  `);

  const byFeature: CostSummary[] = (byFeatureRows as unknown as Array<{
    feature: CostFeature;
    total_cost: string;
    total_quantity: string;
    quantity_unit: string | null;
    event_count: number;
  }>).map((r) => ({
    feature: r.feature,
    totalCostUsd: Number(r.total_cost),
    totalQuantity: Number(r.total_quantity),
    quantityUnit: r.quantity_unit,
    eventCount: r.event_count,
  }));

  // Aggregate by workspace.
  const byWsRows = await db.execute(sql`
    select ws_id, sum(cost_usd)::numeric as total_cost
    from cost_ledger
    where ts >= ${fromTs} and ts <= ${toTs} and ws_id is not null
    group by ws_id
    order by total_cost desc
    limit 100
  `);
  const byWorkspace = (byWsRows as unknown as Array<{ ws_id: string; total_cost: string }>).map((r) => ({
    wsId: r.ws_id,
    totalCostUsd: Number(r.total_cost),
  }));

  // Aggregate by user.
  const byUserRows = await db.execute(sql`
    select user_id, sum(cost_usd)::numeric as total_cost
    from cost_ledger
    where ts >= ${fromTs} and ts <= ${toTs} and user_id is not null
    group by user_id
    order by total_cost desc
    limit 100
  `);
  const byUser = (byUserRows as unknown as Array<{ user_id: string; total_cost: string }>).map((r) => ({
    userId: r.user_id,
    totalCostUsd: Number(r.total_cost),
  }));

  const totalCostUsd = byFeature.reduce((sum, f) => sum + f.totalCostUsd, 0);

  return { totalCostUsd, byFeature, byWorkspace, byUser };
}

/**
 * Get the cost per user (for the "cost per user" metric).
 * Returns the average cost per active user in the time range.
 */
export async function getCostPerUser(fromTs: Date, toTs: Date = new Date()): Promise<number> {
  const result = await db.execute(sql`
    select
      sum(cost_usd)::numeric as total_cost,
      count(distinct user_id)::integer as user_count
    from cost_ledger
    where ts >= ${fromTs} and ts <= ${toTs} and user_id is not null
  `);
  const row = (result as unknown as Array<{ total_cost: string | null; user_count: number }>)[0];
  if (!row || !row.total_cost || row.user_count === 0) return 0;
  return Number(row.total_cost) / row.user_count;
}
