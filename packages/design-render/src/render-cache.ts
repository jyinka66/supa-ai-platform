// ─────────────────────────────────────────────────────────────
// Per-editor RenderCache, keyed by doc revision.
//
// Caches:
//   - worldTransform memoization (hit testing, anchor drawing)
//   - rendered SVG string per page (only re-rendered when rev changed
//     or page content changed — a page edit on page 2 doesn't re-render
//     page 1's thumbnail)
//   - text layout results: line breaks computed once per (content, runs,
//     font, size, width) — wrapping is the expensive part; cache it so
//     dragging a text layer doesn't re-wrap on every frame.
//
// Invalidation:
//   - `invalidate()` called by the editor on every `apply()` — clears
//     the worldTransform + page SVG caches (they're cheap to recompute).
//   - Text layout cache survives across revisions (it's keyed by content,
//     not by doc rev — same text = same layout regardless of position).
// ─────────────────────────────────────────────────────────────

import type { Page, NodeId, TextLayer } from "@supa/design-model";
import type { Matrix } from "./transform";

// ============ CACHE ENTRIES ============

interface PageCacheEntry {
  /** The SVG string for this page. */
  svg: string;
  /** The doc revision when this was rendered. */
  rev: number;
}

interface WorldTransformCacheEntry {
  matrix: Matrix;
  rev: number;
}

export interface TextLayoutResult {
  /** Lines after wrapping. */
  lines: string[];
  /** Measured width of each line (px). */
  lineWidths: number[];
  /** Total height of the text block (px). */
  totalHeight: number;
}

// ============ RENDER CACHE ============

export class RenderCache {
  /** Doc revision — bumped on every `apply()`. */
  private rev = 0;

  /** World transforms, keyed by (rev, nodeId). */
  private worldTransforms = new Map<string, WorldTransformCacheEntry>();

  /** Rendered page SVG, keyed by pageId. */
  private pageSvg = new Map<string, PageCacheEntry>();

  /** Text layout results, keyed by content hash (survives rev bumps). */
  private textLayout = new Map<string, TextLayoutResult>();

  /** Which pages were modified since the last render (for selective re-render). */
  private dirtyPages = new Set<string>();

  /** Max text layout entries (prevents unbounded growth). */
  private readonly maxTextLayoutEntries = 5000;

  /**
   * Bumps the doc revision + clears rev-dependent caches.
   * Called by the editor after every `apply()`.
   *
   * @param modifiedPageIds Pages that were modified by the command (for
   *   selective re-rendering — pages not in this set keep their cached SVG).
   */
  invalidate(modifiedPageIds?: string[]): void {
    this.rev++;
    this.worldTransforms.clear();

    if (modifiedPageIds) {
      // Mark only the modified pages as dirty (selective invalidation).
      for (const id of modifiedPageIds) {
        this.dirtyPages.add(id);
        this.pageSvg.delete(id); // force re-render on next access
      }
    } else {
      // No page info — invalidate all page SVGs.
      this.pageSvg.clear();
    }

    // Text layout cache survives — it's keyed by content, not by rev.
  }

  /**
   * Returns the current doc revision.
   */
  get revision(): number {
    return this.rev;
  }

  // ============ WORLD TRANSFORM CACHE ============

  /**
   * Gets or computes the world transform for a node.
   *
   * @param page    The page containing the node.
   * @param nodeId  The node ID.
   * @param compute A function that computes the world transform (called
   *                only on cache miss).
   * @returns The cached or computed world transform matrix.
   */
  getWorldTransform(
    page: Page,
    nodeId: NodeId,
    compute: (page: Page, nodeId: NodeId) => Matrix,
  ): Matrix {
    const key = `${String(this.rev)}:${String(nodeId)}`;
    const hit = this.worldTransforms.get(key);
    if (hit) return hit.matrix;

    const matrix = compute(page, nodeId);
    this.worldTransforms.set(key, { matrix, rev: this.rev });
    return matrix;
  }

  // ============ PAGE SVG CACHE ============

  /**
   * Gets the cached SVG for a page, or null if not cached / invalidated.
   *
   * @param pageId  The page ID.
   * @returns The cached SVG string, or null if the page needs re-rendering.
   */
  getPageSvg(pageId: string): string | null {
    const entry = this.pageSvg.get(pageId);
    if (entry && entry.rev === this.rev) {
      return entry.svg;
    }
    return null;
  }

  /**
   * Stores the rendered SVG for a page.
   *
   * @param pageId  The page ID.
   * @param svg     The SVG string.
   */
  setPageSvg(pageId: string, svg: string): void {
    this.pageSvg.set(pageId, { svg, rev: this.rev });
    this.dirtyPages.delete(pageId);
  }

  /**
   * Returns true if the page needs re-rendering (was modified since last render).
   */
  isPageDirty(pageId: string): boolean {
    return this.dirtyPages.has(pageId) || this.getPageSvg(pageId) === null;
  }

  // ============ TEXT LAYOUT CACHE ============

  /**
   * Gets or computes the text layout (line wrapping) for a text layer.
   *
   * The cache is keyed by (content, fontFamily, fontSize, fontWeight,
   * width, direction) — NOT by doc revision. Same text = same layout
   * regardless of position. This means dragging a text layer doesn't
   * re-wrap on every frame.
   *
   * @param layer     The text layer to lay out.
   * @param compute   A function that computes the layout (wrapping, measuring).
   *                  Called only on cache miss.
   * @returns The cached or computed text layout result.
   */
  getTextLayout(
    layer: TextLayer,
    compute: (layer: TextLayer) => TextLayoutResult,
  ): TextLayoutResult {
    const key = this.textLayoutKey(layer);
    const hit = this.textLayout.get(key);
    if (hit) return hit;

    const result = compute(layer);
    this.textLayout.set(key, result);

    // Evict oldest if over capacity (LRU via Map insertion order).
    if (this.textLayout.size > this.maxTextLayoutEntries) {
      const oldestKey = this.textLayout.keys().next().value;
      if (oldestKey !== undefined) this.textLayout.delete(oldestKey);
    }

    return result;
  }

  /**
   * Invalidates a specific text layer's layout (e.g. when the user
   * edits the text content or changes the font).
   */
  invalidateTextLayout(layer: TextLayer): void {
    const key = this.textLayoutKey(layer);
    this.textLayout.delete(key);
  }

  /**
   * Clears all text layout cache entries (e.g. when the font registry
   * changes, invalidating all measurements).
   */
  clearTextLayout(): void {
    this.textLayout.clear();
  }

  // ============ CLEAR ALL ============

  /**
   * Clears all caches (e.g. when loading a new document).
   */
  clear(): void {
    this.worldTransforms.clear();
    this.pageSvg.clear();
    this.textLayout.clear();
    this.dirtyPages.clear();
    this.rev = 0;
  }

  /**
   * Returns cache statistics for debugging.
   */
  getStats(): {
    rev: number;
    worldTransformCount: number;
    pageSvgCount: number;
    textLayoutCount: number;
    dirtyPageCount: number;
  } {
    return {
      rev: this.rev,
      worldTransformCount: this.worldTransforms.size,
      pageSvgCount: this.pageSvg.size,
      textLayoutCount: this.textLayout.size,
      dirtyPageCount: this.dirtyPages.size,
    };
  }

  // ============ HELPERS ============

  /**
   * Builds a cache key for a text layer's layout.
   * Includes all fields that affect wrapping: content, font, size, width.
   * Does NOT include position (x, y) — same text wraps the same way
   * regardless of where it is on the page.
   */
  private textLayoutKey(layer: TextLayer): string {
    return [
      layer.content,
      layer.fontFamily,
      layer.fontSize,
      layer.fontWeight,
      layer.lineHeight,
      layer.letterSpacing.value,
      layer.letterSpacing.unit,
      layer.rect.width,
      layer.align,
      layer.direction,
    ].join("|");
  }
}
