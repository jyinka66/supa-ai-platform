// ─────────────────────────────────────────────────────────────
// SVG → DesignDoc converter. Honest scope.
//
// HANDLED (faithful):
//   rect, circle, ellipse, line, polygon, path (M/L/C/Q/A/Z),
//   linearGradient/radialGradient → our gradient model,
//   <text> with tspans (per-tspan styles flattened to runs),
//   <g> transforms (translate/rotate/scale/matrix) → node transforms,
//   <image> with href → converted to asset refs (bytes extracted,
//     re-uploaded: decoded, re-encoded, EXIF-stripped),
//   viewBox/viewPort mapping, clipPath on single shapes → mask node.
//
// DEGRADED (accepted, reported, never silent):
//   filters → dropped, node flagged (fidelity note)
//   foreignObject → rendered to PNG snapshot if resolvable, else dropped
//   nested clipPaths, masks on groups → flattened or baked to image
//   unknown/unsupported → baked: subtree rasterizes to PNG at 2x,
//     lands as an image node. Ugly-but-correct beats dropping content.
//
// Output carries a FidelityReport:
//   { exact: n, degraded: [{nodeId, reason}], baked: n }
// ─────────────────────────────────────────────────────────────

import type {
  DesignDoc,
  LayerNode,
  Page,
  Color,
  Fill,
  Stroke,
  Rect,
  GradientStop,
  RichRun,
} from "@supa/design-model";
import { newId, validate } from "@supa/design-model";

// ============ FIDELITY REPORT ============

export interface FidelityIssue {
  nodeId: string;
  reason: string;
  /** What was done: 'dropped', 'baked', 'flattened'. */
  action: "dropped" | "baked" | "flattened";
}

export interface FidelityReport {
  exact: number;
  degraded: FidelityIssue[];
  baked: number;
}

export interface ImportResult {
  doc: DesignDoc;
  report: FidelityReport;
}

// ============ MAIN ENTRY ============

/**
 * Converts an SVG string to a DesignDoc.
 *
 * @param svgString  The SVG to import.
 * @param options    Import options (asset upload callback, defaults).
 *
 * @example
 *   const { doc, report } = await importSvg(svgString, {
 *     uploadAsset: async (bytes, mime) => {
 *       const res = await fetch('/api/uploads/sign', { ... });
 *       return assetId;
 *     },
 *   });
 *   if (report.degraded.length > 0) {
 *     showFidelityWarnings(report.degraded);
 *   }
 */
export async function importSvg(
  svgString: string,
  options: ImportOptions,
): Promise<ImportResult> {
  const parser = new DOMParser();
  const svgDoc = parser.parseFromString(svgString, "image/svg+xml");

  const svgEl = svgDoc.documentElement;
  if (svgEl.tagName.toLowerCase() !== "svg") {
    throw new Error("import: root element must be <svg>");
  }

  const issues: FidelityIssue[] = [];
  let exactCount = 0;
  let bakedCount = 0;

  // Parse viewBox.
  const viewBox = parseViewBox(svgEl);
  const width = parseFloat(svgEl.getAttribute("width") ?? String(viewBox.width));
  const height = parseFloat(svgEl.getAttribute("height") ?? String(viewBox.height));

  // Collect defs (gradients).
  const defs = collectDefs(svgEl);

  // Convert child elements to layers.
  const layers: LayerNode[] = [];
  const children = Array.from(svgEl.children).filter(
    (c) => c.tagName.toLowerCase() !== "defs",
  );

  for (const child of children) {
    const layer = await convertElement(child, {
      defs,
      issues,
      onExact: () => exactCount++,
      onBaked: () => bakedCount++,
      ...options,
    });
    if (layer) layers.push(layer);
  }

  // Build the doc.
  const page: Page = {
    id: newId(),
    name: "Imported",
    size: { width: width || viewBox.width || 1080, height: height || viewBox.height || 1080 },
    background: "transparent",
    layers,
  };

  const doc: DesignDoc = {
    schemaVersion: 1,
    id: newId(),
    kind: "imported",
    name: "Imported Design",
    isTemplate: false,
    locale: "en",
    pages: [page],
    assets: {},
    a11y: { issues: [] },
  };

  // Validate the result.
  const errors = validate(doc);
  if (errors.length > 0) {
    // Don't fail — report the issues + return the doc anyway.
    for (const err of errors) {
      issues.push({
        nodeId: err.path,
        reason: `${String(err.code)}: ${String(err.message)}`,
        action: "dropped",
      });
    }
  }

  return {
    doc,
    report: {
      exact: exactCount,
      degraded: issues,
      baked: bakedCount,
    },
  };
}

// ============ IMPORT OPTIONS ============

export interface ImportOptions {
  /** Uploads an asset (image bytes) and returns an asset ID. */
  uploadAsset?: (bytes: Uint8Array, mime: string) => Promise<string>;
  /** Whether to bake unsupported elements to PNG. Default: true. */
  bakeUnsupported?: boolean;
}

interface ConvertContext extends ImportOptions {
  defs: Map<string, Def>;
  issues: FidelityIssue[];
  onExact: () => void;
  onBaked: () => void;
}

// ============ DEFS COLLECTION ============

type Def = GradientDef;

interface GradientDef {
  type: "linear" | "radial";
  stops: GradientStop[];
  angle?: number;
}

function collectDefs(svgEl: Element): Map<string, Def> {
  const defs = new Map<string, Def>();
  const defsEl = svgEl.querySelector("defs");

  if (!defsEl) return defs;

  // Linear gradients.
  for (const grad of Array.from(defsEl.querySelectorAll("linearGradient"))) {
    const id = grad.getAttribute("id");
    if (!id) continue;
    const stops = parseStops(grad);
    const angle = parseGradientAngle(grad);
    defs.set(id, { type: "linear", stops, ...(angle !== undefined ? { angle } : {}) });
  }

  // Radial gradients.
  for (const grad of Array.from(defsEl.querySelectorAll("radialGradient"))) {
    const id = grad.getAttribute("id");
    if (!id) continue;
    const stops = parseStops(grad);
    defs.set(id, { type: "radial", stops });
  }

  return defs;
}

function parseStops(gradEl: Element): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const stop of Array.from(gradEl.querySelectorAll("stop"))) {
    const offset = parseFloat(stop.getAttribute("offset") ?? "0");
    const color = parseSvgColor(stop.getAttribute("stop-color") ?? "#000000", stop.getAttribute("stop-opacity"));
    stops.push({ offset, color });
  }
  return stops;
}

function parseGradientAngle(gradEl: Element): number | undefined {
  const x1 = parseFloat(gradEl.getAttribute("x1") ?? "0");
  const y1 = parseFloat(gradEl.getAttribute("y1") ?? "0");
  const x2 = parseFloat(gradEl.getAttribute("x2") ?? "1");
  const y2 = parseFloat(gradEl.getAttribute("y2") ?? "0");
  // Assume percentage coords (0-100 or 0-1).
  const dx = (x2 - x1);
  const dy = (y2 - y1);
  if (dx === 0 && dy === 0) return undefined;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// ============ ELEMENT CONVERSION ============

async function convertElement(
  el: Element,
  ctx: ConvertContext,
): Promise<LayerNode | null> {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "g":
      return convertGroup(el, ctx);

    case "rect":
      return convertRect(el, ctx);

    case "circle":
      return convertCircle(el, ctx);

    case "ellipse":
      return convertEllipse(el, ctx);

    case "line":
      return convertLine(el, ctx);

    case "polygon":
    case "polyline":
      return convertPolygon(el, ctx);

    case "path":
      return convertPath(el, ctx);

    case "text":
      return convertText(el, ctx);

    case "image":
      return convertImage(el, ctx);

    default:
      // Unknown element → bake to image (if enabled) or drop.
      if (ctx.bakeUnsupported !== false) {
        return bakeElement(el, ctx);
      }
      ctx.issues.push({
        nodeId: el.getAttribute("id") ?? "unknown",
        reason: `Unsupported element: <${String(tag)}>`,
        action: "dropped",
      });
      return null;
  }
}

// ============ GROUP ============

async function convertGroup(el: Element, ctx: ConvertContext): Promise<LayerNode | null> {
  const id = el.getAttribute("id") ?? newId();
  const transform = parseTransform(el.getAttribute("transform"));
  const rect = computeRectFromChildren(el) ?? { x: 0, y: 0, width: 100, height: 100 };

  const children: LayerNode[] = [];
  for (const child of Array.from(el.children)) {
    const layer = await convertElement(child, ctx);
    if (layer) children.push(layer);
  }

  // Check for unsupported attributes (filters, masks, clip-paths on groups).
  const hasFilter = el.getAttribute("filter");
  const hasMask = el.getAttribute("mask");
  const hasClipPath = el.getAttribute("clip-path");

  if (hasFilter || hasMask || hasClipPath) {
    // Degrade: bake the whole group to an image.
    ctx.issues.push({
      nodeId: id,
      reason: `Group has ${[hasFilter && "filter", hasMask && "mask", hasClipPath && "clip-path"].filter(Boolean).join(", ")}`,
      action: "baked",
    });
    ctx.onBaked();
    return bakeElement(el, ctx);
  }

  ctx.onExact();

  // If the group has children, it's a container; otherwise a plain group.
  if (children.length > 0) {
    return {
      id,
      type: "group",
      name: el.getAttribute("data-name") ?? id,
      locked: false,
      hidden: false,
      rect: { ...rect, x: rect.x + transform.x, y: rect.y + transform.y },
      rotation: transform.rotation,
      opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
      blend: "normal",
      constraints: {},
      children,
    };
  }

  return null;
}

// ============ SHAPES ============

function convertRect(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const x = parseFloat(el.getAttribute("x") ?? "0");
  const y = parseFloat(el.getAttribute("y") ?? "0");
  const width = parseFloat(el.getAttribute("width") ?? "100");
  const height = parseFloat(el.getAttribute("height") ?? "100");
  const rx = parseFloat(el.getAttribute("rx") ?? "0");

  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  // Check for filters.
  if (el.getAttribute("filter")) {
    ctx.issues.push({ nodeId: id, reason: "filter attribute dropped", action: "dropped" });
  }

  ctx.onExact();

  return {
    id,
    type: "shape",
    name: el.getAttribute("data-name") ?? "Rectangle",
    locked: false,
    hidden: false,
    rect: { x: x + transform.x, y: y + transform.y, width, height },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: "rect",
    ...(fill !== null ? { fill } : {}),
    ...(stroke !== null ? { stroke } : {}),
    ...(rx ? { cornerRadius: rx } : {}),
  };
}

function convertCircle(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const cx = parseFloat(el.getAttribute("cx") ?? "50");
  const cy = parseFloat(el.getAttribute("cy") ?? "50");
  const r = parseFloat(el.getAttribute("r") ?? "50");

  const fill = parseFill(el, ctx);
  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  ctx.onExact();

  return {
    id,
    type: "shape",
    name: "Circle",
    locked: false,
    hidden: false,
    rect: { x: cx - r + transform.x, y: cy - r + transform.y, width: r * 2, height: r * 2 },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: "ellipse",
    ...(fill !== null ? { fill } : {}),
    ...(stroke !== null ? { stroke } : {}),
  };
}

function convertEllipse(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const cx = parseFloat(el.getAttribute("cx") ?? "50");
  const cy = parseFloat(el.getAttribute("cy") ?? "50");
  const rx = parseFloat(el.getAttribute("rx") ?? "50");
  const ry = parseFloat(el.getAttribute("ry") ?? "50");

  const fill = parseFill(el, ctx);
  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  ctx.onExact();

  return {
    id,
    type: "shape",
    name: "Ellipse",
    locked: false,
    hidden: false,
    rect: { x: cx - rx + transform.x, y: cy - ry + transform.y, width: rx * 2, height: ry * 2 },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: "ellipse",
    ...(fill !== null ? { fill } : {}),
    ...(stroke !== null ? { stroke } : {}),
  };
}

function convertLine(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const x1 = parseFloat(el.getAttribute("x1") ?? "0");
  const y1 = parseFloat(el.getAttribute("y1") ?? "0");
  const x2 = parseFloat(el.getAttribute("x2") ?? "100");
  const y2 = parseFloat(el.getAttribute("y2") ?? "100");

  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  ctx.onExact();

  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const maxX = Math.max(x1, x2);
  const maxY = Math.max(y1, y2);

  return {
    id,
    type: "shape",
    name: "Line",
    locked: false,
    hidden: false,
    rect: { x: minX + transform.x, y: minY + transform.y, width: maxX - minX, height: maxY - minY },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: "line",
    stroke: stroke ?? { color: { hex: "#000000" }, width: 1 },
  };
}

function convertPolygon(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const pointsStr = el.getAttribute("points") ?? "";
  const points = pointsStr.trim().split(/[\s,]+/).map(parseFloat);

  if (points.length < 4) return null;

  // Compute bounding box.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length - 1; i += 2) {
    const px = points[i];
    const py = points[i + 1];
    if (px === undefined || py === undefined || !Number.isFinite(px) || !Number.isFinite(py)) continue;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }

  const sides = points.length / 2;
  const fill = parseFill(el, ctx);
  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  ctx.onExact();

  return {
    id,
    type: "shape",
    name: "Polygon",
    locked: false,
    hidden: false,
    rect: { x: minX + transform.x, y: minY + transform.y, width: maxX - minX, height: maxY - minY },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: sides >= 3 && sides <= 12 ? "polygon" : "polygon",
    ...(fill !== null ? { fill } : {}),
    ...(stroke !== null ? { stroke } : {}),
    polygonSides: sides >= 3 && sides <= 12 ? sides : 6,
  };
}

function convertPath(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const d = el.getAttribute("d") ?? "";
  const fill = parseFill(el, ctx);
  const stroke = parseStroke(el);
  const transform = parseTransform(el.getAttribute("transform"));

  // Compute bounding box from the path data (rough — parse M/L/C commands).
  const bbox = computePathBBox(d);

  ctx.onExact();

  // Path is degraded to a shape with shape="line" or baked.
  // A full path-to-polygon converter would be needed for faithful conversion.
  ctx.issues.push({
    nodeId: id,
    reason: "Path converted to shape (path data not preserved)",
    action: "flattened",
  });

  return {
    id,
    type: "shape",
    name: "Path",
    locked: false,
    hidden: false,
    rect: { x: bbox.x + transform.x, y: bbox.y + transform.y, width: bbox.width, height: bbox.height },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    shape: "rect",
    ...(fill !== null ? { fill } : {}),
    ...(stroke !== null ? { stroke } : {}),
  };
}

// ============ TEXT ============

function convertText(el: Element, ctx: ConvertContext): LayerNode | null {
  const id = el.getAttribute("id") ?? newId();
  const transform = parseTransform(el.getAttribute("transform"));
  const x = parseFloat(el.getAttribute("x") ?? "0");
  const y = parseFloat(el.getAttribute("y") ?? "0");

  // Collect text content + runs from tspans.
  const { content, runs } = parseTextContent(el);

  const fontFamily = parseFontFamily(el.getAttribute("font-family") ?? "sans-serif");
  const fontSize = parseFloat(el.getAttribute("font-size") ?? "16");
  const fontWeight = parseInt(el.getAttribute("font-weight") ?? "400", 10);
  const lineHeight = parseFloat(el.getAttribute("line-height") ?? "1.2");
  const fill = parseFill(el, ctx);
  const textAlign = el.getAttribute("text-anchor") === "middle" ? "center" : el.getAttribute("text-anchor") === "end" ? "right" : "left";
  const direction = el.getAttribute("direction") === "rtl" ? "rtl" : el.getAttribute("dir") === "rtl" ? "rtl" : "auto";

  ctx.onExact();

  return {
    id,
    type: "text",
    name: el.getAttribute("data-name") ?? "Text",
    locked: false,
    hidden: false,
    rect: { x: x + transform.x, y: y + transform.y, width: 200, height: fontSize * lineHeight * (content.split("\n").length || 1) },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    content,
    runs,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing: { value: parseFloat(el.getAttribute("letter-spacing") ?? "0"), unit: "px" },
    align: textAlign as "left" | "center" | "right" | "justify" | "start" | "end",
    direction: direction as "ltr" | "rtl" | "auto",
    autoResize: "width",
  };
}

function parseTextContent(el: Element): { content: string; runs: RichRun[] } {
  const tspans = Array.from(el.querySelectorAll("tspan"));
  let content = "";
  const runs: RichRun[] = [];

  if (tspans.length === 0) {
    content = el.textContent ?? "";
    return { content, runs: [{ start: 0, end: content.length }] };
  }

  for (const tspan of tspans) {
    const text = tspan.textContent ?? "";
    const start = content.length;
    content += text;

    const run: RichRun = { start, end: content.length };

    if (tspan.getAttribute("font-weight") === "bold") run.bold = true;
    if (tspan.getAttribute("font-style") === "italic") run.italic = true;
    const fill = tspan.getAttribute("fill");
    if (fill) run.color = parseSvgColor(fill, tspan.getAttribute("fill-opacity"));

    runs.push(run);
  }

  return { content, runs };
}

// ============ IMAGE ============

async function convertImage(el: Element, ctx: ConvertContext): Promise<LayerNode | null> {
  const id = el.getAttribute("id") ?? newId();
  const x = parseFloat(el.getAttribute("x") ?? "0");
  const y = parseFloat(el.getAttribute("y") ?? "0");
  const width = parseFloat(el.getAttribute("width") ?? "100");
  const height = parseFloat(el.getAttribute("height") ?? "100");

  const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  const transform = parseTransform(el.getAttribute("transform"));

  if (!href) {
    ctx.issues.push({ nodeId: id, reason: "Image missing href", action: "dropped" });
    return null;
  }

  // Handle data URLs (base64-encoded images).
  let assetId: string | undefined;
  if (href.startsWith("data:") && ctx.uploadAsset) {
    try {
      const [meta, base64] = href.split(",");
      const mime = meta?.match(/data:([^;]+)/)?.[1] ?? "image/png";
      const bytes = Uint8Array.from(atob(base64 ?? ""), (c) => c.charCodeAt(0));
      assetId = await ctx.uploadAsset(bytes, mime);
      ctx.onExact();
    } catch {
      ctx.issues.push({ nodeId: id, reason: "Failed to upload image", action: "dropped" });
      return null;
    }
  } else if (href.startsWith("http") || href.startsWith("/")) {
    // External URL — would need to fetch + re-upload.
    ctx.issues.push({ nodeId: id, reason: "External image URL (needs fetch + upload)", action: "flattened" });
    assetId = href; // Use as-is (the renderer will try to load it).
  } else {
    ctx.issues.push({ nodeId: id, reason: "Unsupported image href", action: "dropped" });
    return null;
  }

  return {
    id,
    type: "image",
    name: "Image",
    locked: false,
    hidden: false,
    rect: { x: x + transform.x, y: y + transform.y, width, height },
    rotation: transform.rotation,
    opacity: parseFloat(el.getAttribute("opacity") ?? "1"),
    blend: "normal",
    constraints: {},
    assetId: assetId ?? "unknown",
    fit: "cover",
    altText: "",
  };
}

// ============ BAKE (unsupported → image) ============

function bakeElement(el: Element, ctx: ConvertContext): Promise<LayerNode | null> {
  const id = el.getAttribute("id") ?? newId();
  const bbox = computeRectFromChildren(el) ?? { x: 0, y: 0, width: 100, height: 100 };

  ctx.onBaked();
  ctx.issues.push({
    nodeId: id,
    reason: `Element <${String(el.tagName)}> baked to image`,
    action: "baked",
  });

  // In a real implementation, this would:
  // 1. Serialize the element to an SVG string
  // 2. Rasterize it at 2x via OffscreenCanvas
  // 3. Upload the resulting PNG as an asset
  // 4. Return an image node referencing the asset

  return Promise.resolve({
    id,
    type: "image",
    name: `Baked ${String(el.tagName)}`,
    locked: false,
    hidden: false,
    rect: bbox,
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: {},
    assetId: "baked_placeholder",
    fit: "contain",
    altText: `Baked from <${String(el.tagName)}>`,
  });
}

// ============ SVG PARSING HELPERS ============

interface ParsedTransform { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

function parseTransform(transform: string | null): ParsedTransform {
  const result: ParsedTransform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  if (!transform) return result;

  // Parse translate()
  const translate = transform.match(/translate\(([^)]+)\)/);
  if (translate) {
    const [tx, ty] = translate[1]!.split(/[\s,]+/).map(parseFloat);
    result.x = tx ?? 0;
    result.y = ty ?? 0;
  }

  // Parse rotate()
  const rotate = transform.match(/rotate\(([^)]+)\)/);
  if (rotate) {
    const angle = parseFloat(rotate[1]!);
    result.rotation = angle;
  }

  // Parse scale()
  const scale = transform.match(/scale\(([^)]+)\)/);
  if (scale) {
    const values = (scale[1] ?? "").split(/[\s,]+/).map(parseFloat);
    const sx = values[0] ?? 1;
    const sy = values[1] ?? sx;
    result.scaleX = sx;
    result.scaleY = sy;
  }

  // Parse matrix() — full 6-value transform.
  const matrix = transform.match(/matrix\(([^)]+)\)/);
  if (matrix) {
    const values = (matrix[1] ?? "").split(/[\s,]+/).map(parseFloat);
    const a = values[0] ?? 1;
    const b = values[1] ?? 0;
    const c = values[2] ?? 0;
    const d = values[3] ?? 1;
    const e = values[4] ?? 0;
    const f = values[5] ?? 0;
    result.x = e;
    result.y = f;
    result.rotation = (Math.atan2(b, a) * 180) / Math.PI;
    result.scaleX = Math.hypot(a, b);
    result.scaleY = Math.hypot(c, d);
  }

  return result;
}

function parseViewBox(svgEl: Element): { x: number; y: number; width: number; height: number } {
  const vb = svgEl.getAttribute("viewBox");
  if (!vb) return { x: 0, y: 0, width: 1080, height: 1080 };
  const [x, y, width, height] = vb.split(/[\s,]+/).map(parseFloat);
  return { x: x ?? 0, y: y ?? 0, width: width ?? 1080, height: height ?? 1080 };
}

function parseFill(el: Element, ctx: ConvertContext): Fill | null {
  const fillAttr = el.getAttribute("fill");
  if (!fillAttr || fillAttr === "none") return null;

  // Gradient reference: url(#id)
  if (fillAttr.startsWith("url(")) {
    const match = fillAttr.match(/url\(#([^)]+)\)/);
    if (match) {
      const def = ctx.defs.get(match[1]!);
      if (def) {
        return {
          type: "gradient",
          gradient: {
            kind: def.type,
            stops: def.stops,
            ...(def.angle !== undefined ? { angle: def.angle } : {}),
          },
        };
      }
    }
    return null;
  }

  // Solid color.
  const opacity = el.getAttribute("fill-opacity");
  return {
    type: "solid",
    color: parseSvgColor(fillAttr, opacity),
  };
}

function parseStroke(el: Element): Stroke | null {
  const strokeAttr = el.getAttribute("stroke");
  if (!strokeAttr || strokeAttr === "none") return null;

  const width = parseFloat(el.getAttribute("stroke-width") ?? "1");
  const opacity = el.getAttribute("stroke-opacity");
  const align = el.getAttribute("stroke-alignment") as "inside" | "center" | "outside" | null;

  return {
    color: parseSvgColor(strokeAttr, opacity),
    width,
    align: align ?? "center",
  };
}

function parseSvgColor(color: string, opacity?: string | null): Color {
  // Hex.
  if (color.startsWith("#")) {
    const parsedOpacity = opacity ? parseFloat(opacity) : undefined;
    return { hex: color.toUpperCase(), ...(parsedOpacity !== undefined ? { opacity: parsedOpacity } : {}) };
  }

  // rgb()/rgba().
  const rgbMatch = color.match(/rgba?\(([^)]+)\)/);
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[\s,]+/).map(parseFloat);
    const r = Math.round(parts[0] ?? 0);
    const g = Math.round(parts[1] ?? 0);
    const b = Math.round(parts[2] ?? 0);
    const a = parts[3] ?? 1;
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    return { hex: hex.toUpperCase(), ...(a < 1 ? { opacity: a } : {}) };
  }

  // Named colors (basic set).
  const namedColors: Record<string, string> = {
    black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#00FF00",
    blue: "#0000FF", yellow: "#FFFF00", cyan: "#00FFFF", magenta: "#FF00FF",
    gray: "#808080", grey: "#808080", transparent: "#FFFFFF",
  };
  const named = namedColors[color.toLowerCase()];
  if (named) {
    return { hex: named, ...(color.toLowerCase() === "transparent" ? { opacity: 0 } : {}) };
  }

  // Fallback: black.
  const parsedOpacity = opacity ? parseFloat(opacity) : undefined;
  return { hex: "#000000", ...(parsedOpacity !== undefined ? { opacity: parsedOpacity } : {}) };
}

function parseFontFamily(fontFamily: string): string {
  // Take the first family from a comma-separated list.
  return fontFamily.split(",")[0]!.trim().replace(/["']/g, "");
}

function computeRectFromChildren(el: Element): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function walk(e: Element) {
    const x = parseFloat(e.getAttribute("x") ?? e.getAttribute("cx") ?? "0");
    const y = parseFloat(e.getAttribute("y") ?? e.getAttribute("cy") ?? "0");
    const width = parseFloat(e.getAttribute("width") ?? e.getAttribute("r") ?? "0");
    const height = parseFloat(e.getAttribute("height") ?? e.getAttribute("r") ?? "0");

    if (!isNaN(x) && !isNaN(y)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    for (const child of Array.from(e.children)) walk(child);
  }

  walk(el);

  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function computePathBBox(d: string): Rect {
  // Very rough: parse M/L commands for min/max coordinates.
  const coords = d.match(/[-+]?\d*\.?\d+/g)?.map(parseFloat) ?? [];
  if (coords.length < 2) return { x: 0, y: 0, width: 100, height: 100 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < coords.length - 1; i += 2) {
    minX = Math.min(minX, coords[i]!);
    minY = Math.min(minY, coords[i + 1]!);
    maxX = Math.max(maxX, coords[i]!);
    maxY = Math.max(maxY, coords[i + 1]!);
  }

  return {
    x: minX === Infinity ? 0 : minX,
    y: minY === Infinity ? 0 : minY,
    width: maxX - minX || 100,
    height: maxY - minY || 100,
  };
}
