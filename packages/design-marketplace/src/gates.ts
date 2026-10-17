/**
 * @supa/design-marketplace/gates
 * ----------------------------------------------------------------
 * Real gate implementations for the publish gauntlet.
 *
 * These wire the contract from `publish.ts` to the actual check
 * functions in @supa/design-tokens (and a stub perf gate for now —
 * the real perf gate is in @supa/design-render's budget checker).
 * ----------------------------------------------------------------
 */

import type {
  TemplatePackage,
} from "./template-package.js";
import type {
  TokensGate,
  A11yGate,
  PerfGate,
  FontsGate,
  CompatGate,
  ProvenanceGate,
  GateFailure,
} from "./publish.js";
import {
  validateTemplateForPublish,
  type BoundNode,
} from "@supa/design-tokens/bindings";
import {
  lintContrastPerVariant,
} from "@supa/design-tokens/variants";
import type { TokenMap, VariantName } from "@supa/design-tokens/schema";

// ───────────────────────────────────────────────
// Tokens gate — no literals in published templates
// ───────────────────────────────────────────────

export class RealTokensGate implements TokensGate {
  /**
   * The host passes the doc's nodes (already deserialized from the
   * package). We delegate to design-tokens' validateTemplateForPublish.
   */
  constructor(
    private readonly extractNodes: (pkg: TemplatePackage) => BoundNode[],
  ) {}

  check(pkg: TemplatePackage): GateFailure | null {
    const nodes = this.extractNodes(pkg);
    const result = validateTemplateForPublish(nodes);
    if (result.ok) return null;
    return {
      gate: "tokens",
      message: `${result.violations.length} literal(s) found in published template — every fill/space/radius/textStyle must be a ref`,
      details: result.violations.map((v) => ({
        id: v.nodeId,
        message: v.message,
      })),
    };
  }
}

// ───────────────────────────────────────────────
// A11y gate — contrast lint per variant
// ───────────────────────────────────────────────

export class RealA11yGate implements A11yGate {
  constructor(
    private readonly extractTokenMap: (pkg: TemplatePackage) => TokenMap,
    private readonly minRatio: number = 3.0,
  ) {}

  check(pkg: TemplatePackage): GateFailure | null {
    const map = this.extractTokenMap(pkg);
    const variants: VariantName[] = ["light", "dark", "contrast-high"];
    const failures: { id: string; message: string }[] = [];
    for (const variant of variants) {
      const result = lintContrastPerVariant(map, variant);
      for (const check of result.checks) {
        if (check.result.ratio < this.minRatio) {
          failures.push({
            id: `${check.fgTokenId}/${check.bgTokenId}`,
            message: `${variant}: ${check.fgTokenId} on ${check.bgTokenId} = ${check.result.ratio}:1 (min ${this.minRatio})`,
          });
        }
      }
    }
    if (failures.length === 0) return null;
    return {
      gate: "a11y",
      message: `${failures.length} contrast failure(s) across variants`,
      details: failures,
    };
  }
}

// ───────────────────────────────────────────────
// Perf gate — renders under budget at 800-layer-equivalent
// ───────────────────────────────────────────────

export interface PerfBudget {
  /** Max node count (the 800-layer-equivalent). */
  maxNodes: number;
  /** Max render time (ms) at mid-tier profile. */
  maxRenderMs: number;
}

export const DEFAULT_PERF_BUDGET: PerfBudget = {
  maxNodes: 800,
  maxRenderMs: 16, // 60fps frame budget
};

export class RealPerfGate implements PerfGate {
  constructor(
    private readonly countNodes: (pkg: TemplatePackage) => number,
    private readonly measureRenderMs: (pkg: TemplatePackage) => number,
    private readonly budget: PerfBudget = DEFAULT_PERF_BUDGET,
  ) {}

  check(pkg: TemplatePackage): GateFailure | null {
    const nodeCount = this.countNodes(pkg);
    if (nodeCount > this.budget.maxNodes) {
      return {
        gate: "perf",
        message: `template has ${nodeCount} nodes; budget is ${this.budget.maxNodes} (a bloated template is a perf regression delivered to every installer)`,
        details: [],
      };
    }
    const renderMs = this.measureRenderMs(pkg);
    if (renderMs > this.budget.maxRenderMs) {
      return {
        gate: "perf",
        message: `template renders in ${renderMs}ms; budget is ${this.budget.maxRenderMs}ms at mid-tier profile`,
        details: [],
      };
    }
    return null;
  }
}

// ───────────────────────────────────────────────
// Fonts gate — license fields complete
// ───────────────────────────────────────────────

export class RealFontsGate implements FontsGate {
  check(pkg: TemplatePackage): GateFailure | null {
    const failures: { id: string; message: string }[] = [];
    for (const req of pkg.fonts.requirements) {
      if (!req.family) {
        failures.push({ id: req.family, message: "font family missing" });
      }
      for (const axis of req.axes) {
        if (axis.license === "unknown") {
          failures.push({
            id: `${req.family}.${axis.name}`,
            message: `axis ${axis.name} has unknown license — must be 'free' or 'commercial'`,
          });
        }
        if (axis.license === "commercial" && (axis.priceMicrocredits ?? 0) <= 0) {
          failures.push({
            id: `${req.family}.${axis.name}`,
            message: `commercial axis ${axis.name} has no price`,
          });
        }
      }
    }
    if (failures.length === 0) return null;
    return {
      gate: "fonts",
      message: `${failures.length} font license issue(s)`,
      details: failures,
    };
  }
}

// ───────────────────────────────────────────────
// Compat gate — op-schema version checked
// ───────────────────────────────────────────────

export class RealCompatGate implements CompatGate {
  constructor(
    private readonly currentOpSchemaVersion: number,
    private readonly currentAppVersion: string,
  ) {}

  check(pkg: TemplatePackage): GateFailure | null {
    if (pkg.compat.opSchemaVersion > this.currentOpSchemaVersion) {
      return {
        gate: "compat",
        message: `template requires op-schema v${pkg.compat.opSchemaVersion}; current is v${this.currentOpSchemaVersion}`,
        details: [],
      };
    }
    // Parse semver and check minAppVersion.
    const minParts = pkg.compat.minAppVersion.split(".").map((p) => parseInt(p, 10));
    const curParts = this.currentAppVersion.split(".").map((p) => parseInt(p, 10));
    for (let i = 0; i < Math.max(minParts.length, curParts.length); i++) {
      const m = minParts[i] ?? 0;
      const c = curParts[i] ?? 0;
      if (c < m) {
        return {
          gate: "compat",
          message: `template requires app v${pkg.compat.minAppVersion}; current is v${this.currentAppVersion}`,
          details: [],
        };
      }
      if (c > m) break;
    }
    return null;
  }
}

// ───────────────────────────────────────────────
// Provenance gate — AI-assisted declared
// ───────────────────────────────────────────────

export class RealProvenanceGate implements ProvenanceGate {
  check(pkg: TemplatePackage): GateFailure | null {
    // The meta.aiAssisted flag must be true if any token has
    // provenance.source === 'ai'. Honesty as a product feature.
    const tokens = pkg.tokens as { tokens?: Map<string, { provenance?: { source?: string } }> } | undefined;
    const tokenMap = tokens?.tokens;
    if (tokenMap && typeof tokenMap.forEach === "function") {
      let hasAiProvenance = false;
      tokenMap.forEach((t: { provenance?: { source?: string } }) => {
        if (t.provenance?.source === "ai") hasAiProvenance = true;
      });
      if (hasAiProvenance && !pkg.meta.aiAssisted) {
        return {
          gate: "provenance",
          message: "template has AI-generated tokens but meta.aiAssisted is false — declare AI assistance honestly",
          details: [],
        };
      }
    }
    return null;
  }
}
