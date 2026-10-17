// ─────────────────────────────────────────────────────────────
// Publish: doc → template. The reverse of instantiate: extract slots.
//
// Flow:
//   1. Caller marks slot candidates in the editor ("make this a text slot").
//   2. Validate: every slot target exists, typed correctly, not nested
//      deeper than the slotGroup rule, doc passes validate().
//   3. Theme extraction: collect all colors; suggest tokens by frequency
//      (accent = most-used non-neutral). Author confirms.
//   4. Versioning: republish of id X creates version N+1. Existing docs
//      keep their provenance pointer (old version); "update to latest
//      template" is an explicit user action that re-runs instantiate with
//      the doc's recorded bindings. We never mutate docs in place.
//   5. All-or-nothing: a failed publish writes nothing. Template catalog
//      is append-only; deletion = soft-hide (docs referencing a template
//      must still instantiate forever).
// ─────────────────────────────────────────────────────────────

import type { DesignDoc, LayerNode, Color, TextLayer, ImageLayer, ShapeLayer, IconLayer, Page } from "@supa/design-model";
import { validate, findLayerById, flattenLayers } from "@supa/design-model";
import type { DesignTemplate, Slot, TextSlot, ImageSlot, ColorSlot, Theme } from "./types";
import { newId } from "@supa/design-model";

// ============ PUBLISH INPUT ============

/**
 * A slot candidate marked by the author in the editor.
 * The caller identifies which nodes are editable + provides metadata.
 */
export interface SlotCandidate {
  kind: "text" | "image" | "color";
  nodeId: string;
  label: string;

  // Text-specific
  maxLength?: number;
  allowRichRuns?: boolean;
  minFontSize?: number;

  // Image-specific
  fitLock?: "inherit" | "cover" | "contain";
  aspectHint?: number;

  // Color-specific
  field?: "fill" | "stroke" | "color";
  themeKey?: string;
}

export interface PublishInput {
  /** The fully-designed doc (must pass validate()). */
  doc: DesignDoc;
  /** Template metadata. */
  id?: string; // omit for new template; provide for republish
  name: string;
  /** Slot candidates marked by the author. */
  slots: SlotCandidate[];
  /** Theme tokens (optional — auto-extracted if omitted). */
  theme?: Theme;
  /** Catalog facets. */
  tags: string[];
  /** Size hint for the catalog. */
  sizeHint: { width: number; height: number; name: string };
}

// ============ PUBLISH RESULT ============

export interface PublishResult {
  template: DesignTemplate;
  /** Colors found in the doc, sorted by frequency (for theme confirmation). */
  extractedColors: Array<{ hex: string; count: number; suggestedToken?: string }>;
  /** Warnings (non-blocking). */
  warnings: string[];
}

// ============ ERRORS ============

export class PublishError extends Error {
  constructor(public errors: Array<{ code: string; message: string; nodeId?: string }>) {
    super(
      `Publish failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  [${e.code}] ${e.nodeId ? `(${e.nodeId}) ` : ""}${e.message}`).join("\n"),
    );
    this.name = "PublishError";
  }
}

// ============ PUBLISH ============

/**
 * Publishes a design doc as a template.
 *
 * The reverse of `instantiate()`: extracts slots from the doc + validates.
 *
 * @example
 *   const result = publish({
 *     doc: myDesign,
 *     name: "Instagram Post - Sale",
 *     slots: [
 *       { kind: "text", nodeId: "n_headline", label: "Headline", maxLength: 50 },
 *       { kind: "image", nodeId: "n_photo", label: "Product Photo", aspectHint: 1 },
 *       { kind: "color", nodeId: "n_bg", field: "fill", label: "Background" },
 *     ],
 *     tags: ["social", "instagram", "sale"],
 *     sizeHint: { width: 1080, height: 1080, name: "IG Post 1080×1080" },
 *   });
 *
 * @throws PublishError if validation fails (all-or-nothing — nothing is written).
 */
export function publish(input: PublishInput): PublishResult {
  const errors: Array<{ code: string; message: string; nodeId?: string }> = [];
  const warnings: string[] = [];

  // 1. Validate the doc itself.
  const docErrors = validate(input.doc);
  if (docErrors.length > 0) {
    for (const e of docErrors) {
      errors.push({ code: "DOC_INVALID", message: `${e.path}: ${e.message}` });
    }
    // If the doc is invalid, we can't publish — fail fast.
    throw new PublishError(errors);
  }

  // 2. Validate slot candidates: every target must exist + be the right type.
  const slots: Slot[] = [];
  const seenNodeIds = new Set<string>();

  for (const candidate of input.slots) {
    const node = findNodeInDoc(input.doc, candidate.nodeId);

    if (!node) {
      errors.push({
        code: "SLOT_NODE_NOT_FOUND",
        message: `Slot "${candidate.label}" references node ${candidate.nodeId} which doesn't exist`,
        nodeId: candidate.nodeId,
      });
      continue;
    }

    if (seenNodeIds.has(candidate.nodeId)) {
      errors.push({
        code: "SLOT_NODE_DUPLICATED",
        message: `Node ${candidate.nodeId} is targeted by multiple slots`,
        nodeId: candidate.nodeId,
      });
      continue;
    }
    seenNodeIds.add(candidate.nodeId);

    // Type-check: text slots must target text layers, etc.
    switch (candidate.kind) {
      case "text":
        if (node.type !== "text") {
          errors.push({
            code: "SLOT_TYPE_MISMATCH",
            message: `Text slot "${candidate.label}" targets a ${node.type} layer (expected text)`,
            nodeId: candidate.nodeId,
          });
          continue;
        }
        slots.push({
          kind: "text",
          nodeId: candidate.nodeId,
          label: candidate.label,
          maxLength: candidate.maxLength,
          allowRichRuns: candidate.allowRichRuns ?? false,
          minFontSize: candidate.minFontSize,
        } as TextSlot);
        break;

      case "image":
        if (node.type !== "image") {
          errors.push({
            code: "SLOT_TYPE_MISMATCH",
            message: `Image slot "${candidate.label}" targets a ${node.type} layer (expected image)`,
            nodeId: candidate.nodeId,
          });
          continue;
        }
        slots.push({
          kind: "image",
          nodeId: candidate.nodeId,
          label: candidate.label,
          fitLock: candidate.fitLock ?? "inherit",
          aspectHint: candidate.aspectHint,
        } as ImageSlot);
        break;

      case "color":
        if (candidate.themeKey) {
          // Theme-level color slot — no node validation needed.
          slots.push({
            kind: "color",
            target: { themeKey: candidate.themeKey },
            label: candidate.label,
          } as ColorSlot);
        } else {
          // Node-level color slot.
          if (candidate.field === "fill" && node.type !== "shape" && node.type !== "container") {
            errors.push({
              code: "SLOT_TYPE_MISMATCH",
              message: `Color slot "${candidate.label}" with field=fill targets a ${node.type} layer (expected shape or container)`,
              nodeId: candidate.nodeId,
            });
            continue;
          }
          if (candidate.field === "stroke" && node.type !== "shape") {
            errors.push({
              code: "SLOT_TYPE_MISMATCH",
              message: `Color slot "${candidate.label}" with field=stroke targets a ${node.type} layer (expected shape)`,
              nodeId: candidate.nodeId,
            });
            continue;
          }
          if (candidate.field === "color" && node.type !== "icon") {
            errors.push({
              code: "SLOT_TYPE_MISMATCH",
              message: `Color slot "${candidate.label}" with field=color targets a ${node.type} layer (expected icon)`,
              nodeId: candidate.nodeId,
            });
            continue;
          }
          slots.push({
            kind: "color",
            target: { nodeId: candidate.nodeId, field: candidate.field! },
            label: candidate.label,
          } as ColorSlot);
        }
        break;
    }
  }

  // 3. Check nesting depth (slots shouldn't be nested too deep).
  const MAX_SLOT_DEPTH = 8;
  for (const slot of slots) {
    if ("nodeId" in slot) {
      const depth = getDepthInDoc(input.doc, slot.nodeId);
      if (depth > MAX_SLOT_DEPTH) {
        warnings.push(
          `Slot "${slot.label}" (node ${slot.nodeId}) is nested ${depth} levels deep — consider flattening for better editor UX`,
        );
      }
    }
  }

  // 4. If errors, fail (all-or-nothing).
  if (errors.length > 0) {
    throw new PublishError(errors);
  }

  // 5. Theme extraction (if not provided).
  const extractedColors = extractColors(input.doc);
  const theme = input.theme ?? suggestTheme(extractedColors);

  // 6. Build the template.
  const template: DesignTemplate = {
    id: input.id ?? newId(),
    schemaVersion: 1,
    name: input.name,
    doc: structuredClone(input.doc),
    slots,
    theme,
    tags: input.tags,
    sizeHint: input.sizeHint,
    version: 1, // new template starts at v1; republish bumps to N+1
  };

  // 7. Validate the template doc one more time (belt + suspenders).
  const finalErrors = validate(template.doc);
  if (finalErrors.length > 0) {
    throw new PublishError(
      finalErrors.map((e) => ({
        code: "TEMPLATE_DOC_INVALID",
        message: `${e.path}: ${e.message}`,
      })),
    );
  }

  return { template, extractedColors, warnings };
}

// ============ REPUBLISH ============

/**
 * Republishes an existing template as a new version.
 *
 * Existing docs keep their provenance pointer (old version).
 * "Update to latest template" is an explicit user action that re-runs
 * instantiate() with the doc's recorded bindings.
 *
 * We never mutate docs in place on template update.
 *
 * @example
 *   const result = republish(existingTemplate, {
 *     doc: updatedDesign,
 *     slots: updatedSlots,
 *     ...
 *   });
 *   // result.template.version === existingTemplate.version + 1
 */
export function republish(
  existing: DesignTemplate,
  input: Omit<PublishInput, "id">,
): PublishResult {
  const result = publish({ ...input, id: existing.id });

  // Bump the version.
  result.template.version = existing.version + 1;

  return result;
}

// ============ THEME EXTRACTION ============

/**
 * Collects all colors used in the doc, sorted by frequency.
 *
 * Colors from fills, strokes, text runs, icon colors, and page backgrounds
 * are all included. Neutrals (white, black, grays) are filtered out of
 * the "accent" suggestion but still listed.
 */
function extractColors(doc: DesignDoc): Array<{ hex: string; count: number; suggestedToken?: string }> {
  const colorCounts = new Map<string, number>();

  function addColor(color: Color) {
    const hex = color.hex.toUpperCase();
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }

  function addFill(fill: unknown) {
    if (fill && typeof fill === "object" && "type" in fill) {
      if (fill.type === "solid" && "color" in fill) {
        addColor((fill as { color: Color }).color);
      } else if (fill.type === "gradient" && "gradient" in fill) {
        const gradient = (fill as { gradient: { stops: Array<{ color: Color }> } }).gradient;
        for (const stop of gradient.stops) addColor(stop.color);
      }
    }
  }

  for (const page of doc.pages) {
    // Page background.
    if (page.background !== "transparent") {
      addFill(page.background);
    }

    // All layers.
    for (const layer of flattenLayers(page)) {
      // Shape fills + strokes.
      if (layer.type === "shape") {
        const shape = layer as ShapeLayer;
        if (shape.fill) addFill(shape.fill);
        if (shape.stroke) addColor(shape.stroke.color);
      }
      // Container fills.
      if (layer.type === "container") {
        const container = layer as unknown as { fill?: unknown };
        if (container.fill) addFill(container.fill);
      }
      // Icon colors.
      if (layer.type === "icon") {
        addColor((layer as IconLayer).color);
      }
      // Text run colors.
      if (layer.type === "text") {
        const text = layer as TextLayer;
        for (const run of text.runs) {
          if (run.color) addColor(run.color);
        }
      }
    }
  }

  // Sort by frequency (descending).
  const sorted = Array.from(colorCounts.entries())
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count);

  return sorted;
}

/**
 * Suggests a theme from extracted colors.
 *
 * - The most-used non-neutral color → "accent"
 * - The most-used neutral → "background"
 * - Top 5 colors → "primary" through "quinary"
 */
function suggestTheme(colors: Array<{ hex: string; count: number }>): Theme {
  const NEUTRALS = new Set([
    "#FFFFFF", "#000000", "#000", "#FFF",
    "#F5F5F5", "#E5E5E5", "#D4D4D4", "#A3A3A3", "#737373", "#525252", "#262626", "#171717",
  ]);

  const isNeutral = (hex: string) => NEUTRALS.has(hex.toUpperCase());

  const tokens: Record<string, string> = {};
  const palette: Theme["palette"] = [];

  // Accent = most-used non-neutral.
  const nonNeutrals = colors.filter((c) => !isNeutral(c.hex));
  const neutrals = colors.filter((c) => isNeutral(c.hex));

  if (nonNeutrals[0]) {
    tokens.accent = nonNeutrals[0]!.hex;
  }
  if (neutrals[0]) {
    tokens.background = neutrals[0]!.hex;
  }
  if (neutrals[1]) {
    tokens.foreground = neutrals[1]!.hex;
  }

  // Assign remaining non-neutrals as primary, secondary, etc.
  const tokenNames = ["primary", "secondary", "tertiary"];
  for (let i = 1; i < Math.min(nonNeutrals.length, 4); i++) {
    tokens[tokenNames[i - 1]!] = nonNeutrals[i]!.hex;
  }

  // Palette: all colors as a single palette.
  palette.push({
    name: "Extracted",
    colors: colors.map((c) => c.hex),
  });

  return { tokens, palette };
}

// ============ HELPERS ============

function findNodeInDoc(doc: DesignDoc, nodeId: string): LayerNode | null {
  for (const page of doc.pages) {
    const node = findLayerById(page, nodeId);
    if (node) return node;
  }
  return null;
}

function getDepthInDoc(doc: DesignDoc, nodeId: string): number {
  for (const page of doc.pages) {
    const depth = getDepthInPage(page, nodeId, 0);
    if (depth > 0) return depth;
  }
  return 0;
}

function getDepthInPage(page: Page, nodeId: string, depth: number): number {
  for (const layer of page.layers) {
    if (layer.id === nodeId) return depth + 1;
    if (layer.children) {
      const childDepth = getDepthInChildren(layer.children, nodeId, depth + 1);
      if (childDepth > 0) return childDepth;
    }
  }
  return 0;
}

function getDepthInChildren(children: LayerNode[], nodeId: string, depth: number): number {
  for (const child of children) {
    if (child.id === nodeId) return depth + 1;
    if (child.children) {
      const d = getDepthInChildren(child.children, nodeId, depth + 1);
      if (d > 0) return d;
    }
  }
  return 0;
}
