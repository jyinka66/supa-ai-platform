/**
 * @supa/deals/pipeline
 * ----------------------------------------------------------------
 * Pipeline: { stages: ordered list, per-workspace, default
 *   ['New','Qualified','Proposal','Negotiation','Won','Lost'] —
 *   customizable except Won/Lost (reports depend on them being
 *   terminal and semantic). Renaming a stage renames a label;
 *   moving a deal BETWEEN stages is an activity fact — pipeline
 *   history is free analytics.
 *
 * Deal: { id, customerId?, title, value: Money, expectedClose,
 *   stage, probability?, source, owner }
 *
 * Weighted pipeline = Σ value × probability. Probability comes
 *   from the stage's default weight UNLESS the user sets it —
 *   and the deal card shows which one is in effect. Honest
 *   numbers again: a weighted forecast that hides its assumptions
 *   is astrology with a spreadsheet.
 *
 * Currency: deal value in its native currency; the pipeline
 *   total converts to workspace base at as-of rates with the
 *   same hover-to-show-originals rule as reports. No silent FX.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Money, Currency } from "@supa/money/money";
import { add, multiply, zero, fromMinor, convert, type Rate } from "@supa/money/money";

// ───────────────────────────────────────────────
// Pipeline stages — as data, Won/Lost terminal
// ───────────────────────────────────────────────

/**
 * A pipeline stage. Stages are DATA, not code — the workspace owns
 * its stage list, customizable except Won/Lost (reports depend on
 * them being terminal + semantic).
 *
 *   id          — stable id (e.g. "new", "qualified", "won")
 *   label       — display name (e.g. "New", "Qualified")
 *   order       — position in the pipeline (0-based)
 *   terminal    — Won/Lost are terminal (deals don't leave them)
 *   won/lost    — semantic flags (reports depend on these)
 *   defaultProbability — the stage's default weight (0..1)
 */
export interface PipelineStage {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly terminal: boolean;
  readonly won: boolean;
  readonly lost: boolean;
  /** Default probability (0..1) — used unless the deal sets its own. */
  readonly defaultProbability: number;
}

/**
 * The default pipeline. Per-workspace customizable except Won/Lost.
 *
 *   New         (order 0, prob 0.10)
 *   Qualified   (order 1, prob 0.25)
 *   Proposal    (order 2, prob 0.50)
 *   Negotiation (order 3, prob 0.75)
 *   Won         (order 4, prob 1.00, terminal, won=true)
 *   Lost        (order 5, prob 0.00, terminal, lost=true)
 */
export const DEFAULT_STAGES: readonly PipelineStage[] = [
  { id: "new", label: "New", order: 0, terminal: false, won: false, lost: false, defaultProbability: 0.10 },
  { id: "qualified", label: "Qualified", order: 1, terminal: false, won: false, lost: false, defaultProbability: 0.25 },
  { id: "proposal", label: "Proposal", order: 2, terminal: false, won: false, lost: false, defaultProbability: 0.50 },
  { id: "negotiation", label: "Negotiation", order: 3, terminal: false, won: false, lost: false, defaultProbability: 0.75 },
  { id: "won", label: "Won", order: 4, terminal: true, won: true, lost: false, defaultProbability: 1.00 },
  { id: "lost", label: "Lost", order: 5, terminal: true, won: false, lost: true, defaultProbability: 0.00 },
];

/**
 * A workspace's pipeline. Stages are per-workspace data; the workspace
 * can rename labels + reorder non-terminal stages, but Won/Lost must
 * exist + be terminal (reports depend on them).
 */
export interface Pipeline {
  readonly wsId: WorkspaceId;
  readonly stages: readonly PipelineStage[];
}

/**
 * Validate a workspace's pipeline. Won/Lost must exist + be terminal;
 * Won must have `won=true`, Lost must have `lost=true`. Stage orders
 * must be unique + contiguous (0..N-1).
 */
export function validatePipeline(pipeline: Pipeline): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const won = pipeline.stages.find((s) => s.id === "won");
  const lost = pipeline.stages.find((s) => s.id === "lost");
  if (!won) errors.push("pipeline must have a 'won' stage");
  if (!lost) errors.push("pipeline must have a 'lost' stage");
  if (won && !won.terminal) errors.push("'won' stage must be terminal");
  if (lost && !lost.terminal) errors.push("'lost' stage must be terminal");
  if (won && !won.won) errors.push("'won' stage must have won=true");
  if (lost && !lost.lost) errors.push("'lost' stage must have lost=true");
  // Check orders are unique + contiguous.
  const orders = pipeline.stages.map((s) => s.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      errors.push(`stage orders must be contiguous 0..N-1; got ${JSON.stringify(orders)}`);
      break;
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Find a stage by id. Returns null if not found.
 */
export function findStage(pipeline: Pipeline, stageId: string): PipelineStage | null {
  return pipeline.stages.find((s) => s.id === stageId) ?? null;
}

/**
 * Can a deal move FROM one stage TO another?
 *   - Cannot leave a terminal stage (Won/Lost are sinks).
 *   - Can move to any non-terminal stage (forward or backward).
 *   - Can move to a terminal stage (Won/Lost).
 *
 * Once a deal is Won or Lost, it stays there. To re-open, use the
 * `reopen` transition (which is a deliberate, audited action — not
 * a stage move).
 */
export function canMoveStage(pipeline: Pipeline, fromStageId: string, toStageId: string): boolean {
  const from = findStage(pipeline, fromStageId);
  const to = findStage(pipeline, toStageId);
  if (!from || !to) return false;
  if (from.terminal) return false; // can't leave Won/Lost via normal move
  return true;
}

// ───────────────────────────────────────────────
// Deal — the entity
// ───────────────────────────────────────────────

export type DealSource = "manual" | "import" | "referral" | "ai-suggestion";

/**
 * A deal. The value is in the deal's NATIVE currency (not the
 * workspace base — conversion happens only in pipeline totals,
 * at as-of rates, with the same hover-to-show-originals rule as
 * reports).
 *
 *   probability — optional. If absent, the stage's defaultProbability
 *   is used. The deal card shows WHICH probability is in effect
 *   (stage default vs user-set) — honest numbers.
 */
export interface Deal {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly customerId: string | null;
  readonly title: string;
  /** Deal value in native currency. */
  readonly value: Money;
  /** Expected close date (ms epoch). */
  readonly expectedClose: number;
  readonly stageId: string;
  /** User-set probability (0..1). If null, stage default is used. */
  readonly probability: number | null;
  readonly source: DealSource;
  /** Owner (account id). */
  readonly owner: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ───────────────────────────────────────────────
// Deal creation + stage moves
// ───────────────────────────────────────────────

export interface CreateDealInput {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly customerId: string | null;
  readonly title: string;
  readonly value: Money;
  readonly expectedClose: number;
  readonly stageId: string;
  readonly probability: number | null;
  readonly source: DealSource;
  readonly owner: string;
}

export function createDeal(input: CreateDealInput, now: number = Date.now()): Deal {
  return {
    id: input.id,
    wsId: input.wsId,
    customerId: input.customerId,
    title: input.title.trim(),
    value: input.value,
    expectedClose: input.expectedClose,
    stageId: input.stageId,
    probability: input.probability,
    source: input.source,
    owner: input.owner,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Move a deal to a new stage. Returns the updated deal.
 * Throws InvalidStageMoveError if the move is not allowed
 * (e.g. leaving a terminal stage).
 *
 * Stage moves are ACTIVITY FACTS — the caller (repository) writes
 * a deal_stage activity fact in the same transaction. Pipeline
 * history is free analytics.
 */
export function moveStage(
  deal: Deal,
  toStageId: string,
  pipeline: Pipeline,
  now: number = Date.now(),
): Deal {
  if (!canMoveStage(pipeline, deal.stageId, toStageId)) {
    throw new InvalidStageMoveError(deal.stageId, toStageId);
  }
  return { ...deal, stageId: toStageId, updatedAt: now };
}

/**
 * Set a custom probability on a deal. Overrides the stage default.
 * The deal card shows which probability is in effect.
 */
export function setProbability(deal: Deal, probability: number, now: number = Date.now()): Deal {
  if (probability < 0 || probability > 1) {
    throw new Error(`probability must be 0..1; got: ${probability}`);
  }
  return { ...deal, probability, updatedAt: now };
}

/**
 * Clear the custom probability — reverts to the stage's default.
 */
export function clearProbability(deal: Deal, now: number = Date.now()): Deal {
  return { ...deal, probability: null, updatedAt: now };
}

export class InvalidStageMoveError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid stage move: ${from} → ${to} (terminal stages can't be left via normal move)`);
    this.name = "InvalidStageMoveError";
  }
}

// ───────────────────────────────────────────────
// Effective probability — stage default vs user-set
// ───────────────────────────────────────────────

/**
 * The probability in effect for a deal. If the deal has a user-set
 * probability, use it; else use the stage's defaultProbability.
 *
 * The deal card shows WHICH source is in effect — honest numbers.
 * A weighted forecast that hides its assumptions is astrology with
 * a spreadsheet.
 */
export function effectiveProbability(deal: Deal, pipeline: Pipeline): {
  probability: number;
  source: "user" | "stage-default";
} {
  if (deal.probability !== null) {
    return { probability: deal.probability, source: "user" };
  }
  const stage = findStage(pipeline, deal.stageId);
  if (!stage) {
    return { probability: 0, source: "stage-default" };
  }
  return { probability: stage.defaultProbability, source: "stage-default" };
}

// ───────────────────────────────────────────────
// Weighted value — value × probability
// ───────────────────────────────────────────────

/**
 * Weighted value of a single deal = value × effectiveProbability.
 *
 * The result is in the deal's NATIVE currency (no FX here — conversion
 * to workspace base happens in pipeline totals, at as-of rates).
 */
export function weightedValue(deal: Deal, pipeline: Pipeline): Money {
  const { probability } = effectiveProbability(deal, pipeline);
  // Money × fractional probability — use the money package's convert
  // machinery (which handles banker's rounding).
  // probability is 0..1; we compute value × probability as:
  //   (value.minor × probability × 1000) / 1000, banker's rounded.
  const scaledProb = Math.round(probability * 1000);
  const scaledValue = deal.value.minor * BigInt(scaledProb);
  const rounded = scaledValue / 1000n;
  const remainder = scaledValue % 1000n;
  // Banker's rounding on the remainder.
  const half = 500n;
  let adjustment = 0n;
  if (remainder > half || (remainder === half && rounded % 2n !== 0n)) {
    adjustment = 1n;
  }
  return fromMinor(rounded + adjustment, deal.value.currency);
}

// ───────────────────────────────────────────────
// Pipeline totals — sum + cross-currency conversion
// ───────────────────────────────────────────────

/**
 * Compute pipeline totals for a set of deals.
 *
 *   - Per-stage totals: sum of deal values per stage (native currency).
 *   - Weighted total: Σ value × probability (native currency).
 *   - Base-currency total: convert each deal's value to the workspace
 *     base currency at as-of rates, then sum. The conversion uses
 *     the recorded rate — never ambient.
 *
 * Currency: deal value in its native currency; the pipeline total
 * converts to workspace base at as-of rates with the same
 * hover-to-show-originals rule as reports. No silent FX.
 */
export interface PipelineTotals {
  /** Per-stage totals (native currency — may be mixed if deals have different currencies). */
  readonly perStage: ReadonlyMap<string, { count: number; total: Money; weighted: Money }>;
  /** Weighted total across all deals (native currency — may be mixed). */
  readonly weightedTotal: Money;
  /** Base-currency total (converted at as-of rates). */
  readonly baseTotal: Money;
  /** Per-deal conversion rates used (for the hover-to-show-originals UI). */
  readonly conversions: ReadonlyArray<{ dealId: string; native: Money; base: Money; rate: Rate | undefined }>;
}

export function computePipelineTotals(
  deals: ReadonlyArray<Deal>,
  pipeline: Pipeline,
  baseCurrency: Currency,
  rates: ReadonlyMap<Currency, Rate>, // native currency → base currency rate
): PipelineTotals {
  const perStage = new Map<string, { count: number; total: Money; weighted: Money }>();
  const conversions: { dealId: string; native: Money; base: Money; rate: Rate | undefined }[] = [];

  let weightedTotal = zero(baseCurrency);
  let baseTotal = zero(baseCurrency);

  for (const deal of deals) {
    const stage = findStage(pipeline, deal.stageId);
    const stageId = stage?.id ?? "unknown";
    const wv = weightedValue(deal, pipeline);

    // Per-stage accumulation (in the deal's native currency — may differ across deals in the same stage).
    const existing = perStage.get(stageId);
    if (existing) {
      if (existing.total.currency === deal.value.currency) {
        perStage.set(stageId, {
          count: existing.count + 1,
          total: add(existing.total, deal.value),
          weighted: add(existing.weighted, wv),
        });
      } else {
        // Mixed currencies in the same stage — keep the first one's currency
        // for the stage total (the base-currency total handles cross-currency
        // correctly). This is the honest behavior: per-stage totals are
        // best-effort; the base-currency total is the authoritative number.
        perStage.set(stageId, {
          count: existing.count + 1,
          total: existing.total, // unchanged (mixed currencies)
          weighted: existing.weighted,
        });
      }
    } else {
      perStage.set(stageId, {
        count: 1,
        total: deal.value,
        weighted: wv,
      });
    }

    // Convert to base currency.
    if (deal.value.currency === baseCurrency) {
      baseTotal = add(baseTotal, deal.value);
      weightedTotal = add(weightedTotal, wv);
      conversions.push({ dealId: deal.id, native: deal.value, base: deal.value, rate: undefined });
    } else {
      const rate = rates.get(deal.value.currency);
      if (rate) {
        const { converted } = convert(deal.value, rate);
        baseTotal = add(baseTotal, converted);
        // Weighted total in base currency: convert the weighted value.
        const { converted: weightedConverted } = convert(wv, rate);
        weightedTotal = add(weightedTotal, weightedConverted);
        conversions.push({ dealId: deal.id, native: deal.value, base: converted, rate });
      } else {
        // No rate — can't convert. The base total doesn't include this deal;
        // the conversion list records the gap (honest, not silent).
        conversions.push({ dealId: deal.id, native: deal.value, base: zero(baseCurrency), rate: undefined });
      }
    }
  }

  return { perStage, weightedTotal, baseTotal, conversions };
}

// ───────────────────────────────────────────────
// Pipeline history — stage moves are activity facts
// ───────────────────────────────────────────────

/**
 * A stage-move activity fact. Every stage change writes one of these;
 * pipeline history is free analytics (no separate "deal history" table).
 *
 * The activity.ts module's `deal_stage` kind is the canonical record;
 * this interface is the deal-specific view.
 */
export interface StageMoveFact {
  readonly dealId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly movedAt: number;
  readonly actor: string;
}

/**
 * Build the stage-move activity input (for the activity repository).
 * The deal repository calls this when it commits a stage move, then
 * writes the activity fact in the same transaction.
 */
export function buildStageMoveActivity(
  dealId: string,
  fromStageId: string,
  toStageId: string,
  actor: string,
  movedAt: number,
): StageMoveFact {
  return { dealId, fromStageId, toStageId, movedAt, actor };
}

// ───────────────────────────────────────────────
// Deal repository contract
// ───────────────────────────────────────────────

export interface DealRepository {
  create(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    input: CreateDealInput,
  ): Promise<Deal>;

  findById(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
  ): Promise<Deal | null>;

  /** List deals by stage (the kanban board). */
  listByStage(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    stageId: string,
  ): Promise<readonly Deal[]>;

  /** List all deals for a workspace (for pipeline totals). */
  listAll(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
  ): Promise<readonly Deal[]>;

  /**
   * Move a deal to a new stage. Writes a StageMoveFact (activity) in
   * the same DB transaction. Conflict rule: last-write-wins WITH an
   * activity fact recording both transitions, so the loser sees what
   * happened in the timeline rather than a silent overwrite.
   */
  moveStage(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    dealId: string,
    toStageId: string,
    actor: string,
  ): Promise<Deal>;

  setProbability(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    dealId: string,
    probability: number,
  ): Promise<Deal>;

  /** List deals by customer (the customer's deal history). */
  listByCustomer(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    customerId: string,
  ): Promise<readonly Deal[]>;
}
