/**
 * @supa/design-tokens/bindings
 * ----------------------------------------------------------------
 * A token is useless until design nodes reference it. Bindings:
 *   node fill = { kind: 'ref', token: 'brand.primary' }
 *            | { kind: 'literal', value }
 *
 *   1. Template authoring rule (enforced at template publish):
 *      every fill/space/radius/text-style in a published template
 *      MUST be a ref. Publish fails on literals. This is the single
 *      rule that makes re-theming arithmetic.
 *
 *   2. Extract-to-token editor action: select nodes → find same-value
 *      literals → "N layers share this fill; extract as token [name]?"
 *      — converts literals to refs in one batch op (undoable, because ops).
 *
 *   3. Diff-and-suggest: a linter that walks a doc, groups near-identical
 *      values (color distance < ε, space by scale step), suggests tokens.
 *
 *   4. Re-theme: swapping a template's theme = one transform: resolve
 *      new token values → every ref-bearing node updates via the normal
 *      op path → renderer/RenderCache invalidates by rev. A re-theme is
 *      just ops, so it syncs, undoes, and conflicts like any edit.
 * ----------------------------------------------------------------
 */

import type { ResolvedTable, VariantName, Token } from "./schema.js";

// ───────────────────────────────────────────────
// Node binding shape (mirrors design-model's Fill/Style)
// ───────────────────────────────────────────────

export type BoundValue =
  | { kind: "ref"; token: string }
  | { kind: "literal"; value: string };

export interface BoundNode {
  id: string;
  fill?: BoundValue;
  space?: BoundValue;
  radius?: BoundValue;
  textStyle?: BoundValue;
}

// ───────────────────────────────────────────────
// 1. Template authoring rule — literals fail publish
// ───────────────────────────────────────────────

export interface PublishValidationResult {
  ok: boolean;
  /** Per-node violations — node ids that have literals instead of refs. */
  violations: {
    nodeId: string;
    field: "fill" | "space" | "radius" | "textStyle";
    literalValue: string;
    message: string;
  }[];
}

/**
 * THE rule. Every fill/space/radius/text-style in a published template
 * MUST be a ref. Publish fails on literals. This single rule makes
 * re-theming arithmetic — swap a token value, every ref-bearing node
 * updates without per-node edits.
 */
export function validateTemplateForPublish(nodes: BoundNode[]): PublishValidationResult {
  const violations: PublishValidationResult["violations"] = [];
  for (const node of nodes) {
    for (const field of ["fill", "space", "radius", "textStyle"] as const) {
      const v = node[field];
      if (v && v.kind === "literal") {
        violations.push({
          nodeId: node.id,
          field,
          literalValue: v.value,
          message: `${node.id}.${field} is a literal ("${v.value}") — published templates must use refs`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// ───────────────────────────────────────────────
// 2. Extract-to-token batch op
// ───────────────────────────────────────────────

export interface ExtractTokenSuggestion {
  /** Proposed token name, e.g. "brand.primary" or "surface.1". */
  proposedName: string;
  /** The literal value to extract. */
  value: string;
  /** Node ids that share this value. */
  nodeIds: string[];
  /** The field (fill/space/radius/textStyle) being extracted. */
  field: "fill" | "space" | "radius" | "textStyle";
}

/**
 * Find same-value literals across a selection (or whole page) and
 * suggest extracting them as a token.
 *
 * "N layers share this fill; extract as token [name]?" — converts
 * literals to refs in one batch op. Undoable, because ops.
 */
export function findExtractableLiterals(
  nodes: BoundNode[],
  opts?: { minOccurrences?: number; fields?: ("fill" | "space" | "radius" | "textStyle")[] },
): ExtractTokenSuggestion[] {
  const minOccurrences = opts?.minOccurrences ?? 2;
  const fields = opts?.fields ?? (["fill", "space", "radius", "textStyle"] as const);
  const suggestions: ExtractTokenSuggestion[] = [];

  for (const field of fields) {
    // Group node ids by literal value.
    const byValue = new Map<string, string[]>();
    for (const node of nodes) {
      const v = node[field];
      if (v && v.kind === "literal") {
        const list = byValue.get(v.value) ?? [];
        list.push(node.id);
        byValue.set(v.value, list);
      }
    }
    // Filter to values shared by ≥ minOccurrences nodes.
    for (const [value, nodeIds] of byValue) {
      if (nodeIds.length >= minOccurrences) {
        suggestions.push({
          proposedName: suggestTokenName(field, value),
          value,
          nodeIds,
          field,
        });
      }
    }
  }

  return suggestions;
}

function suggestTokenName(field: string, value: string): string {
  // Heuristic — production uses a smarter namer (color-name library,
  // space-scale index, etc.). This is a stable, deterministic namer
  // for tests + initial UX.
  if (field === "fill") {
    // For colors, use the hex prefix + short hash.
    const hex = value.replace("#", "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return `color.${hex.slice(0, 4)}`;
    }
    return `color.${value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
  }
  return `${field}.${value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
}

// ───────────────────────────────────────────────
// 3. Diff-and-suggest linter
// ───────────────────────────────────────────────

export interface DiffSuggestion {
  /** Existing token id that's close to a literal value. */
  tokenId: string;
  /** The literal value found in the doc. */
  literalValue: string;
  /** The token's resolved value. */
  tokenValue: string;
  /** Distance metric (0 = identical). */
  distance: number;
  /** Node ids using the literal. */
  nodeIds: string[];
  field: "fill" | "space" | "radius" | "textStyle";
  message: string;
}

/**
 * Walk a doc, group near-identical values, suggest tokens.
 * Surfaces "your doc has 47 near-blacks" honestly instead of silently.
 *
 * - Colors: distance via CIE76-ish delta in RGB space (cheap, good enough).
 * - Spaces: distance via scale-step difference (if within 1 step of a
 *   space token, suggest it).
 * - Other fields: exact match only (no near-match).
 */
export function diffAndSuggest(
  nodes: BoundNode[],
  resolvedTable: ResolvedTable,
  opts?: { colorEpsilon?: number; spaceStepEpsilon?: number },
): DiffSuggestion[] {
  const colorEpsilon = opts?.colorEpsilon ?? 12; // ~12/255 RGB distance
  const spaceStepEpsilon = opts?.spaceStepEpsilon ?? 1;
  const suggestions: DiffSuggestion[] = [];

  // Index tokens by type for fast lookup.
  const colorTokens: { id: string; value: string; rgb: [number, number, number] }[] = [];
  const spaceTokens: { id: string; value: number }[] = [];
  for (const [id, t] of resolvedTable) {
    if (t.type === "color") {
      const rgb = parseHex(t.value);
      if (rgb) colorTokens.push({ id, value: t.value, rgb });
    } else if (t.type === "space") {
      const n = parseFloat(t.value);
      if (!Number.isNaN(n)) spaceTokens.push({ id, value: n });
    }
  }

  for (const field of ["fill", "space", "radius", "textStyle"] as const) {
    const byValue = new Map<string, string[]>();
    for (const node of nodes) {
      const v = node[field];
      if (v && v.kind === "literal") {
        const list = byValue.get(v.value) ?? [];
        list.push(node.id);
        byValue.set(v.value, list);
      }
    }
    for (const [literalValue, nodeIds] of byValue) {
      if (field === "fill") {
        const rgb = parseHex(literalValue);
        if (!rgb) continue;
        for (const ct of colorTokens) {
          const dist = colorDistance(rgb, ct.rgb);
          if (dist <= colorEpsilon) {
            suggestions.push({
              tokenId: ct.id,
              literalValue,
              tokenValue: ct.value,
              distance: Math.round(dist * 100) / 100,
              nodeIds,
              field,
              message: `${nodeIds.length} layer(s) use ${literalValue} — close to token ${ct.id} (${ct.value}, Δ=${Math.round(dist)})`,
            });
            break; // one suggestion per literal value
          }
        }
      } else if (field === "space") {
        const n = parseFloat(literalValue);
        if (Number.isNaN(n)) continue;
        for (const st of spaceTokens) {
          if (Math.abs(n - st.value) <= spaceStepEpsilon) {
            suggestions.push({
              tokenId: st.id,
              literalValue,
              tokenValue: String(st.value),
              distance: Math.abs(n - st.value),
              nodeIds,
              field,
              message: `${nodeIds.length} layer(s) use ${literalValue} — matches token ${st.id} (within ${spaceStepEpsilon} step)`,
            });
            break;
          }
        }
      }
    }
  }

  return suggestions;
}

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

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  // Euclidean in RGB space — cheap, good enough for "near-black" grouping.
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

// ───────────────────────────────────────────────
// 4. Re-theme — swap token values, refs propagate via ops
// ───────────────────────────────────────────────

/**
 * Re-theme: swap a template's theme = one transform. Resolve new
 * token values → every ref-bearing node updates via the normal op
 * path → renderer/RenderCache invalidates by rev as always.
 *
 * A re-theme is just ops, so it syncs, undoes, and conflicts like
 * any edit. No special case anywhere.
 *
 * This function produces the SetStyle ops that update ref-bearing
 * nodes to their new resolved values. The caller applies them via
 * the normal op path (sync-hub ingest).
 */
export interface ReThemeOp {
  kind: "SetStyle";
  nodeId: string;
  field: "fill" | "space" | "radius" | "textStyle";
  /** New literal value resolved from the new theme's token table. */
  value: string;
}

export function computeReThemeOps(
  nodes: BoundNode[],
  newTable: ResolvedTable,
): ReThemeOp[] {
  const ops: ReThemeOp[] = [];
  for (const node of nodes) {
    for (const field of ["fill", "space", "radius", "textStyle"] as const) {
      const v = node[field];
      if (v && v.kind === "ref") {
        const resolved = newTable.get(v.token);
        if (resolved) {
          ops.push({
            kind: "SetStyle",
            nodeId: node.id,
            field,
            value: resolved.value,
          });
        }
      }
    }
  }
  return ops;
}

// ───────────────────────────────────────────────
// Token application helpers (used by ai-integration)
// ───────────────────────────────────────────────

/**
 * Apply a set of token value changes (e.g. from an AI palette
 * proposal) and produce the SetTokenValue ops that update the
 * token map. The caller then re-resolves the table and computes
 * ReThemeOps for any ref-bearing nodes that need their resolved
 * value bumped.
 */
export interface SetTokenValueOp {
  kind: "SetTokenValue";
  tokenId: string;
  /** New value (literal or ref). */
  value: { kind: "literal"; value: string } | { kind: "ref"; token: string };
  /** Optional variant — if absent, sets the base value. */
  variant?: VariantName;
}

export function computeTokenValueOps(
  changes: { tokenId: string; value: string; variant?: VariantName }[],
): SetTokenValueOp[] {
  return changes.map((c) => ({
    kind: "SetTokenValue",
    tokenId: c.tokenId,
    value: { kind: "literal", value: c.value },
    ...(c.variant ? { variant: c.variant } : {}),
  }));
}

// ───────────────────────────────────────────────
// Token map snapshot (for content-addressed caching)
// ───────────────────────────────────────────────

/**
 * The resolved token table for a doc+theme is a content-addressed
 * artifact, cacheable like everything else. This helper produces
 * the cache key for a given token map + variant.
 */
export function resolvedTableCacheKey(mapId: string, variant: VariantName): string {
  return `tokens:${mapId}:${variant}`;
}
