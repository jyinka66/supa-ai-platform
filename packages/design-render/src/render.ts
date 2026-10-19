// ─────────────────────────────────────────────────────────────
// render(doc, { pageId, pixelRatio }) → { svg: string; width; height }
// Pure. Same doc bytes + same assets + same options = same SVG bytes.
//
// Rules:
//   1. No ids generated at render time — node ids are reused as DOM ids,
//      stripped in export (the export pipeline removes all id attributes).
//   2. Deterministic: same input → same SVG bytes (no timestamps, no random).
//   3. The golden-render harness consumes this directly for parity testing.
// ─────────────────────────────────────────────────────────────

import type { DesignDoc, Page, LayerNode, Fill, Color, TextLayer, ImageLayer, ShapeLayer, IconLayer, ContainerLayer, GroupLayer, Gradient } from "@supa/design-model";
import { getChildren } from "@supa/design-model";
import { type Matrix, IDENTITY, mul, trs } from "./transform";
import type { TextMeasurer } from "./measure";

export interface RenderOpts {
  pageId: string;
  /** viewBox scaling only — content coords stay 1x. */
  pixelRatio?: number;
  /** bleed/safe-area, editor-only; NEVER in export. */
  includeGuides?: boolean;
  /** editor-only overlays drawn in a separate layer. */
  selectionIds?: string[];
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
}

// ============ MAIN ENTRY ============

export function renderPage(
  doc: DesignDoc,
  measurer: TextMeasurer,
  opts: RenderOpts,
): RenderResult {
  const page = doc.pages.find((p) => p.id === opts.pageId);
  if (!page) throw new Error(`renderPage: page ${opts.pageId} not found`);

  const W = page.size.width;
  const H = page.size.height;
  const pr = opts.pixelRatio ?? 1;
  const parts: string[] = [];

  // SVG root.
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${String(W)} ${String(H)}" width="${String(W * pr)}" height="${String(H * pr)}">`,
  );

  // Defs (gradients, clips, patterns).
  const defs = new DefsBuilder();

  // Background.
  parts.push(renderBackground(page, W, H));

  // Layers (skip hidden).
  const body = page.layers
    .filter((l) => !l.hidden)
    .map((l) => renderNode(l, IDENTITY, doc, measurer, defs));
  parts.push(...body);

  // Editor-only guides.
  if (opts.includeGuides) {
    parts.push(renderGuides(page, W, H));
  }

  // Editor-only selection overlay.
  if (opts.selectionIds && opts.selectionIds.length > 0) {
    parts.push(renderSelectionOverlay(page, opts.selectionIds));
  }

  // Defs at the end (SVG spec allows defs anywhere, but putting them
  // at the top is the convention — emit before closing).
  const defsStr = defs.emit();
  if (defsStr) {
    parts.unshift(defsStr);
  }

  parts.push("</svg>");

  return { svg: parts.join(""), width: W, height: H };
}

// ============ RENDER NODE ============

function renderNode(
  node: LayerNode,
  parentMatrix: Matrix,
  doc: DesignDoc,
  measurer: TextMeasurer,
  defs: DefsBuilder,
): string {
  if (node.hidden) return "";

  const matrix = mul(parentMatrix, trs(node.rect, node.rotation));
  const transform = matrixToTransform(matrix);
  const opacity = node.opacity < 1 ? ` opacity="${String(node.opacity)}"` : "";
  const blend = node.blend !== "normal" ? ` style="mix-blend-mode:${escapeXml(node.blend)}"` : "";
  const id = ` id="${escapeXml(node.id)}"`;
  const parts: string[] = [];

  switch (node.type) {
    case "text":
      parts.push(renderText(node, measurer, transform, id, opacity, blend));
      break;
    case "image":
      parts.push(renderImage(node, doc, transform, id, opacity, blend, defs));
      break;
    case "shape":
      parts.push(renderShape(node, transform, id, opacity, blend, defs));
      break;
    case "icon":
      parts.push(renderIcon(node, transform, id, opacity, blend));
      break;
    case "container":
      parts.push(renderContainer(node, parentMatrix, doc, measurer, defs, transform, id, opacity, blend));
      break;
    case "group":
      parts.push(renderGroup(node, parentMatrix, doc, measurer, defs, transform, id, opacity, blend));
      break;
  }

  return parts.join("");
}

// ============ TEXT ============

function renderText(
  layer: TextLayer,
  measurer: TextMeasurer,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
): string {
  const { content, runs, fontFamily, fontSize, fontWeight, lineHeight, align, direction } = layer;
  const lh = fontSize * lineHeight;

  // Split into lines (simple — no wrapping here; wrapping is the renderer's job).
  const lines = content.split("\n");

  const tspans = lines.map((line, i) => {
    const y = i * lh + fontSize; // baseline ≈ fontSize for first line
    const dir = direction === "rtl" ? ` dir="rtl"` : direction === "auto" ? ` dir="auto"` : "";
    const anchor = align === "center" ? ` text-anchor="middle"` : align === "right" || align === "end" ? ` text-anchor="end"` : "";

    // Apply runs (rich text).
    if (runs.length === 0) {
      return `<tspan x="0" y="${String(y)}"${anchor}${dir}>${escapeXml(line)}</tspan>`;
    }

    // Split line into segments based on runs.
    const segments: Array<{ text: string; bold?: boolean; italic?: boolean; color?: Color; link?: string; fontFamily?: string; fontSize?: number }> = [];
    let pos = 0;
    for (const run of runs) {
      if (run.start > pos) {
        segments.push({ text: content.slice(pos, run.start) });
      }
      segments.push({
        text: content.slice(run.start, run.end),
        ...(run.bold !== undefined ? { bold: run.bold } : {}),
        ...(run.italic !== undefined ? { italic: run.italic } : {}),
        ...(run.color !== undefined ? { color: run.color } : {}),
        ...(run.link !== undefined ? { link: run.link } : {}),
        ...(run.fontFamily !== undefined ? { fontFamily: run.fontFamily } : {}),
        ...(run.fontSize !== undefined ? { fontSize: run.fontSize } : {}),
      });
      pos = run.end;
    }
    if (pos < content.length) {
      segments.push({ text: content.slice(pos) });
    }

    // Only include segments that overlap with this line.
    // Simple approach: include all (runs are relative to the whole content,
    // so we just render the line text with inline tspans for style changes).
    const tspansInner = segments
      .filter((s) => s.text.length > 0)
      .map((s) => {
        let attrs = "";
        if (s.bold) attrs += ` font-weight="bold"`;
        if (s.italic) attrs += ` font-style="italic"`;
        if (s.color) attrs += ` fill="${colorToHex(s.color)}"`;
        if (s.fontFamily) attrs += ` font-family="${escapeXml(s.fontFamily)}"`;
        if (s.fontSize) attrs += ` font-size="${String(s.fontSize)}"`;
        return `<tspan${attrs}>${escapeXml(s.text)}</tspan>`;
      })
      .join("");

    return `<tspan x="0" y="${String(y)}"${anchor}${dir}>${tspansInner}</tspan>`;
  });

  return (
    `<text${id} transform="${transform}"` +
    ` font-family="${escapeXml(fontFamily)}"` +
    ` font-size="${String(fontSize)}"` +
    ` font-weight="${String(fontWeight)}"` +
    ` text-anchor="${align === "center" ? "middle" : align === "right" || align === "end" ? "end" : "start"}"` +
    ` direction="${direction}"` +
    opacity + blend + `>` +
    tspans.join("") +
    `</text>`
  );
}

// ============ IMAGE ============

function renderImage(
  layer: ImageLayer,
  doc: DesignDoc,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
  defs: DefsBuilder,
): string {
  const asset = doc.assets[layer.assetId];
  if (!asset) return ""; // missing asset — render nothing

  const { width, height } = layer.rect;
  const { fit, altText } = layer;
  let preserveAspect: string;
  switch (fit) {
    case "cover": preserveAspect = "xMidYMid slice"; break;
    case "contain": preserveAspect = "xMidYMid meet"; break;
    case "fill": preserveAspect = "none"; break;
  }

  const href = asset.kind === "svg" ? ` xlink:href="${escapeXml(asset.ref)}"` : ` xlink:href="${escapeXml(asset.ref)}"`;
  const filters: string[] = [];
  if (layer.filters) {
    if (layer.filters.brightness !== undefined) filters.push(`brightness(${String(layer.filters.brightness)})`);
    if (layer.filters.contrast !== undefined) filters.push(`contrast(${String(layer.filters.contrast)})`);
    if (layer.filters.saturation !== undefined) filters.push(`saturate(${String(layer.filters.saturation)})`);
    if (layer.filters.blur !== undefined) filters.push(`blur(${String(layer.filters.blur)}px)`);
  }
  const filterAttr = filters.length > 0 ? ` filter="${filters.join(" ")}"` : "";
  const altAttr = altText ? ` role="img" aria-label="${escapeXml(altText)}"` : "";

  return `<image${id} transform="${transform}" width="${String(width)}" height="${String(height)}" preserveAspectRatio="${preserveAspect}"${href}${filterAttr}${altAttr}${opacity}${blend} />`;
}

// ============ SHAPE ============

function renderShape(
  layer: ShapeLayer,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
  defs: DefsBuilder,
): string {
  const { width, height } = layer.rect;
  const { fill, stroke, cornerRadius, shape, polygonSides } = layer;
  const fillAttr = fill ? renderFill(fill, defs) : "none";
  const strokeAttr = stroke ? ` stroke="${colorToHex(stroke.color)}" stroke-width="${String(stroke.width)}"` : "";

  switch (shape) {
    case "rect": {
      const rx = cornerRadius ? ` rx="${String(cornerRadius)}" ry="${String(cornerRadius)}"` : "";
      return `<rect${id} transform="${transform}" x="0" y="0" width="${String(width)}" height="${String(height)}"${rx} fill="${fillAttr}"${strokeAttr}${opacity}${blend} />`;
    }
    case "ellipse": {
      return `<ellipse${id} transform="${transform}" cx="${String(width / 2)}" cy="${String(height / 2)}" rx="${String(width / 2)}" ry="${String(height / 2)}" fill="${fillAttr}"${strokeAttr}${opacity}${blend} />`;
    }
    case "triangle": {
      const points = `${String(width / 2)},0 ${String(width)},${String(height)} 0,${String(height)}`;
      return `<polygon${id} transform="${transform}" points="${points}" fill="${fillAttr}"${strokeAttr}${opacity}${blend} />`;
    }
    case "polygon": {
      const sides = polygonSides ?? 6;
      const cx = width / 2, cy = height / 2, r = Math.min(width, height) / 2;
      const points = Array.from({ length: sides }, (_, i) => {
        const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
        return `${String(cx + r * Math.cos(angle))},${String(cy + r * Math.sin(angle))}`;
      }).join(" ");
      return `<polygon${id} transform="${transform}" points="${points}" fill="${fillAttr}"${strokeAttr}${opacity}${blend} />`;
    }
    case "line": {
      return `<line${id} transform="${transform}" x1="0" y1="0" x2="${String(width)}" y2="${String(height)}" stroke="${stroke ? colorToHex(stroke.color) : "#000"}" stroke-width="${String(stroke?.width ?? 1)}"${opacity}${blend} />`;
    }
    default:
      return "";
  }
}

// ============ ICON ============

function renderIcon(
  layer: IconLayer,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
): string {
  const { width, height } = layer.rect;
  const { color, library, iconId } = layer;
  // Icons are rendered as <use> referencing a sprite sheet.
  // The sprite sheet is loaded as a <symbol> in defs.
  const ref = `${library}#${iconId}`;
  return `<use${id} transform="${transform}" width="${String(width)}" height="${String(height)}" xlink:href="#${escapeXml(ref)}" fill="${colorToHex(color)}"${opacity}${blend} />`;
}

// ============ CONTAINER ============

function renderContainer(
  layer: ContainerLayer,
  parentMatrix: Matrix,
  doc: DesignDoc,
  measurer: TextMeasurer,
  defs: DefsBuilder,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
): string {
  const { width, height } = layer.rect;
  const { fill, cornerRadius, clip, children } = layer;
  const fillAttr = fill ? renderFill(fill, defs) : "none";
  const rx = cornerRadius ? ` rx="${String(cornerRadius)}" ry="${String(cornerRadius)}"` : "";
  const clipAttr = clip ? ` clip-path="inset(0 round ${String(cornerRadius ?? 0)}px)"` : "";

  const childrenSvg = (children ?? [])
    .filter((c) => !c.hidden)
    .map((c) => renderNode(c, parentMatrix, doc, measurer, defs))
    .join("");

  return (
    `<g${id} transform="${transform}"${opacity}${blend}>` +
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}"${rx} fill="${fillAttr}"${clipAttr} />` +
    childrenSvg +
    `</g>`
  );
}

// ============ GROUP ============

function renderGroup(
  layer: GroupLayer,
  parentMatrix: Matrix,
  doc: DesignDoc,
  measurer: TextMeasurer,
  defs: DefsBuilder,
  transform: string,
  id: string,
  opacity: string,
  blend: string,
): string {
  const childrenSvg = (layer.children ?? [])
    .filter((c) => !c.hidden)
    .map((c) => renderNode(c, parentMatrix, doc, measurer, defs))
    .join("");

  return `<g${id} transform="${transform}"${opacity}${blend}>${childrenSvg}</g>`;
}

// ============ BACKGROUND ============

function renderBackground(page: Page, W: number, H: number): string {
  if (page.background === "transparent") return "";
  return renderFill(page.background, new DefsBuilder()) === "none"
    ? ""
    : `<rect x="0" y="0" width="${String(W)}" height="${String(H)}" fill="${renderFill(page.background, new DefsBuilder())}" />`;
}

// ============ GUIDES (editor-only) ============

function renderGuides(page: Page, W: number, H: number): string {
  const parts: string[] = [`<g class="guides" style="pointer-events:none">`];

  // Safe area (5% inset).
  const sx = W * 0.05, sy = H * 0.05, sw = W * 0.9, sh = H * 0.9;
  parts.push(`<rect x="${String(sx)}" y="${String(sy)}" width="${String(sw)}" height="${String(sh)}" fill="none" stroke="#00f" stroke-width="0.5" stroke-dasharray="4 4" />`);

  // Bleed.
  if (page.bleed) {
    const b = page.bleed;
    parts.push(`<rect x="${String(-b)}" y="${String(-b)}" width="${String(W + 2 * b)}" height="${String(H + 2 * b)}" fill="none" stroke="#f00" stroke-width="0.5" stroke-dasharray="2 2" />`);
  }

  parts.push(`</g>`);
  return parts.join("");
}

// ============ SELECTION OVERLAY (editor-only) ============

function renderSelectionOverlay(page: Page, selectionIds: string[]): string {
  const parts: string[] = [`<g class="selection" style="pointer-events:none">`];

  for (const id of selectionIds) {
    // Find the node + compute its AABB in page space.
    const findNode = (layers: LayerNode[]): LayerNode | null => {
      for (const l of layers) {
        if (l.id === id) return l;
        const children = getChildren(l);
        const found = findNode(children);
        if (found) return found;
      }
      return null;
    };

    const node = findNode(page.layers);
    if (!node) continue;

    const { x, y, width, height } = node.rect;
    const t = trs(node.rect, node.rotation);

    // Draw a rect around the node (in its local space, transformed).
    parts.push(
      `<rect transform="${matrixToTransform(t)}" x="0" y="0" width="${String(width)}" height="${String(height)}" ` +
      `fill="none" stroke="#3b82f6" stroke-width="1" stroke-dasharray="3 2" />`,
    );
  }

  parts.push(`</g>`);
  return parts.join("");
}

// ============ FILL RENDERING ============

function renderFill(fill: Fill, defs: DefsBuilder): string {
  switch (fill.type) {
    case "solid":
      return colorToHex(fill.color);

    case "gradient": {
      const id = defs.addGradient(fill.gradient);
      return `url(#${id})`;
    }
  }
}

// ============ DEFS BUILDER ============

class DefsBuilder {
  private gradients = new Map<string, string>();
  private gradientId = 0;

  addGradient(gradient: Gradient): string {
    const key = JSON.stringify(gradient);
    const existing = this.gradients.get(key);
    if (existing) return existing;

    const id = `grad_${String(this.gradientId++)}`;
    this.gradients.set(key, id);
    return id;
  }

  emit(): string {
    if (this.gradients.size === 0) return "";

    const parts: string[] = ["<defs>"];
    for (const [json, id] of this.gradients) {
      const gradient: Gradient = JSON.parse(json);
      const tag = gradient.kind === "linear" ? "linearGradient" : "radialGradient";
      const angle = gradient.angle ?? 0;
      const x1 = 50 - Math.cos((angle * Math.PI) / 180) * 50;
      const y1 = 50 - Math.sin((angle * Math.PI) / 180) * 50;
      const x2 = 50 + Math.cos((angle * Math.PI) / 180) * 50;
      const y2 = 50 + Math.sin((angle * Math.PI) / 180) * 50;

      const stops = gradient.stops
        .map((s) => `<stop offset="${String(s.offset * 100)}%" stop-color="${colorToHex(s.color)}" />`)
        .join("");

      if (gradient.kind === "linear") {
        parts.push(
          `<${tag} id="${id}" gradientUnits="userSpaceOnUse" x1="${String(x1)}%" y1="${String(y1)}%" x2="${String(x2)}%" y2="${String(y2)}%">${stops}</${tag}>`,
        );
      } else {
        parts.push(`<${tag} id="${id}" cx="50%" cy="50%" r="50%">${stops}</${tag}>`);
      }
    }
    parts.push("</defs>");
    return parts.join("");
  }
}

// ============ HELPERS ============

function matrixToTransform(m: Matrix): string {
  return `matrix(${String(m.a)},${String(m.b)},${String(m.c)},${String(m.d)},${String(m.e)},${String(m.f)})`;
}

function colorToHex(color: Color): string {
  const { hex, opacity } = color;
  if (opacity !== undefined && opacity < 1) {
    // Convert hex + opacity to rgba.
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${String(r)},${String(g)},${String(b)},${String(opacity)})`;
  }
  return hex;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
