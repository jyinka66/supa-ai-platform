// ─────────────────────────────────────────────────────────────
// Print/bleed setup for the docs+templates pair.
//
//   - Page size presets (A4/A5/Letter + custom) in mm; print pages are
//     mm-native, screen zoom just scales.
//   - Bleed: extend background/edge-touching fills outward by bleed
//     amount automatically at export ("bleed extension" = for each
//     element intersecting the page edge, scale/extend its shape across
//     the bleed line — for images extend crop rect, for rects extend
//     bounds, for text warn if closer than 5mm to trim (safe zone).
//   - Trim marks + color bars drawn by the exporter, never stored in
//     the doc — print chrome is an export concern, not design content.
//   - Export preview: dashed trim line, shaded bleed zone, red-highlight
//     elements inside the unsafe zone (interactive check before paying
//     for prints).
// ─────────────────────────────────────────────────────────────

import type { Page, Rect } from "@supa/design-model";
import { flattenLayers } from "@supa/design-model";

// ============ UNITS ============

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72; // PDF points
export const PX_PER_INCH = 96; // CSS px (default screen DPI)

/** Converts mm to px at a given DPI. */
export function mmToPx(mm: number, dpi: number = PX_PER_INCH): number {
  return (mm / MM_PER_INCH) * dpi;
}

/** Converts px to mm at a given DPI. */
export function pxToMm(px: number, dpi: number = PX_PER_INCH): number {
  return (px / dpi) * MM_PER_INCH;
}

/** Converts mm to PDF points. */
export function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PT_PER_INCH;
}

// ============ PAGE SIZE PRESETS ============

export interface PageSizePreset {
  name: string;
  width: number;  // mm
  height: number; // mm
  /** Common label for the UI. */
  label: string;
}

export const PAGE_SIZE_PRESETS: PageSizePreset[] = [
  // ISO (A series)
  { name: "A0", width: 841, height: 1189, label: "A0 · 841×1189mm" },
  { name: "A1", width: 594, height: 841, label: "A1 · 594×841mm" },
  { name: "A2", width: 420, height: 594, label: "A2 · 420×594mm" },
  { name: "A3", width: 297, height: 420, label: "A3 · 297×420mm" },
  { name: "A4", width: 210, height: 297, label: "A4 · 210×297mm" },
  { name: "A5", width: 148, height: 210, label: "A5 · 148×210mm" },
  { name: "A6", width: 105, height: 148, label: "A6 · 105×148mm" },
  // US
  { name: "Letter", width: 216, height: 279, label: "Letter · 8.5×11in" },
  { name: "Legal", width: 216, height: 356, label: "Legal · 8.5×14in" },
  { name: "Tabloid", width: 279, height: 432, label: "Tabloid · 11×17in" },
  // Business cards
  { name: "Card-85x55", width: 85, height: 55, label: "Business Card · 85×55mm" },
  { name: "Card-US-3.5x2", width: 89, height: 51, label: "Business Card · 3.5×2in" },
  // Social (in mm, rounded)
  { name: "IG-Post", width: 108, height: 108, label: "Instagram Post · 1080px" },
  { name: "IG-Story", width: 108, height: 192, label: "Instagram Story · 1080×1920px" },
];

// ============ BLEED ============

export interface BleedConfig {
  /** Bleed amount in mm. Standard: 3mm. */
  bleedMm: number;
  /** Safe zone margin in mm (text should not be closer than this to the trim). Standard: 5mm. */
  safeZoneMm: number;
}

export const DEFAULT_BLEED: BleedConfig = {
  bleedMm: 3,
  safeZoneMm: 5,
};

// ============ BLEED EXTENSION ============

export interface BleedExtensionResult {
  /** Modified page with bleed-extended elements. */
  page: Page;
  /** Elements that were extended (for audit). */
  extended: Array<{ nodeId: string; original: Rect; extended: Rect }>;
  /** Elements inside the unsafe zone (text too close to trim). */
  unsafeElements: Array<{ nodeId: string; reason: string }>;
}

/**
 * Extends background/edge-touching elements outward by the bleed amount.
 *
 * For each element intersecting the page edge:
 *   - Images: extend crop rect across the bleed line
 *   - Rects: extend bounds outward
 *   - Text: warn if closer than 5mm to trim (safe zone violation)
 *
 * @example
 *   const result = extendBleed(page, { bleedMm: 3, safeZoneMm: 5 });
 *   if (result.unsafeElements.length > 0) {
 *     showWarnings(result.unsafeElements);
 *   }
 */
export function extendBleed(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): BleedExtensionResult {
  const bleedPx = mmToPx(config.bleedMm);
  const safeZonePx = mmToPx(config.safeZoneMm);
  const pageWidth = page.size.width;
  const pageHeight = page.size.height;

  // Clone the page for modification.
  const modifiedPage: Page = structuredClone(page);
  const extended: Array<{ nodeId: string; original: Rect; extended: Rect }> = [];
  const unsafeElements: Array<{ nodeId: string; reason: string }> = [];

  // Walk all layers + extend edge-touching ones.
  const allLayers = flattenLayers(modifiedPage);

  for (const layer of allLayers) {
    const rect = layer.rect;
    const touchesEdge =
      rect.x <= 0 ||
      rect.y <= 0 ||
      rect.x + rect.width >= pageWidth ||
      rect.y + rect.height >= pageHeight;

    if (touchesEdge) {
      const original = { ...rect };
      const newRect = { ...rect };

      // Extend left edge.
      if (rect.x <= 0) {
        newRect.x = -bleedPx;
        newRect.width += bleedPx - rect.x;
      }

      // Extend top edge.
      if (rect.y <= 0) {
        newRect.y = -bleedPx;
        newRect.height += bleedPx - rect.y;
      }

      // Extend right edge.
      if (rect.x + rect.width >= pageWidth) {
        newRect.width = pageWidth + bleedPx - newRect.x;
      }

      // Extend bottom edge.
      if (rect.y + rect.height >= pageHeight) {
        newRect.height = pageHeight + bleedPx - newRect.y;
      }

      layer.rect = newRect;
      extended.push({ nodeId: layer.id, original, extended: newRect });
    }

    // Safe zone check for text layers.
    if (layer.type === "text") {
      const tooClose =
        rect.x < safeZonePx ||
        rect.y < safeZonePx ||
        rect.x + rect.width > pageWidth - safeZonePx ||
        rect.y + rect.height > pageHeight - safeZonePx;

      if (tooClose) {
        unsafeElements.push({
          nodeId: layer.id,
          reason: `Text is within ${String(config.safeZoneMm)}mm of the trim edge`,
        });
      }
    }
  }

  // Extend the page background (if not transparent).
  if (modifiedPage.background !== "transparent") {
    // The page size stays the same; the bleed extension is handled by
    // the exporter (it renders the background to the full bleed area).
    modifiedPage.bleed = config.bleedMm;
  }

  return { page: modifiedPage, extended, unsafeElements };
}

// ============ TRIM MARKS + COLOR BARS ============

export interface TrimMarkLine {
  x1: number; y1: number; x2: number; y2: number;
  strokeWidth: number;
}

/**
 * Generates trim marks for a page (as SVG lines).
 *
 * Trim marks are drawn by the exporter, never stored in the doc.
 * They indicate where the paper should be cut after printing.
 *
 * @example
 *   const marks = generateTrimMarks(page, { bleedMm: 3 });
 *   // → 8 lines (2 per corner) as SVG path data
 */
export function generateTrimMarks(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): TrimMarkLine[] {
  const bleedPx = mmToPx(config.bleedMm);
  const markLength = mmToPx(3); // 3mm marks
  const markOffset = mmToPx(1); // 1mm gap from trim
  const strokeWidth = mmToPx(0.25); // 0.25mm hairline

  const W = page.size.width;
  const H = page.size.height;
  const lines: TrimMarkLine[] = [];

  // Top-left corner.
  lines.push({ x1: -bleedPx, y1: markOffset, x2: -bleedPx + markLength, y2: markOffset, strokeWidth }); // horizontal
  lines.push({ x1: markOffset, y1: -bleedPx, x2: markOffset, y2: -bleedPx + markLength, strokeWidth }); // vertical

  // Top-right corner.
  lines.push({ x1: W + bleedPx - markLength, y1: markOffset, x2: W + bleedPx, y2: markOffset, strokeWidth });
  lines.push({ x1: W - markOffset, y1: -bleedPx, x2: W - markOffset, y2: -bleedPx + markLength, strokeWidth });

  // Bottom-left corner.
  lines.push({ x1: -bleedPx, y1: H - markOffset, x2: -bleedPx + markLength, y2: H - markOffset, strokeWidth });
  lines.push({ x1: markOffset, y1: H + bleedPx - markLength, x2: markOffset, y2: H + bleedPx, strokeWidth });

  // Bottom-right corner.
  lines.push({ x1: W + bleedPx - markLength, y1: H - markOffset, x2: W + bleedPx, y2: H - markOffset, strokeWidth });
  lines.push({ x1: W - markOffset, y1: H + bleedPx - markLength, x2: W - markOffset, y2: H + bleedPx, strokeWidth });

  return lines;
}

/**
 * Generates a color bar (CMYK gradient strip) for print calibration.
 * Placed below the bleed area.
 */
export function generateColorBar(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): { rects: Array<{ x: number; y: number; width: number; height: number; fill: string }> } {
  const bleedPx = mmToPx(config.bleedMm);
  const barHeight = mmToPx(5);
  const barY = page.size.height + bleedPx + mmToPx(2); // 2mm below bleed
  const swatchWidth = mmToPx(10);

  const colors = ["#00C7FF", "#FF00C7", "#FFFF00", "#000000"]; // C, M, Y, K approximations

  const rects = colors.map((fill, i) => ({
    x: i * swatchWidth,
    y: barY,
    width: swatchWidth,
    height: barHeight,
    fill,
  }));

  return { rects };
}

/**
 * Renders trim marks + color bar as SVG string (for the exporter).
 * This SVG is appended to the page's render output — never stored in the doc.
 */
export function renderPrintChrome(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): string {
  const trimMarks = generateTrimMarks(page, config);
  const colorBar = generateColorBar(page, config);

  const parts: string[] = ['<g class="print-chrome" style="pointer-events:none">'];

  // Trim marks.
  for (const mark of trimMarks) {
    parts.push(
      `<line x1="${String(mark.x1)}" y1="${String(mark.y1)}" x2="${String(mark.x2)}" y2="${String(mark.y2)}" ` +
      `stroke="#000" stroke-width="${String(mark.strokeWidth)}" />`,
    );
  }

  // Color bar.
  for (const rect of colorBar.rects) {
    parts.push(
      `<rect x="${String(rect.x)}" y="${String(rect.y)}" width="${String(rect.width)}" height="${String(rect.height)}" fill="${rect.fill}" />`,
    );
  }

  parts.push("</g>");
  return parts.join("");
}

// ============ EXPORT PREVIEW OVERLAY ============

export interface PreviewOverlay {
  /** Dashed trim line (the page bounds). */
  trimLine: { x: number; y: number; width: number; height: number };
  /** Shaded bleed zone (outside the trim line). */
  bleedZone: { x: number; y: number; width: number; height: number };
  /** Elements inside the unsafe zone (red highlight). */
  unsafeHighlights: Array<{ nodeId: string; rect: Rect }>;
}

/**
 * Generates the print preview overlay data for the editor.
 *
 * Used by the export preview to show:
 *   - Dashed trim line (where the paper will be cut)
 *   - Shaded bleed zone (outside the trim)
 *   - Red-highlighted elements inside the unsafe zone (text too close to trim)
 *
 * @example
 *   const overlay = generatePreviewOverlay(page, { bleedMm: 3, safeZoneMm: 5 });
 *   renderOverlay(overlay); // draws the preview chrome
 */
export function generatePreviewOverlay(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): PreviewOverlay {
  const bleedPx = mmToPx(config.bleedMm);
  const safeZonePx = mmToPx(config.safeZoneMm);
  const W = page.size.width;
  const H = page.size.height;

  const unsafeHighlights: Array<{ nodeId: string; rect: Rect }> = [];

  for (const layer of flattenLayers(page)) {
    if (layer.type !== "text") continue;
    const r = layer.rect;
    if (
      r.x < safeZonePx ||
      r.y < safeZonePx ||
      r.x + r.width > W - safeZonePx ||
      r.y + r.height > H - safeZonePx
    ) {
      unsafeHighlights.push({ nodeId: layer.id, rect: r });
    }
  }

  return {
    trimLine: { x: 0, y: 0, width: W, height: H },
    bleedZone: { x: -bleedPx, y: -bleedPx, width: W + bleedPx * 2, height: H + bleedPx * 2 },
    unsafeHighlights,
  };
}

/**
 * Renders the preview overlay as SVG string (for the editor's overlay layer).
 */
export function renderPreviewOverlay(
  page: Page,
  config: BleedConfig = DEFAULT_BLEED,
): string {
  const overlay = generatePreviewOverlay(page, config);
  const parts: string[] = ['<g class="print-preview" style="pointer-events:none">'];

  // Bleed zone (shaded).
  parts.push(
    `<rect x="${String(overlay.bleedZone.x)}" y="${String(overlay.bleedZone.y)}" ` +
    `width="${String(overlay.bleedZone.width)}" height="${String(overlay.bleedZone.height)}" ` +
    `fill="rgba(0,0,0,0.05)" stroke="none" />`,
  );

  // Trim line (dashed).
  parts.push(
    `<rect x="${String(overlay.trimLine.x)}" y="${String(overlay.trimLine.y)}" ` +
    `width="${String(overlay.trimLine.width)}" height="${String(overlay.trimLine.height)}" ` +
    `fill="none" stroke="#ff0000" stroke-width="1" stroke-dasharray="4 2" />`,
  );

  // Unsafe elements (red highlight).
  for (const { rect } of overlay.unsafeHighlights) {
    parts.push(
      `<rect x="${String(rect.x)}" y="${String(rect.y)}" width="${String(rect.width)}" height="${String(rect.height)}" ` +
      `fill="rgba(255,0,0,0.1)" stroke="#ff0000" stroke-width="1" stroke-dasharray="2 2" />`,
    );
  }

  parts.push("</g>");
  return parts.join("");
}
