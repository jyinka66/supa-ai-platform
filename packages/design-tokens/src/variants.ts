/**
 * @supa/design-tokens/variants
 * ----------------------------------------------------------------
 * Dark mode is not a copy of the doc. Variant resolution picks the
 * active variant set at render time:
 *   - editor chrome: variant from user preference
 *   - doc canvas: variant from doc setting (with preview toggle in
 *     the editor — variant is a render parameter, not a doc copy)
 *   - presentation/export: variant from the share/export settings
 *
 * Typography/color contrast lint runs per-variant: a dark variant
 * with 2.1:1 contrast fails template publish and flags user docs
 * softly (a11y warnings in the inspector, never silent).
 * ----------------------------------------------------------------
 */

import type { ResolvedTable, VariantName } from "./schema.js";
import { resolveTable } from "./schema.js";

// ───────────────────────────────────────────────
// Variant source — where the active variant comes from
// ───────────────────────────────────────────────

export type VariantSource = "editor-chrome" | "doc-canvas" | "presentation" | "export";

export interface VariantContext {
  source: VariantSource;
  /** The active variant for this render. */
  variant: VariantName;
  /** Optional preview toggle — preview a different variant without changing the doc. */
  previewVariant?: VariantName;
}

/**
 * The variant is a render parameter, not a doc copy. The same doc
 * can render in light for the editor canvas, dark for an exported
 * share link, and contrast-high for accessibility auditing — all
 * from the same doc rev.
 */
export function pickActiveVariant(ctx: VariantContext): VariantName {
  // Preview variant takes precedence if set (for the editor preview
  // toggle), else the active variant.
  return ctx.previewVariant ?? ctx.variant;
}

// ───────────────────────────────────────────────
// Per-variant resolved table
// ───────────────────────────────────────────────

/**
 * Resolve the token table for a specific variant. The variant picks
 * the variant-specific override if present, else the base value.
 */
export function resolveForVariant(
  map: import("./schema.js").TokenMap,
  variant: VariantName,
): ResolvedTable {
  return resolveTable(map, variant);
}

// ───────────────────────────────────────────────
// Contrast lint — runs per-variant
// ───────────────────────────────────────────────

export interface ContrastCheckResult {
  ok: boolean;
  /** Foreground/background contrast ratio (1..21). */
  ratio: number;
  /** WCAG level met: "AAA" (≥7), "AA" (≥4.5), "AA-large" (≥3), "fail" (<3). */
  level: "AAA" | "AA" | "AA-large" | "fail";
  message: string;
}

/**
 * WCAG contrast ratio between two colors. Used by the per-variant
 * contrast lint.
 *
 *   AAA: ≥7
 *   AA:  ≥4.5
 *   AA-large: ≥3
 *   fail: <3
 */
export function contrastRatio(fg: string, bg: string): ContrastCheckResult {
  const fgRgb = parseHex(fg);
  const bgRgb = parseHex(bg);
  if (!fgRgb || !bgRgb) {
    return { ok: false, ratio: 0, level: "fail", message: `unparseable color: fg=${fg} bg=${bg}` };
  }
  const l1 = relativeLuminance(fgRgb);
  const l2 = relativeLuminance(bgRgb);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  const ratio = (lighter + 0.05) / (darker + 0.05);
  const level: ContrastCheckResult["level"] =
    ratio >= 7 ? "AAA" :
    ratio >= 4.5 ? "AA" :
    ratio >= 3 ? "AA-large" :
    "fail";
  return {
    ok: level !== "fail",
    ratio: Math.round(ratio * 100) / 100,
    level,
    message: `contrast ${ratio.toFixed(2)}:1 (${level})`,
  };
}

/**
 * Per-variant contrast lint. Checks every text-bearing token against
 * its likely background token (heuristic: same name with "surface"
 * or "bg" prefix).
 *
 * A dark variant with 2.1:1 contrast fails template publish.
 * User docs flag softly — a11y warnings in the inspector, never silent.
 */
export interface ContrastLintResult {
  variant: VariantName;
  /** Per-pair checks. */
  checks: {
    fgTokenId: string;
    bgTokenId: string;
    fgValue: string;
    bgValue: string;
    result: ContrastCheckResult;
  }[];
  /** True if any check fails below AA-large (3:1). */
  hasFailures: boolean;
}

export function lintContrastPerVariant(
  map: import("./schema.js").TokenMap,
  variant: VariantName,
): ContrastLintResult {
  const table = resolveForVariant(map, variant);
  const checks: ContrastLintResult["checks"] = [];

  // Heuristic pairing: every "text.*" or "fg.*" token against every
  // "surface.*" or "bg.*" token. Real impl uses token metadata to
  // declare pairs; this is the fallback for tokens without metadata.
  const fgs: { id: string; value: string }[] = [];
  const bgs: { id: string; value: string }[] = [];
  for (const [id, t] of table) {
    if (t.type !== "color") continue;
    const lower = id.toLowerCase();
    if (lower.includes("text") || lower.includes("fg") || lower.includes("foreground")) {
      fgs.push({ id, value: t.value });
    } else if (lower.includes("surface") || lower.includes("bg") || lower.includes("background")) {
      bgs.push({ id, value: t.value });
    }
  }

  for (const fg of fgs) {
    for (const bg of bgs) {
      if (fg.id === bg.id) continue;
      const result = contrastRatio(fg.value, bg.value);
      checks.push({
        fgTokenId: fg.id,
        bgTokenId: bg.id,
        fgValue: fg.value,
        bgValue: bg.value,
        result,
      });
    }
  }

  const hasFailures = checks.some((c) => !c.result.ok);
  return { variant, checks, hasFailures };
}

// ───────────────────────────────────────────────
// Helpers — color parsing + relative luminance (WCAG)
// ───────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (/^[0-9a-f]{3}$/.test(h)) {
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
  }
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  // WCAG formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
