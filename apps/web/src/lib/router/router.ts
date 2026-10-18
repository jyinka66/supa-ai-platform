import { ProviderHealth } from "./health";

export type Provider = "gemini" | "groq" | "openrouter";

export type RouteMode =
  | "chat"
  | "write"
  | "rewrite"
  | "summarize"
  | "translate"
  | "code"
  | "image"
  | "document"
  | "plan";

export interface RouteRequest {
  mode: RouteMode;
  needsVision?: boolean;
  userOverride?: string;
  language: string;
  estimatedCostUsd?: number;
  remainingBudgetUsd?: number;
}

export interface RouteResult {
  provider: Provider;
  /** Concrete model identifier (e.g. "gemini-3.8-flash", not just "gemini"). */
  model: string;
  reason:
    | "user_override"
    | "priority_pick"
    | "budget_aware_pick"
    | "all_unhealthy_last_resort"
    | "no_capable_provider";
}

interface ProviderConfig {
  capabilities: readonly string[];
  /** Cost in USD per 1k output tokens. */
  costPer1k: number;
  /** Lower = preferred. */
  priority: number;
  /** Concrete model identifier to send to the provider API. */
  model: string;
  /** True if this provider can serve image-generation requests. */
  supportsImageGeneration: boolean;
}

const CATALOG: Record<Provider, ProviderConfig> = {
  gemini: {
    capabilities: ["text", "vision", "multilingual"] as const,
    costPer1k: 0.005,
    priority: 1,
    model: "gemini-3.8-flash",
    supportsImageGeneration: false,
  },
  groq: {
    capabilities: ["text", "fast"] as const,
    costPer1k: 0.001,
    priority: 2,
    model: "openai/gpt-oss-120b",
    supportsImageGeneration: false,
  },
  openrouter: {
    capabilities: ["text", "vision", "variety"] as const,
    costPer1k: 0.004,
    priority: 3,
    model: "openrouter/auto",
    supportsImageGeneration: false,
  },
};

function isProvider(value: unknown): value is Provider {
  return value === "gemini" || value === "groq" || value === "openrouter";
}

export class ModelRouter {
  private readonly health = new ProviderHealth();

  /**
   * Picks the best provider for a request.
   *
   * Selection order:
   *   1. User override — if the caller pinned a provider, honour it (unless circuit is hard-open).
   *   2. Filter healthy providers that satisfy capability requirements (vision / image generation).
   *   3. Of those, drop any whose estimated cost exceeds remaining budget.
   *   4. Among the survivors, pick by priority (gemini > groq > openrouter).
   *   5. If no survivors, retry the cheapest healthy provider (regardless of vision capability)
   *      with a "last resort" flag so the caller can degrade gracefully.
   *   6. If even that fails, return `no_capable_provider` so the caller can surface a 503.
   */
  route(req: RouteRequest): RouteResult {
    // 1. User override.
    if (req.userOverride) {
      const override = req.userOverride as Provider;
      if (!isProvider(override)) {
        // Unknown override — fall through to normal routing rather than
        // risking a runtime crash when the caller tries to use it.
      } else if (this.health.isHealthy(override)) {
        const cfg = CATALOG[override];
        if (this.fitsBudget(cfg, req)) {
          return {
            provider: override,
            model: cfg.model,
            reason: "user_override",
          };
        }
        // Override doesn't fit budget — fall through to cheaper alternatives.
      }
      // Override is unhealthy — fall through to normal selection.
    }

    // 2. Filter by capability + health.
    const capable = (Object.keys(CATALOG) as Provider[]).filter((p) => {
      const cfg = CATALOG[p];
      if (!this.health.isHealthy(p)) return false;
      if (req.needsVision && !cfg.capabilities.includes("vision")) return false;
      if (req.mode === "image" && !cfg.supportsImageGeneration) return false;
      return true;
    });

    // 3. Drop providers that would blow the budget.
    const withinBudget = capable.filter((p) => this.fitsBudget(CATALOG[p], req));

    // 4. Pick by priority.
    const survivors = withinBudget.length > 0 ? withinBudget : capable;
    if (survivors.length > 0) {
      survivors.sort((a, b) => CATALOG[a].priority - CATALOG[b].priority);
      const primary = survivors[0]!;
      return {
        provider: primary,
        model: CATALOG[primary].model,
        reason: withinBudget.length > 0 ? "priority_pick" : "budget_aware_pick",
      };
    }

    // 5. Last resort — cheapest healthy provider, ignoring vision capability.
    //    The caller is expected to degrade (e.g. reject the image, return text-only).
    const anyHealthy = (Object.keys(CATALOG) as Provider[])
      .filter((p) => this.health.isHealthy(p))
      .sort((a, b) => CATALOG[a].costPer1k - CATALOG[b].costPer1k);
    if (anyHealthy.length > 0) {
      const fallback = anyHealthy[0]!;
      return {
        provider: fallback,
        model: CATALOG[fallback].model,
        reason: "all_unhealthy_last_resort",
      };
    }

    // 6. All providers are down. Caller should 503.
    return {
      provider: "groq",
      model: CATALOG.groq.model,
      reason: "no_capable_provider",
    };
  }

  /**
   * Reports a request outcome back to the health tracker.
   *
   * NOTE: do NOT call `openCircuit()` on every error — the ProviderHealth
   * class auto-opens the circuit when the failure threshold (5 in WINDOW)
   * is crossed. Manually opening on every transient error would prevent
   * recovery.
   *
   * Only force-open the circuit for explicit out-of-band signals, e.g.
   * a 401 (key revoked) or a 429 with a long Retry-After.
   */
  onResult(provider: Provider, firstTokenMs: number | null, error: boolean): void {
    this.health.record(provider, firstTokenMs, error);
  }

  /**
   * Force-opens the circuit for a provider. Use for non-transient errors
   * (e.g. invalid API key, account suspended). For normal request errors,
   * just call `onResult()` and let the threshold handle it.
   */
  forceCircuitOpen(provider: Provider, durationMs?: number): void {
    this.health.openCircuit(provider, durationMs);
  }

  /** Exposed for metrics / observability endpoints. */
  getHealthSnapshot(provider: Provider) {
    return this.health.snapshot(provider);
  }

  /**
   * Returns a compact health score per provider — 1.0 = perfectly healthy,
   * 0.0 = circuit hard-open. Useful for dashboards and tests that need a
   * single number per provider rather than the full HealthSnapshot.
   *
   * Score derivation:
   *   - Circuit open (cool-down) → 0.0
   *   - Half-open (probe in flight) → 0.5
   *   - Otherwise → 1 - (failureRate within window), clamped to [0, 1].
   *
   * The score is derived from the HealthSnapshot; it's not stored. This
   * keeps it consistent with the actual routing decisions made by
   * `isHealthy()`.
   */
  getHealthScores(): Record<Provider, number> {
    const result = {} as Record<Provider, number>;
    for (const p of this.knownProviders) {
      const snap = this.health.snapshot(p);
      if (snap.circuitOpen) {
        result[p] = 0;
      } else if (snap.halfOpen) {
        result[p] = 0.5;
      } else {
        result[p] = Math.max(0, 1 - snap.errorRate);
      }
    }
    return result;
  }

  /** Exposed for tests. */
  get knownProviders(): Provider[] {
    return Object.keys(CATALOG) as Provider[];
  }

  private fitsBudget(cfg: ProviderConfig, req: RouteRequest): boolean {
    if (req.remainingBudgetUsd === undefined || req.estimatedCostUsd === undefined) {
      return true; // no budget info — assume it fits
    }
    // If we don't know the request size, assume the estimated cost is for the
    // average response. Compare against the budget directly.
    return req.estimatedCostUsd <= req.remainingBudgetUsd;
  }
}
