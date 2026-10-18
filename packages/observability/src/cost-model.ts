/**
 * @supa/observability/cost-model
 * ----------------------------------------------------------------
 * Unit economics per 1,000 MAU. The part that keeps the business
 * alive.
 *
 * Tiers (rough order-of-magnitude):
 *
 *   storage+CDN  assets dominate — dedupe via content-hash
 *                (design-assets pass already guarantees this).
 *                Derived encodes regenerate on demand, never
 *                stored "just in case" beyond the hot set.
 *
 *   sync         op volume correlates with edit-minutes; ops are
 *                tiny (~100B) — bandwidth, not compute.
 *
 *   render       thumbnails are the hidden volume (project browser,
 *                share cards, version history) — generated once
 *                per rev, cached by content hash, invalidated only
 *                on rev change. NEVER re-render an unchanged page;
 *                this single rule is most of the render bill.
 *
 *   ai           credit ledger (design-ai pass) maps 1:1 to real
 *                provider cost per op class — pricing a tier is
 *                arithmetic, not negotiation. Free-tier ops route
 *                to cheap models by default; that's the margin.
 *
 * Alerting thresholds are cost alerts, not just error alerts:
 *   render queue spend/day, ai spend/account/day (anomaly = abuse
 *   or a prompt loop), storage growth rate.
 * ----------------------------------------------------------------
 */

// Local copies of the type aliases from @supa/ai-gateway/src/types.ts.
// Duplicated here (rather than imported) so @supa/observability stays
// free of runtime deps on @supa/ai-gateway — the warehouse package
// must be importable standalone. The two definitions are kept in
// sync by the canary gate's regression tests.
export type OpClass =
  | "palette-suggest"
  | "text-rewrite"
  | "diff-check"
  | "layout-suggest"
  | "template-generate"
  | "repaint";

export type Provider = "gemini" | "groq" | "openrouter";

// ───────────────────────────────────────────────
// Cost tiers
// ───────────────────────────────────────────────

export type CostTier = "storage" | "sync" | "render" | "ai";

// ───────────────────────────────────────────────
// Storage tier — asset dedupe + on-demand derived encodes
// ───────────────────────────────────────────────

/**
 * Storage cost = (unique asset bytes + hot-set derived encodes) ×
 * price-per-GB-month. The dedupe key is the content hash; the
 * design-assets pass already guarantees one asset per hash.
 *
 * Derived encodes (resized thumbnails, webp variants, etc.) are
 * generated on demand and only the hot set is stored — anything
 * cold is regenerated, never kept "just in case".
 */
export interface StorageCostSnapshot {
  /** Unique asset bytes (post-dedupe). */
  assetBytes: number;
  /** Hot-set derived encode bytes. */
  hotDerivedBytes: number;
  /** Cold derived encodes that were regenerated instead of stored. */
  regeneratedColdDerived: number;
  /** Price per GB-month (USD). */
  pricePerGbMonth: number;
  /** CDN egress bytes for the window. */
  cdnEgressBytes: number;
  /** Price per GB egress (USD). */
  pricePerGbEgress: number;
}

export interface StorageCostBreakdown {
  storageUsd: number;
  cdnEgressUsd: number;
  totalUsd: number;
  /** Effective dedupe ratio: assetBytes / (assetBytes if no dedupe). */
  dedupeRatio: number;
}

export function computeStorageCost(snap: StorageCostSnapshot): StorageCostBreakdown {
  const gb = (b: number) => b / (1024 ** 3);
  const storageUsd = gb(snap.assetBytes + snap.hotDerivedBytes) * snap.pricePerGbMonth;
  const cdnEgressUsd = gb(snap.cdnEgressBytes) * snap.pricePerGbEgress;
  return {
    storageUsd: round4(storageUsd),
    cdnEgressUsd: round4(cdnEgressUsd),
    totalUsd: round4(storageUsd + cdnEgressUsd),
    dedupeRatio: 1, // dedupe already applied at the asset store layer; ratio measured externally
  };
}

// ───────────────────────────────────────────────
// Sync tier — op volume × bandwidth
// ───────────────────────────────────────────────

/**
 * Sync cost is bandwidth-bound. Ops are ~100B each. Cost per
 * million ops is roughly constant; the lever is reducing op
 * volume (batching, throttling presence, skipping no-op ops).
 */
export interface SyncCostSnapshot {
  /** Total ops shipped in the window. */
  opsShipped: number;
  /** Average op size (bytes). */
  avgOpBytes: number;
  /** Cross-pod fanout amplification (1.0 = no fanout; >1 = extra redis pub/sub hops). */
  fanoutAmplification: number;
  /** Price per GB egress (USD). */
  pricePerGbEgress: number;
  /** Redis pub/sub cost per million messages (USD). */
  redisPricePerMillion: number;
}

export interface SyncCostBreakdown {
  bandwidthUsd: number;
  redisPubsubUsd: number;
  totalUsd: number;
  /** Effective GB shipped. */
  gbShipped: number;
}

export function computeSyncCost(snap: SyncCostSnapshot): SyncCostBreakdown {
  const totalBytes = snap.opsShipped * snap.avgOpBytes * snap.fanoutAmplification;
  const gbShipped = totalBytes / (1024 ** 3);
  const bandwidthUsd = gbShipped * snap.pricePerGbEgress;
  const redisPubsubUsd = (snap.opsShipped * snap.fanoutAmplification / 1_000_000) * snap.redisPricePerMillion;
  return {
    bandwidthUsd: round4(bandwidthUsd),
    redisPubsubUsd: round4(redisPubsubUsd),
    totalUsd: round4(bandwidthUsd + redisPubsubUsd),
    gbShipped: round4(gbShipped),
  };
}

// ───────────────────────────────────────────────
// Render tier — thumbnails cached by content hash
// ───────────────────────────────────────────────

/**
 * The hidden cost center: thumbnails for project browser, share
 * cards, version history. Generated once per rev, cached by content
 * hash, invalidated ONLY on rev change.
 *
 * NEVER re-render an unchanged page. This single rule is most of
 * the render bill — and the most-violated rule in naive impls.
 */
export interface RenderCostSnapshot {
  /** Distinct revs rendered (cache misses). */
  cacheMisses: number;
  /** Render calls served from cache (free, but tracked for hit rate). */
  cacheHits: number;
  /** Avg CPU-seconds per render. */
  avgCpuSecondsPerRender: number;
  /** Price per CPU-second (USD). */
  pricePerCpuSecond: number;
  /** Queue buffer cost (per million messages, USD). */
  queuePricePerMillion: number;
  /** Queue messages in window. */
  queueMessages: number;
}

export interface RenderCostBreakdown {
  computeUsd: number;
  queueUsd: number;
  totalUsd: number;
  /** Cache hit rate — should be >90% for a mature doc. */
  cacheHitRate: number;
  /** Estimated waste: re-renders of unchanged pages (USD). */
  wasteUsd: number;
}

export function computeRenderCost(snap: RenderCostSnapshot): RenderCostBreakdown {
  const totalRenders = snap.cacheMisses + snap.cacheHits;
  const computeUsd = snap.cacheMisses * snap.avgCpuSecondsPerRender * snap.pricePerCpuSecond;
  const queueUsd = (snap.queueMessages / 1_000_000) * snap.queuePricePerMillion;
  const cacheHitRate = totalRenders === 0 ? 1 : snap.cacheHits / totalRenders;
  // Waste = re-renders that should have hit cache but didn't.
  // We don't know the actual waste without rev-change tracking; this
  // is an upper bound assuming the gap between cacheHitRate and 1.
  const wasteUsd = (1 - cacheHitRate) * computeUsd;
  return {
    computeUsd: round4(computeUsd),
    queueUsd: round4(queueUsd),
    totalUsd: round4(computeUsd + queueUsd),
    cacheHitRate: round4(cacheHitRate),
    wasteUsd: round4(wasteUsd),
  };
}

// ───────────────────────────────────────────────
// AI tier — credit ledger maps 1:1 to provider cost
// ───────────────────────────────────────────────

/**
 * Provider cost per (op class, model, provider). The credit ledger
 * in @supa/ai-gateway already charges microcredits per op; this
 * table converts microcredits to real USD using the provider's
 * actual pricing.
 *
 * Pricing a tier is arithmetic, not negotiation. Free-tier ops
 * route to cheap models by default — that's the margin.
 */
export interface ProviderPriceRow {
  opClass: OpClass;
  provider: Provider;
  model: string;
  /** USD per 1K input tokens. */
  inUsdPer1k: number;
  /** USD per 1K output tokens. */
  outUsdPer1k: number;
}

export const PROVIDER_PRICES: ProviderPriceRow[] = [
  // Cheap tier (free-tier default)
  { opClass: "palette-suggest", provider: "groq",      model: "llama-3.1-8b-instant",     inUsdPer1k: 0.000005, outUsdPer1k: 0.000008 },
  { opClass: "palette-suggest", provider: "gemini",    model: "gemini-1.5-flash-8b",      inUsdPer1k: 0.000007, outUsdPer1k: 0.000012 },
  { opClass: "text-rewrite",    provider: "groq",      model: "llama-3.1-8b-instant",     inUsdPer1k: 0.000005, outUsdPer1k: 0.000008 },
  { opClass: "text-rewrite",    provider: "gemini",    model: "gemini-1.5-flash-8b",      inUsdPer1k: 0.000007, outUsdPer1k: 0.000012 },
  { opClass: "diff-check",      provider: "groq",      model: "llama-3.1-8b-instant",     inUsdPer1k: 0.000005, outUsdPer1k: 0.000008 },
  // Standard
  { opClass: "layout-suggest",  provider: "gemini",    model: "gemini-1.5-flash",          inUsdPer1k: 0.00003,  outUsdPer1k: 0.00006  },
  { opClass: "layout-suggest",  provider: "gemini",    model: "gemini-1.5-flash-8b",      inUsdPer1k: 0.000007, outUsdPer1k: 0.000012 },
  // Premium
  { opClass: "template-generate", provider: "openrouter", model: "anthropic/claude-3.5-sonnet", inUsdPer1k: 0.003,  outUsdPer1k: 0.015 },
  { opClass: "template-generate", provider: "gemini",    model: "gemini-1.5-pro",            inUsdPer1k: 0.00125, outUsdPer1k: 0.005 },
  { opClass: "repaint",          provider: "openrouter", model: "anthropic/claude-3.5-sonnet", inUsdPer1k: 0.003,  outUsdPer1k: 0.015 },
  { opClass: "repaint",          provider: "gemini",    model: "gemini-1.5-pro",            inUsdPer1k: 0.00125, outUsdPer1k: 0.005 },
];

/** Lookup price by op class + provider + model. Returns null if unknown. */
export function lookupPrice(
  opClass: OpClass,
  provider: Provider,
  model: string,
): ProviderPriceRow | null {
  return (
    PROVIDER_PRICES.find(
      (r) => r.opClass === opClass && r.provider === provider && r.model === model,
    ) ?? null
  );
}

export interface AiUsageRecord {
  opClass: OpClass;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Number of requests in the bucket. */
  count: number;
}

export interface AiCostBreakdown {
  totalUsd: number;
  perOpClass: Record<OpClass, number>;
  /** Free-tier (cheap) ratio — should be the bulk of usage. */
  cheapTierRatio: number;
}

export function computeAiCost(usage: AiUsageRecord[]): AiCostBreakdown {
  const perOpClass: Record<OpClass, number> = {
    "palette-suggest": 0,
    "text-rewrite": 0,
    "diff-check": 0,
    "layout-suggest": 0,
    "template-generate": 0,
    "repaint": 0,
  };
  let totalUsd = 0;
  let cheapUsd = 0;
  const cheapClasses: OpClass[] = ["palette-suggest", "text-rewrite", "diff-check"];

  for (const rec of usage) {
    const price = lookupPrice(rec.opClass, rec.provider, rec.model);
    if (!price) continue; // unknown model — skip from cost (will show in alerting)
    const cost = ((rec.inputTokens / 1000) * price.inUsdPer1k + (rec.outputTokens / 1000) * price.outUsdPer1k) * rec.count;
    perOpClass[rec.opClass] += cost;
    totalUsd += cost;
    if (cheapClasses.includes(rec.opClass)) cheapUsd += cost;
  }

  return {
    totalUsd: round4(totalUsd),
    perOpClass: Object.fromEntries(
      Object.entries(perOpClass).map(([k, v]) => [k, round4(v)]),
    ) as Record<OpClass, number>,
    cheapTierRatio: totalUsd === 0 ? 0 : round4(cheapUsd / totalUsd),
  };
}

// ───────────────────────────────────────────────
// Alerting thresholds — cost alerts, not just error alerts
// ───────────────────────────────────────────────

export type AlertSeverity = "info" | "warn" | "critical";

export interface CostAlert {
  kind: "render-queue-spend" | "ai-spend-account" | "storage-growth" | "ai-unknown-model";
  severity: AlertSeverity;
  /** USD value that triggered the alert. */
  value: number;
  /** Threshold that was crossed. */
  threshold: number;
  /** Account id (for ai-spend-account) or null (for global alerts). */
  accountId?: string;
  /** Message with human-readable context. */
  message: string;
  ts: number;
}

export interface CostAlertThresholds {
  /** Daily render queue spend (USD) → warn/critical. */
  renderQueueSpendWarn: number;
  renderQueueSpendCritical: number;
  /** Daily AI spend per account (USD) → warn/critical. */
  aiSpendAccountWarn: number;
  aiSpendAccountCritical: number;
  /** Storage growth rate (GB/day) → warn/critical. */
  storageGrowthWarnGbPerDay: number;
  storageGrowthCriticalGbPerDay: number;
}

const DEFAULT_THRESHOLDS: CostAlertThresholds = {
  renderQueueSpendWarn: 5,
  renderQueueSpendCritical: 25,
  aiSpendAccountWarn: 2,
  aiSpendAccountCritical: 10,
  storageGrowthWarnGbPerDay: 50,
  storageGrowthCriticalGbPerDay: 250,
};

// ───────────────────────────────────────────────
// Alert evaluator
// ───────────────────────────────────────────────

export interface AlertEvaluatorOptions {
  thresholds?: Partial<CostAlertThresholds>;
  now?: () => number;
  onAlert?: (alert: CostAlert) => void;
}

export class CostAlertEvaluator {
  private readonly thresholds: CostAlertThresholds;
  private readonly now: () => number;
  private readonly onAlert: (alert: CostAlert) => void;

  /** Per-account daily AI spend accumulator. Reset by the caller daily. */
  private readonly accountSpend = new Map<string, number>();

  constructor(opts: AlertEvaluatorOptions = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.now = opts.now ?? Date.now;
    this.onAlert = opts.onAlert ?? (() => {});
  }

  /** Record a render queue spend snapshot for the day (so far). */
  recordRenderQueueSpend(usdToday: number): void {
    if (usdToday >= this.thresholds.renderQueueSpendCritical) {
      this.fire({
        kind: "render-queue-spend",
        severity: "critical",
        value: usdToday,
        threshold: this.thresholds.renderQueueSpendCritical,
        message: `render queue spend $${usdToday.toFixed(2)}/day crossed critical (${this.thresholds.renderQueueSpendCritical.toFixed(2)})`,
      });
    } else if (usdToday >= this.thresholds.renderQueueSpendWarn) {
      this.fire({
        kind: "render-queue-spend",
        severity: "warn",
        value: usdToday,
        threshold: this.thresholds.renderQueueSpendWarn,
        message: `render queue spend $${usdToday.toFixed(2)}/day crossed warn (${this.thresholds.renderQueueSpendWarn.toFixed(2)})`,
      });
    }
  }

  /** Record an AI usage charge for an account. */
  recordAiCharge(accountId: string, usd: number): void {
    const prev = this.accountSpend.get(accountId) ?? 0;
    const next = prev + usd;
    this.accountSpend.set(accountId, next);
    if (next >= this.thresholds.aiSpendAccountCritical) {
      // Only fire on crossing the critical boundary.
      if (prev < this.thresholds.aiSpendAccountCritical) {
        this.fire({
          kind: "ai-spend-account",
          severity: "critical",
          value: next,
          threshold: this.thresholds.aiSpendAccountCritical,
          accountId,
          message: `account ${accountId} AI spend $${next.toFixed(2)}/day crossed critical (${this.thresholds.aiSpendAccountCritical.toFixed(2)}) — anomaly = abuse or a prompt loop`,
        });
      }
    } else if (next >= this.thresholds.aiSpendAccountWarn) {
      if (prev < this.thresholds.aiSpendAccountWarn) {
        this.fire({
          kind: "ai-spend-account",
          severity: "warn",
          value: next,
          threshold: this.thresholds.aiSpendAccountWarn,
          accountId,
          message: `account ${accountId} AI spend $${next.toFixed(2)}/day crossed warn (${this.thresholds.aiSpendAccountWarn.toFixed(2)})`,
        });
      }
    }
  }

  /** Record a storage growth observation (GB added today). */
  recordStorageGrowth(gbAddedToday: number): void {
    if (gbAddedToday >= this.thresholds.storageGrowthCriticalGbPerDay) {
      this.fire({
        kind: "storage-growth",
        severity: "critical",
        value: gbAddedToday,
        threshold: this.thresholds.storageGrowthCriticalGbPerDay,
        message: `storage growth ${gbAddedToday.toFixed(1)} GB/day crossed critical (${this.thresholds.storageGrowthCriticalGbPerDay.toFixed(1)} GB/day)`,
      });
    } else if (gbAddedToday >= this.thresholds.storageGrowthWarnGbPerDay) {
      this.fire({
        kind: "storage-growth",
        severity: "warn",
        value: gbAddedToday,
        threshold: this.thresholds.storageGrowthWarnGbPerDay,
        message: `storage growth ${gbAddedToday.toFixed(1)} GB/day crossed warn (${this.thresholds.storageGrowthWarnGbPerDay.toFixed(1)} GB/day)`,
      });
    }
  }

  /** Fire an alert for an unknown provider model (cost can't be computed). */
  recordUnknownAiModel(opClass: OpClass, provider: Provider, model: string): void {
    this.fire({
      kind: "ai-unknown-model",
      severity: "warn",
      value: 0,
      threshold: 0,
      message: `unknown model: opClass=${opClass} provider=${provider} model=${model} — cost not tracked`,
    });
  }

  /** Daily reset — caller invokes at midnight. */
  resetDaily(): void {
    this.accountSpend.clear();
  }

  private fire(alert: Omit<CostAlert, "ts">): void {
    this.onAlert({ ...alert, ts: this.now() });
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
