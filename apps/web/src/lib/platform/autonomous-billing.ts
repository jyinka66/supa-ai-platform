// Autonomous billing — usage-based billing, revenue share, multi-currency, tax.
// 14.2.15: "Usage-based billing — tools, agents, connectors, templates, embeddings,
// regions, verticals, enterprise deployments all bill automatically."

import { db } from "@supa/db";
import { billingEvents } from "@supa/db/schema";
import { eq, sql, desc } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface BillingEventInput {
  wsId?: string;
  userId?: string;
  feature: string; // 'tool.call', 'agent.run', 'connector.action', etc.
  refKey?: string; // tool key, agent slug, connector key.
  quantity?: number;
  unit?: string;
  costUsd: number;
  region?: string;
  metadata?: Record<string, unknown>;
}

// ───────────────────────────────────────────────
// recordBillingEvent — fire-and-forget billing.
// ───────────────────────────────────────────────

export function recordBillingEvent(input: BillingEventInput): void {
  recordBillingEventAsync(input).catch(() => {
    // Billing must never block the operation.
  });
}

async function recordBillingEventAsync(input: BillingEventInput): Promise<void> {
  // Compute local currency + tax if region is specified.
  let localCurrency: string | undefined;
  let localCost: number | undefined;
  let taxRate = 0;
  let taxAmount = 0;
  let totalWithTax = input.costUsd;

  if (input.region) {
    // STUB: would look up regional_config for currency + tax_rate.
    const regionMap: Record<string, { currency: string; rate: number; pppFactor: number }> = {
      us: { currency: "USD", rate: 0, pppFactor: 1.0 },
      eu: { currency: "EUR", rate: 0.20, pppFactor: 0.9 },
      uk: { currency: "GBP", rate: 0.20, pppFactor: 0.8 },
      apac: { currency: "USD", rate: 0.08, pppFactor: 0.75 },
      af: { currency: "USD", rate: 0.075, pppFactor: 0.4 },
      sa: { currency: "USD", rate: 0.17, pppFactor: 0.5 },
    };
    const config = regionMap[input.region];
    if (config) {
      localCurrency = config.currency;
      localCost = input.costUsd * config.pppFactor;
      taxRate = config.rate;
      taxAmount = localCost * taxRate;
      totalWithTax = (localCost ?? input.costUsd) * (1 + taxRate);
    }
  }

  await db.insert(billingEvents).values({
    ...(input.wsId ? { workspaceId: input.wsId as any } : {}),
    ...(input.userId ? { userId: input.userId as any } : {}),
    feature: input.feature,
    ...(input.refKey ? { refKey: input.refKey } : {}),
    quantity: (input.quantity ?? 1).toString(),
    unit: input.unit ?? "call",
    costUsd: input.costUsd.toString(),
    ...(localCurrency ? { localCurrency } : {}),
    ...(localCost != null ? { localCost: localCost.toString() } : {}),
    ...(taxRate > 0 ? { taxRate: taxRate.toString(), taxAmount: taxAmount.toString(), totalWithTax: totalWithTax.toString() } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

// ───────────────────────────────────────────────
// Revenue share — creators, connectors, templates, partners get paid.
// ───────────────────────────────────────────────

export interface RevenueShare {
  recipientOrgId: string;
  totalRevenueUsd: number;
  sharePct: number;
  shareAmountUsd: number;
  period: { from: Date; to: Date };
}

export async function calculateRevenueShare(orgId: string, periodStart: Date, periodEnd: Date = new Date()): Promise<RevenueShare | null> {
  // Sum billing events for items authored by this org.
  const result = await db.execute(sql`
    select
      coalesce(sum(b.cost_usd), 0)::numeric as total_revenue,
      coalesce(max(m.revenue_share_pct), 70)::numeric as share_pct
    from billing_events b
    left join marketplace_items m on m.slug = b.ref_key
    where m.author_org_id = ${orgId}::uuid
      and b.ts >= ${periodStart} and b.ts <= ${periodEnd}
  `);

  const row = (result as unknown as Array<{ total_revenue: string; share_pct: string }>)[0];
  if (!row) return null;

  const totalRevenue = Number(row.total_revenue);
  const sharePct = Number(row.share_pct);
  const shareAmount = totalRevenue * (sharePct / 100);

  return {
    recipientOrgId: orgId,
    totalRevenueUsd: totalRevenue,
    sharePct,
    shareAmountUsd: shareAmount,
    period: { from: periodStart, to: periodEnd },
  };
}

// ───────────────────────────────────────────────
// Fraud detection — algorithmic detection of billing anomalies.
// ───────────────────────────────────────────────

export interface FraudAlert {
  wsId: string;
  reason: string;
  severity: "low" | "medium" | "high";
  amount: number;
}

export async function detectBillingFraud(): Promise<FraudAlert[]> {
  // STUB: would detect:
  //   - Sudden cost spikes (10x normal daily spend).
  //   - Unusual API call patterns (burst from a new IP).
  //   - Referral fraud (fake installs for revenue share).
  //   - Chargeback patterns.
  return [];
}

// ───────────────────────────────────────────────
// Revenue analytics — per tool/agent/connector/template/region/vertical/enterprise.
// ───────────────────────────────────────────────

export async function getRevenueAnalytics(opts: {
  groupBy: "feature" | "ref_key" | "region" | "ws_id";
  fromTs?: Date;
  toTs?: Date;
}): Promise<Array<{ key: string; totalCostUsd: number; totalEvents: number }>> {
  const fromTs = opts.fromTs ?? new Date(Date.now() - 30 * 86400000);
  const toTs = opts.toTs ?? new Date();

  const groupColumn = {
    feature: "feature",
    ref_key: "ref_key",
    region: "region",
    ws_id: "ws_id",
  }[opts.groupBy];

  const result = await db.execute(sql`
    select ${sql.raw(groupColumn)} as key,
           sum(cost_usd)::numeric as total_cost,
           count(*)::integer as total_events
    from billing_events
    where ts >= ${fromTs} and ts <= ${toTs}
    group by ${sql.raw(groupColumn)}
    order by total_cost desc
    limit 100
  `);

  return (result as unknown as Array<{ key: string; total_cost: string; total_events: number }>).map((r) => ({
    key: r.key ?? "unknown",
    totalCostUsd: Number(r.total_cost),
    totalEvents: r.total_events,
  }));
}
