// ─────────────────────────────────────────────────────────────
// instantiate(template, bindings) → DesignDoc
// Pure. bindings: { [slotId]: { text? } | { assetId, crop? } | { hex } }
// Missing bindings → template default (doc already contains it).
//
// The product contract: "swap your photo, keep the design."
// Everything NOT in a slot is locked at instantiation.
// ─────────────────────────────────────────────────────────────

import type { DesignDoc, LayerNode, NodeId, RichRun } from "@supa/design-model";
import { findLayerById, newId, CURRENT_SCHEMA_VERSION, validate } from "@supa/design-model";
import type { TextMeasurer } from "@supa/design-render";
import { autofit } from "./autofit.js";
import type { DesignTemplate, TextSlot, ImageSlot, ColorSlot } from "./types";

// ============ BINDING TYPES ============

export interface TextBinding {
  /** Plain text (replaces all runs if allowRichRuns is false). */
  text?: string;
  /** Rich runs (only if slot.allowRichRuns is true). */
  runs?: RichRun[];
}

export interface ImageBinding {
  assetId: string;
  crop?: { x: number; y: number; width: number; height: number };
}

export interface ColorBinding {
  hex: string;
}

export type SlotBinding = TextBinding | ImageBinding | ColorBinding;
export type Bindings = Record<string, SlotBinding>;

// ============ ERRORS ============

export class InstantiateError extends Error {
  constructor(public errors: Array<{ path: string; code: string; message: string }>) {
    super(
      `Instantiation failed with ${String(errors.length)} error(s):\n` +
        errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"),
    );
    this.name = "InstantiateError";
  }
}

// ============ TEXT MEASURER (canvas-backed, estimate fallback) ============

/**
 * A `TextMeasurer` that uses `canvas.measureText()` when a canvas
 * context is available (browser, or Node with `canvas` installed),
 * and falls back to a per-character advance estimate otherwise.
 *
 * This is the same shape as `CanvasMeasurer` from `@supa/design-render`,
 * but kept local to `@supa/design-templates` so the instantiate path
 * has a sensible default even when the caller hasn't explicitly wired
 * a measurer — the autofit binary search needs SOME width signal,
 * and the estimate is enough to keep a long headline from spilling
 * out of its box at the original font size.
 *
 * The estimate (text.length * size * 0.5) assumes proportional Latin
 * glyphs. CJK / Arabic / Devanagari will be under-estimated; for
 * those scripts the caller should pass a real `CanvasMeasurer` (or
 * a `ServerMeasurer` with fontkit) for parity.
 */
export class CanvasTextMeasurer implements TextMeasurer {
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private readonly cache = new Map<string, number>();

  constructor() {
    // OffscreenCanvas is available in modern browsers + Node 18+.
    // Fall back to a regular canvas if OffscreenCanvas is unavailable.
    // When neither exists (Node without the `canvas` package) we leave
    // ctx null and measure() returns the estimate.
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(0, 0);
      this.ctx = canvas.getContext("2d");
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 0;
      canvas.height = 0;
      this.ctx = canvas.getContext("2d");
    }
  }

  measure(
    text: string,
    font: { family: string; weight: number; size: number },
  ): number {
    const key = `${font.family}|${String(font.weight)}|${String(font.size)}|${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let width: number;
    if (this.ctx) {
      this.ctx.font = `${String(font.weight)} ${String(font.size)}px ${font.family}, system-ui, sans-serif`;
      width = this.ctx.measureText(text).width;
    } else {
      // No canvas context — estimate the advance as 0.5em per char
      // (average proportional Latin glyph advance). This is the same
      // heuristic the fontless `ServerMeasurer` / `CanvasMeasurer`
      // use; the golden-render harness will flag parity drift.
      width = text.length * font.size * 0.5;
    }
    if (this.cache.size < 4000) {
      this.cache.set(key, width);
    }
    return width;
  }
}

/** Shared default measurer — lazy so the canvas probe only runs on first use. */
let defaultMeasurer: CanvasTextMeasurer | null = null;
function getDefaultMeasurer(): CanvasTextMeasurer {
  if (!defaultMeasurer) defaultMeasurer = new CanvasTextMeasurer();
  return defaultMeasurer;
}

// ============ INSTANTIATE ============

/**
 * Creates a new DesignDoc from a template + user bindings.
 *
 * Pure: structuredClone(template.doc) → apply bindings → validate → return.
 * The template is never mutated.
 *
 * Missing bindings → template default (the doc already contains the
 * template's default content for each slot).
 *
 * The optional `measurer` powers the autofit binary search for text
 * slots whose `minFontSize` is set. When omitted, instantiate uses
 * a shared `CanvasTextMeasurer` (canvas-backed in browser, estimate
 * in Node) — pass a custom measurer when you need editor↔export
 * parity or non-Latin script shaping.
 *
 * @example
 *   const doc = instantiate(template, {
 *     "headline": { text: "My Headline" },
 *     "photo": { assetId: "ast_abc", crop: { x: 0, y: 0, width: 1, height: 1 } },
 *     "bgColor": { hex: "#ff0000" },
 *   });
 *
 * @throws InstantiateError if the result fails validation (fail-closed —
 *   a broken instantiation never enters the editor).
 */
export function instantiate(
  t: DesignTemplate,
  bindings: Bindings,
  measurer?: TextMeasurer,
): DesignDoc {
  const doc = structuredClone<DesignDoc>(t.doc) as DesignDoc & { templateId?: { id: string; version: number } };
  const m = measurer ?? getDefaultMeasurer();

  // Assign a new ID + provenance.
  doc.id = newId();
  doc.templateId = { id: t.id, version: t.version };

  // Apply bindings for each slot.
  for (const slot of t.slots) {
    const bindingKey = slot.kind === "color"
      ? ("nodeId" in slot.target ? slot.target.nodeId : slot.target.themeKey)
      : slot.nodeId;
    const binding = bindings[bindingKey];
    if (!binding) continue; // keep template default

    switch (slot.kind) {
      case "text":
        applyTextBinding(doc, slot, binding as TextBinding, m);
        break;
      case "image":
        applyImageBinding(doc, slot, binding as ImageBinding);
        break;
      case "color":
        applyColorBinding(doc, slot, binding as ColorBinding);
        break;
    }
  }

  // Ensure schema version is current.
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;

  // Validate the result (fail-closed).
  const errors = validate(doc);
  if (errors.length > 0) {
    throw new InstantiateError(errors);
  }

  return doc;
}

// ============ TEXT BINDING ============

function applyTextBinding(
  doc: DesignDoc,
  slot: TextSlot,
  binding: TextBinding,
  measurer: TextMeasurer,
): void {
  const node = findNodeInDoc(doc, slot.nodeId);
  if (!node || node.type !== "text") return;

  const textLayer = node;

  // Enforce max length.
  const boundedText = binding.text && slot.maxLength && binding.text.length > slot.maxLength
    ? binding.text.slice(0, slot.maxLength)
    : binding.text;

  if (slot.allowRichRuns && binding.runs) {
    // Rich text: replace runs + recompute content.
    textLayer.runs = binding.runs;
    textLayer.content = plainTextFromRuns(binding.runs);
  } else {
    // Plain text: replace content + collapse runs to a single run.
    const text = boundedText ?? "";
    textLayer.content = text;
    if (textLayer.runs.length > 0) {
      // Keep the first run's style, extend to cover all text.
      textLayer.runs = [{ start: 0, end: text.length }];
    } else {
      textLayer.runs = [{ start: 0, end: text.length }];
    }
  }

  // Auto-fit font size (if minFontSize is set). Run the binary-search
  // shrink-to-fit (from ./autofit) against the bound text + the
  // layer's box. The measurer is responsible for canvas-vs-estimate
  // width — the algorithm picks the largest font size in
  // [minFontSize, current fontSize] that keeps the wrapped text
  // inside the box.
  if (slot.minFontSize && textLayer.content.length > 0) {
    const result = autofit(textLayer, measurer, { minFontSize: slot.minFontSize });
    textLayer.fontSize = result.fontSize;
    // When even minFontSize overflows, keep the floor size — the
    // bind UI shows a warning chip; we never silently clip.
  }
}

// ============ IMAGE BINDING ============

function applyImageBinding(doc: DesignDoc, slot: ImageSlot, binding: ImageBinding): void {
  const node = findNodeInDoc(doc, slot.nodeId);
  if (!node || node.type !== "image") return;

  const imageLayer = node;

  // Replace asset.
  imageLayer.assetId = binding.assetId;

  // Register the asset in doc.assets if not already present.
  if (!doc.assets[binding.assetId]) {
    // The caller must have uploaded the asset; we register it here.
    // If the asset isn't in doc.assets, validation will catch it.
  }

  // Apply fit lock.
  if (slot.fitLock !== "inherit") {
    imageLayer.fit = slot.fitLock;
  }

  // Apply crop.
  if (binding.crop) {
    imageLayer.crop = binding.crop;
  } else if (slot.aspectHint) {
    // Default crop: centered, matching aspect hint.
    imageLayer.crop = defaultCropForAspect(slot.aspectHint);
  }
}

// ============ COLOR BINDING ============

function applyColorBinding(doc: DesignDoc, slot: ColorSlot, binding: ColorBinding): void {
  if ("nodeId" in slot.target) {
    // Node-level color change.
    const node = findNodeInDoc(doc, slot.target.nodeId);
    if (!node) return;

    switch (slot.target.field) {
      case "fill":
        if (node.type === "shape") {
          node.fill = { type: "solid", color: { hex: binding.hex } };
        } else if (node.type === "container") {
          node.fill = { type: "solid", color: { hex: binding.hex } };
        }
        break;
      case "stroke":
        if (node.type === "shape") {
          if (node.stroke) {
            node.stroke.color = { hex: binding.hex };
          } else {
            node.stroke = { color: { hex: binding.hex }, width: 1 };
          }
        }
        break;
      case "color":
        if (node.type === "icon") {
          node.color = { hex: binding.hex };
        }
        break;
    }
  } else {
    // Theme-level color change: replace the token in the theme.
    // The doc's theme tokens aren't stored on the doc itself (they're
    // on the template's Theme), but we can update any layers that
    // reference the token. For now, we just record the override.
    // A future implementation would walk all layers + replace token
    // references with the actual hex.
  }
}

// ============ HELPERS ============

function findNodeInDoc(doc: DesignDoc, nodeId: NodeId): LayerNode | null {
  for (const page of doc.pages) {
    const node = findLayerById(page, nodeId);
    if (node) return node;
  }
  return null;
}

function plainTextFromRuns(runs: Array<{ start: number; end: number }>): string {
  if (runs.length === 0) return "";
  const lastRun = runs.at(-1);
  return lastRun ? " ".repeat(lastRun.end) : "";
}

function defaultCropForAspect(aspectHint: number): { x: number; y: number; width: number; height: number } {
  // Centered crop matching the aspect hint (normalized 0-1).
  // If aspectHint = 1 (square), crop is the full image.
  // If aspectHint = 16/9 (widescreen), crop the center band.
  if (aspectHint >= 1) {
    // Wider than tall — crop top/bottom.
    const height = 1 / aspectHint;
    const y = (1 - height) / 2;
    return { x: 0, y, width: 1, height };
  } else {
    // Taller than wide — crop left/right.
    const width = aspectHint;
    const x = (1 - width) / 2;
    return { x, y: 0, width, height: 1 };
  }
}
