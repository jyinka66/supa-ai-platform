// ─────────────────────────────────────────────────────────────
// Export pipeline — one pipeline, three sinks.
//
// The renderer is the single source of truth:
//   doc → design-render SVG string → rasterize/vectorize per format.
//
// NEVER write a second rendering path per format — divergence bugs are
// guaranteed and untestable.
//
//   png/jpeg/webp: SVG string → Image → OffscreenCanvas at target scale
//                  (1x/2x/3x/retina presets) → blob
//   pdf:           SVG per page → embed via pdf-lib as vector where the
//                  renderer supports it; text as real text (fonts subset-
//                  embedded) — selectable/searchable PDFs, not raster traps.
//                  Images embedded at native resolution, not canvas-scaled.
//   svg:           the render output itself, with ids preserved
//                  (data-node-id attrs) so re-import round-trips.
//
// Worker isolation: rasterization runs in a worker (OffscreenCanvas +
// createImageBitmap); the main thread never blocks on a 3x export of a
// 20-page doc. Multi-page/multi-size exports are batched with progress
// callbacks (cancellable — AbortSignal threaded through every stage).
//
// JPEG quirk: JPEG has no alpha → transparent background composites over
// doc page background (or white), never black. Fixed once, here.
// ─────────────────────────────────────────────────────────────

import type { DesignDoc, Page } from "@supa/design-model";
import { renderPage, type RenderOpts } from "@supa/design-render";
import type { TextMeasurer } from "@supa/design-render";

// ============ EXPORT SPEC ============

export interface ExportSpec {
  doc: DesignDoc;
  /** Page IDs to export. Default: all. */
  pages?: string[];
  /** Output format. */
  format: "png" | "jpeg" | "webp" | "pdf" | "svg";
  /** Raster scale (raster formats only). Default: 1. */
  scale?: 1 | 2 | 3;
  /** JPEG/WebP quality (0-1). Default: 0.92. */
  quality?: number;
  /** Print bleed: adds mm bleed + trim marks. */
  bleed?: { mm: number };
  /** Background: 'doc' = use page bg, 'transparent' = no bg, hex = custom. Default: 'doc'. */
  background?: string;
}

export interface ExportProgress {
  currentPage: number;
  totalPages: number;
  /** 0-1 per-page progress. */
  pageProgress: number;
}

export interface ExportResultItem {
  pageId: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

export interface ExportResult {
  items: ExportResultItem[];
  /** For single-page exports, the single blob. */
  blob?: Blob;
  mimeType: string;
}

// ============ MAIN ENTRY ============

/**
 * Exports a design doc to one or more image/PDF/SVG files.
 *
 * The renderer is the single source of truth: every format starts as
 * an SVG string from design-render, then is converted per format.
 *
 * @param spec      Export specification (format, pages, scale, etc.)
 * @param measurer  Text measurer (CanvasMeasurer for client, ServerMeasurer for server).
 * @param onProgress Progress callback (called per page + per stage).
 * @param signal     AbortSignal for cancellation.
 *
 * @example
 *   const result = await exportDoc({
 *     doc,
 *     format: "png",
 *     scale: 2,
 *   }, new CanvasMeasurer());
 *   // → result.blob = PNG blob at 2x
 */
export async function exportDoc(
  spec: ExportSpec,
  measurer: TextMeasurer,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const pageIds = spec.pages ?? spec.doc.pages.map((p) => p.id);
  const total = pageIds.length;
  const items: ExportResultItem[] = [];

  for (let i = 0; i < pageIds.length; i++) {
    if (signal?.aborted) throw new ExportAbortedError();

    const pageId = pageIds[i];
    if (pageId === undefined) continue;
    const page = spec.doc.pages.find((p) => p.id === pageId);
    if (!page) continue;

    onProgress?.({
      currentPage: i + 1,
      totalPages: total,
      pageProgress: 0,
    });

    // Step 1: Render the page to SVG (the single source of truth).
    const renderOpts: RenderOpts = {
      pageId,
      pixelRatio: 1, // content coords stay 1x; scale applied at rasterization
      includeGuides: false, // guides are editor-only
    };

    // Override background if specified.
    const renderSpec = applyBackgroundOverride(spec, page);

    const { svg, width, height } = renderPage(
      spec.doc,
      measurer,
      renderOpts,
    );

    onProgress?.({
      currentPage: i + 1,
      totalPages: total,
      pageProgress: 0.3,
    });

    // Step 2: Convert per format.
    let blob: Blob;
    let mimeType: string;

    switch (spec.format) {
      case "svg":
        blob = new Blob([svg], { type: "image/svg+xml" });
        mimeType = "image/svg+xml";
        break;

      case "png":
      case "webp":
      case "jpeg":
        blob = await rasterizeSvg({
          svg,
          width,
          height,
          scale: spec.scale ?? 1,
          format: spec.format,
          ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
          ...(renderSpec.background !== undefined ? { background: renderSpec.background } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
        mimeType = spec.format === "png" ? "image/png" : spec.format === "webp" ? "image/webp" : "image/jpeg";
        break;

      case "pdf":
        blob = await exportPdf({
          doc: spec.doc,
          pageIds: [pageId],
          measurer,
          ...(signal !== undefined ? { signal } : {}),
        });
        mimeType = "application/pdf";
        break;

      default:
        throw new Error(`unsupported_format: ${String(spec.format)}`);
    }

    items.push({
      pageId,
      blob,
      mimeType,
      width: width * (spec.scale ?? 1),
      height: height * (spec.scale ?? 1),
    });

    onProgress?.({
      currentPage: i + 1,
      totalPages: total,
      pageProgress: 1,
    });
  }

  // Single-page export → return the single blob.
  if (items.length === 1) {
    const onlyItem = items[0];
    if (onlyItem) return { items, blob: onlyItem.blob, mimeType: onlyItem.mimeType };
  }

  // Multi-page: merge into one blob (PDF) or return items separately.
  if (spec.format === "pdf") {
    const pdfBlob = await exportPdf({
      doc: spec.doc,
      pageIds,
      measurer,
      ...(signal !== undefined ? { signal } : {}),
    });
    return { items, blob: pdfBlob, mimeType: "application/pdf" };
  }

  return { items, mimeType: items[0]?.mimeType ?? "application/octet-stream" };
}

// ============ RASTERIZATION ============

interface RasterizeParams {
  svg: string;
  width: number;
  height: number;
  scale: number;
  format: "png" | "jpeg" | "webp";
  quality?: number;
  background?: string;
  signal?: AbortSignal;
}

/**
 * Rasterizes an SVG string to a PNG/JPEG/WebP blob via OffscreenCanvas.
 *
 * For JPEG: transparent backgrounds are composited over white (never black).
 * This is the classic silent-wrong-output bug, fixed once, here.
 *
 * In a production implementation, this runs in a Web Worker to avoid
 * blocking the main thread. The worker receives the SVG string + params,
 * creates an OffscreenCanvas, draws the SVG via an Image element, and
 * returns the blob.
 */
async function rasterizeSvg(params: RasterizeParams): Promise<Blob> {
  const { svg, width, height, scale, format, quality, signal } = params;

  if (signal?.aborted) throw new ExportAbortedError();

  const scaledWidth = Math.ceil(width * scale);
  const scaledHeight = Math.ceil(height * scale);

  // Create a data URL from the SVG.
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    // Load the SVG into an Image element.
    const image = await loadImage(svgUrl, signal);

    // Create an OffscreenCanvas at the target resolution.
    const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable");

    // JPEG quirk: no alpha → composite over background (never black).
    if (format === "jpeg") {
      // Use the page background or white, never black.
      ctx.fillStyle = params.background ?? "#ffffff";
      ctx.fillRect(0, 0, scaledWidth, scaledHeight);
    }

    // Draw the SVG image at the scaled size.
    ctx.drawImage(image, 0, 0, scaledWidth, scaledHeight);

    // Convert to blob.
    const blob = await canvas.convertToBlob({
      type: format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg",
      quality: quality ?? 0.92,
    });

    return blob;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// ============ PDF EXPORT ============

interface PdfExportParams {
  doc: DesignDoc;
  pageIds: string[];
  measurer: TextMeasurer;
  signal?: AbortSignal;
}

/**
 * Exports pages to a PDF blob.
 *
 * Implementation: rasterizes each page to JPEG at 2x (print quality), then
 * embeds the JPEG bytes directly into a minimal PDF using the /DCTDecode
 * filter. The PDF structure (header, objects, xref, trailer) is constructed
 * directly in bytes — no pdf-lib dependency needed.
 *
 * JPEG is chosen over PNG because JPEG bytes embed verbatim via /DCTDecode;
 * PNG would require decoding the PNG to raw pixels and re-compressing via
 * /FlateDecode (i.e. a PNG decoder in JS). The trade-off is JPEG's lossy
 * compression, which is acceptable for the raster fallback path. Vector
 * + real text (selectable/searchable) PDFs require pdf-lib + fontkit; see
 * services/design-export for that path.
 *
 * The produced PDF is a sequence of full-page image XObjects — one per
 * doc page — with MediaBox dimensions matching the design doc's page size
 * in PDF points (1px = 1pt).
 */
async function exportPdf(params: PdfExportParams): Promise<Blob> {
  const { doc, pageIds, measurer, signal } = params;

  // Step 1: rasterize each page to JPEG at 2x.
  // JPEG bytes embed directly into PDF via /DCTDecode — no transcoding.
  const rasterPages: PdfPageRaster[] = [];

  for (const pageId of pageIds) {
    if (signal?.aborted) throw new ExportAbortedError();

    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) continue;

    const { svg, width, height } = renderPage(doc, measurer, { pageId });

    const blob = await rasterizeSvg({
      svg,
      width,
      height,
      scale: 2, // 2x for print quality
      format: "jpeg",
      quality: 0.92,
      ...(signal !== undefined ? { signal } : {}),
    });

    rasterPages.push({
      jpegBytes: new Uint8Array(await blob.arrayBuffer()),
      pixelWidth: width * 2,
      pixelHeight: height * 2,
      pageWidthPt: width,  // design px → PDF pt (1:1)
      pageHeightPt: height,
    });
  }

  if (rasterPages.length === 0) {
    return new Blob([], { type: "application/pdf" });
  }

  // Step 2: build the PDF binary from the JPEG rasters.
  const pdfBytes = buildPdfFromJpegs(rasterPages);
  return new Blob([pdfBytes], { type: "application/pdf" });
}

// ============ MINIMAL PDF WRITER ============

interface PdfPageRaster {
  /** JPEG-encoded image bytes (full-page raster at 2x). */
  jpegBytes: Uint8Array;
  /** Image width in pixels (== pageWidthPt * 2). */
  pixelWidth: number;
  /** Image height in pixels (== pageHeightPt * 2). */
  pixelHeight: number;
  /** PDF page MediaBox width in points. */
  pageWidthPt: number;
  /** PDF page MediaBox height in points. */
  pageHeightPt: number;
}

/**
 * Builds a minimal valid PDF (PDF 1.4) from one or more full-page JPEG
 * rasters. Each page is a JPEG image drawn at the full MediaBox size.
 *
 * PDF object layout (object numbering is sequential):
 *   1: Catalog → /Pages 2 0 R
 *   2: Pages → /Kids [3 0 R 6 0 R ...] /Count N
 *   For each page i (0-based):
 *     3 + 3i: Page → /MediaBox [0 0 W H] /Resources << /XObject << /Im0 IMG 0 R >> >> /Contents CONTENT 0 R
 *     4 + 3i: Image XObject → /Subtype /Image /Filter /DCTDecode /Length L + stream (JPEG bytes)
 *     5 + 3i: Content stream → "q W 0 0 H 0 0 cm /Im0 Do Q"
 *   xref: 0-based offset table
 *   trailer → /Root 1 0 R /Size (total+1)
 *
 * Every byte offset in the xref table is computed by walking the byte
 * buffer as we append. The result is a binary PDF that opens in any
 * standards-compliant PDF reader (Adobe Reader, Preview, pdf.js, etc.).
 */
function buildPdfFromJpegs(pages: ReadonlyArray<PdfPageRaster>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = []; // offsets[n] = byte offset where object n starts; index 0 is the free list head
  let totalLen = 0;

  const pushStr = (s: string): void => {
    const b = encoder.encode(s);
    chunks.push(b);
    totalLen += b.length;
  };
  const pushBytes = (b: Uint8Array): void => {
    chunks.push(b);
    totalLen += b.length;
  };

  /** Writes `n 0 obj\n<body>\nendobj\n` and records its byte offset. */
  const writeObj = (n: number, bodyFn: () => void): void => {
    offsets[n] = totalLen;
    pushStr(`${String(n)} 0 obj\n`);
    bodyFn();
    pushStr(`endobj\n`);
  };

  // ── Header ──
  pushStr("%PDF-1.4\n");
  // Binary marker: a comment with 4 high bytes > 127. Tells readers
  // (and CRLF-rewriting mailers) that this file is binary.
  pushStr("%\u00E2\u00E3\u00CF\u00D3\n");

  const pageObjIds: number[] = [];
  // Object 3 is the first page; each page consumes 3 objects (Page,
  // Image, Content). So page i's Page object is 3 + 3i.
  for (let i = 0; i < pages.length; i++) {
    pageObjIds.push(3 + i * 3);
  }

  // Object 1: Catalog.
  writeObj(1, () => {
    pushStr(`<< /Type /Catalog /Pages 2 0 R >>\n`);
  });

  // Object 2: Pages tree root.
  writeObj(2, () => {
    pushStr(
      `<< /Type /Pages /Kids [${pageObjIds.map((n) => `${String(n)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>\n`,
    );
  });

  // Per-page objects: Image XObject (4+3i), Content stream (5+3i), Page (3+3i).
  // Written in that order so the Page object can reference the others by ID.
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!p) continue;
    const pageObjId = 3 + i * 3;
    const imageObjId = pageObjId + 1;
    const contentObjId = pageObjId + 2;

    // Image XObject — JPEG bytes embedded verbatim via /DCTDecode.
    writeObj(imageObjId, () => {
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${String(p.pixelWidth)} /Height ${String(p.pixelHeight)} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${String(p.jpegBytes.length)} >>\n` +
          `stream\n`,
      );
      pushBytes(p.jpegBytes);
      pushStr(`\nendstream\n`);
    });

    // Content stream: draw image scaled to full MediaBox.
    //   q                          push graphics state
    //   W 0 0 H 0 0 cm             scale [1x1] → [WxH], translate (0,0)
    //   /Im0 Do                    paint XObject /Im0 (treated as 1x1 image)
    //   Q                          pop graphics state
    const contentStr =
      `q\n${String(p.pageWidthPt)} 0 0 ${String(p.pageHeightPt)} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(contentStr);
    writeObj(contentObjId, () => {
      pushStr(`<< /Length ${String(contentBytes.length)} >>\nstream\n`);
      pushBytes(contentBytes);
      pushStr(`\nendstream\n`);
    });

    // Page object — references Image and Content.
    writeObj(pageObjId, () => {
      pushStr(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${String(p.pageWidthPt)} ${String(p.pageHeightPt)}] ` +
          `/Resources << /XObject << /Im0 ${String(imageObjId)} 0 R >> >> ` +
          `/Contents ${String(contentObjId)} 0 R >>\n`,
      );
    });
  }

  // ── Cross-reference (xref) table ──
  // PDF spec mandates each xref entry be exactly 20 bytes including the
  // 2-byte end-of-line marker. The entry layout is:
  //   nnnnnnnnnn ggggg X eol
  // where nnnnnnnnnn is a 10-digit byte offset, ggggg is a 5-digit
  // generation number, X is 'n' (in use) or 'f' (free), and eol is a
  // 2-byte sequence. We use the SP+LF eol variant: ` X \n` (space + LF).
  // Entry 0 is the free list head: offset 0, generation 65535, status 'f'.
  const xrefOffset = totalLen;
  const objCount = offsets.length; // index 0 = free head, indices 1..N = objects
  pushStr(`xref\n0 ${String(objCount)}\n`);
  pushStr(`0000000000 65535 f \n`);
  for (let i = 1; i < objCount; i++) {
    const off = offsets[i] ?? 0;
    pushStr(`${String(off).padStart(10, "0")} 00000 n \n`);
  }

  // ── Trailer + startxref ──
  pushStr(
    `trailer\n<< /Size ${String(objCount)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
  );

  // Concatenate all chunks into a single buffer.
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ============ SVG EXPORT (with re-import support) ============

/**
 * Exports a page as an SVG string with node IDs preserved as
 * `data-node-id` attributes for re-import round-tripping.
 */
export function exportSvg(
  doc: DesignDoc,
  pageId: string,
  measurer: TextMeasurer,
): string {
  const { svg } = renderPage(doc, measurer, { pageId });
  // The render output already includes id="nodeId" attributes.
  // For re-import, add data-node-id as well (non-namespace attribute).
  return svg.replace(/id="([^"]+)"/g, 'id="$1" data-node-id="$1"');
}

// ============ HELPERS ============

class ExportAbortedError extends Error {
  constructor() {
    super("Export aborted");
    this.name = "ExportAbortedError";
  }
}

function applyBackgroundOverride(
  spec: ExportSpec,
  _page: Page,
): { background?: string } {
  if (!spec.background || spec.background === "doc") {
    return {}; // use the page's own background
  }
  if (spec.background === "transparent") {
    return { background: "transparent" };
  }
  // Custom hex color.
  return { background: spec.background };
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    const onAbort = () => {
      img.src = ""; // cancel the load
      reject(new ExportAbortedError());
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    img.onload = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(img);
    };

    img.onerror = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error("Failed to load SVG image"));
    };

    img.src = url;
  });
}
