// ─────────────────────────────────────────────────────────────
// Autofit — shrink-to-fit text within a slot's box.
//
// The feature users judge templates by: they type a longer headline
// and expect the design to survive.
//
// Rules (from the spec):
//   1. Binary search font size in [floor, original] such that:
//      - wrapped line count × lineHeight ≤ box height
//      - longest line width ≤ box width
//   2. If even floor overflows: keep floor, allow overflow.
//      The validator flags it; the bind UI shows a warning chip —
//      never silently clip text.
//   3. Never letter-space-squeeze. Never truncate.
//      Ugly-but-readable beats invisible-but-fitting,
//      and truncation destroys meaning.
// ─────────────────────────────────────────────────────────────

import type { TextLayer } from "@supa/design-model";
import type { TextMeasurer } from "@supa/design-render";
export interface AutofitResult {
  /** The fitted font size (clamped to [floor, original]). */
  fontSize: number;
  /** True if the text fits within the box at this size. */
  fits: boolean;
  /** The wrapped lines at the fitted size. */
  lines: string[];
  /** The measured width of the longest line (px). */
  maxLineWidth: number;
  /** The total height of the text block (px). */
  totalHeight: number;
  /** True if even at minFontSize the text overflows. */
  overflowed: boolean;
}

/**
 * Shrinks font size to fit text within a text layer's box.
 *
 * Binary search between [minFontSize, originalFontSize]:
 *   - At each candidate size, wrap text into lines + measure each line.
 *   - If line count × lineHeight ≤ boxHeight AND longestLine ≤ boxWidth → fits.
 *   - Search for the largest size that fits.
 *
 * If even minFontSize overflows, returns minFontSize with `overflowed: true`.
 * The caller should show a warning chip but NOT clip the text.
 *
 * @example
 *   const result = autofit(textLayer, measurer, { minFontSize: 12 });
 *   textLayer.fontSize = result.fontSize;
 *   if (result.overflowed) showWarning("Text overflows the box");
 */
export function autofit(
  layer: TextLayer,
  measurer: TextMeasurer,
  options: { minFontSize?: number },
): AutofitResult {
  const originalSize = layer.fontSize;
  const floor = options.minFontSize ?? 8;

  // Binary search: find the largest fontSize where the text fits.
  let lo = Math.floor(floor);
  let hi = Math.floor(originalSize);
  let bestFit: AutofitResult | null = null;

  // Quick check: does it fit at the original size?
  const originalResult = measureAtSize(layer, measurer, originalSize);
  if (originalResult.fits) {
    return originalResult;
  }

  // Binary search between floor and original.
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = measureAtSize(layer, measurer, mid);

    if (result.fits) {
      bestFit = result;
      lo = mid + 1; // try larger
    } else {
      hi = mid - 1; // try smaller
    }
  }

  // If we found a fitting size, return it.
  if (bestFit) {
    return bestFit;
  }

  // Nothing fits — use floor size, allow overflow.
  const floorResult = measureAtSize(layer, measurer, floor);
  return {
    ...floorResult,
    fits: false,
    overflowed: true,
  };
}

/**
 * Measures text at a specific font size + checks if it fits in the box.
 *
 * Wraps text into lines (greedy word wrapping) and measures each line.
 */
function measureAtSize(
  layer: TextLayer,
  measurer: TextMeasurer,
  fontSize: number,
): AutofitResult {
  const { content, fontFamily, fontWeight, lineHeight: lhMultiplier, rect } = layer;
  const boxWidth = rect.width;
  const boxHeight = rect.height;
  const lineHeight = fontSize * lhMultiplier; // px per line at this size

  // Greedy word wrapping.
  const lines = wrapText(content, {
    family: fontFamily,
    weight: fontWeight,
    size: fontSize,
    maxWidth: boxWidth,
    measurer,
  });

  // Measure each line.
  let maxLineWidth = 0;
  for (const line of lines) {
    const w = measurer.measure(line, { family: fontFamily, weight: fontWeight, size: fontSize });
    if (w > maxLineWidth) maxLineWidth = w;
  }

  const totalHeight = lines.length * lineHeight;

  // Check fit: lines fit in height + longest line fits in width.
  const fitsHeight = totalHeight <= boxHeight;
  const fitsWidth = maxLineWidth <= boxWidth;
  const fits = fitsHeight && fitsWidth;

  return {
    fontSize,
    fits,
    lines,
    maxLineWidth,
    totalHeight,
    overflowed: !fits && fontSize <= (layer.fontSize * 0.3), // extreme shrinkage
  };
}

/**
 * Greedy word wrapping algorithm.
 *
 * Breaks text into lines that fit within maxWidth, using the measurer
 * to determine word widths. Handles:
 *   - Explicit newlines (\n)
 *   - Long words (overflow the line — never break mid-word)
 *   - Empty lines (preserved)
 *
 * @example
 *   const lines = wrapText("Hello world this is a test", {
 *     family: "Inter", weight: 400, size: 16,
 *     maxWidth: 100, measurer,
 *   });
 *   // → ["Hello world", "this is a", "test"]
 */
export function wrapText(
  text: string,
  opts: {
    family: string;
    weight: number;
    size: number;
    maxWidth: number;
    measurer: TextMeasurer;
  },
): string[] {
  const { family, weight, size, maxWidth, measurer } = opts;

  // Split on explicit newlines first, then wrap each paragraph.
  const paragraphs = text.split("\n");
  const allLines: string[] = [];

  for (const para of paragraphs) {
    if (para.length === 0) {
      allLines.push("");
      continue;
    }

    const words = para.split(/\s+/);
    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = measurer.measure(word, { family, weight, size });
      const spaceWidth = currentLine.length > 0
        ? measurer.measure(" ", { family, weight, size })
        : 0;
      const addedWidth = wordWidth + spaceWidth;

      if (currentLine.length === 0) {
        // First word on the line — always fits (even if it overflows the box).
        currentLine = word;
        currentWidth = wordWidth;
      } else if (currentWidth + addedWidth <= maxWidth) {
        // Word fits on the current line.
        currentLine += " " + word;
        currentWidth += addedWidth;
      } else {
        // Word doesn't fit — start a new line.
        allLines.push(currentLine);
        currentLine = word;
        currentWidth = wordWidth;
      }
    }

    // Push the last line.
    allLines.push(currentLine);
  }

  return allLines;
}
