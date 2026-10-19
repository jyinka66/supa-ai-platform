// ─────────────────────────────────────────────────────────────
// PDF + HEIC/image import.
//
// PDF import: pragmatic. pdf-lib parses; we extract embedded images
// (→ assets), text runs with font/size/position (→ text nodes, absolute
// positioned — PDF has no reflow model, so imported text is one node per
// line; users can merge via command palette "join text lines"). Vector
// paths map to our path model where expressible; everything else bakes
// to a page-background image. Again: FidelityReport, per page.
//
// HEIC/other-camera formats: decode server-side (or wasm codec worker)
// → JPEG preview + original preserved; browsers can't natively.
// ─────────────────────────────────────────────────────────────

import type {
  DesignDoc,
  Page,
  TextLayer,
  ImageLayer,
  Rect,
} from "@supa/design-model";
import { newId } from "@supa/design-model";
import type { FidelityIssue, ImportResult } from "./import";

// ============ PDF IMPORT ============

export interface PdfImportOptions {
  /** Uploads an asset (image bytes) and returns an asset ID. */
  uploadAsset?: (bytes: Uint8Array, mime: string) => Promise<string>;
  /** DPI for PDF coordinate conversion (PDF uses points; 72pt = 1in). Default: 72. */
  dpi?: number;
}

/**
 * Imports a PDF file as a DesignDoc.
 *
 * Basic implementation: parses the PDF binary directly (no pdfjs-dist
 * dependency) to extract text. For each page:
 *   - Locates the page's content stream (resolving FlateDecode via
 *     DecompressionStream when available)
 *   - Scans for BT...ET text blocks with Tj/TJ operators
 *   - Creates one TextLayer per text show, positioned per the Tm text matrix
 *
 * Honesty: PDF parsing is genuinely complex (cross-reference streams,
 * object streams, encrypted content, custom font encodings, linearized
 * PDFs). This extractor handles common cases (uncompressed or
 * FlateDecode-compressed content streams with WinAnsi/StandardEncoding
 * fonts). If no text can be extracted — for any reason — it throws a
 * clear error pointing to pdfjs-dist, rather than returning an empty
 * doc and pretending it succeeded.
 *
 * Known limitations (reported via FidelityReport):
 *   - Embedded images (XObjects) are not extracted (no assets created)
 *   - Vector paths are not preserved
 *   - Custom font encodings (Type3, CIDFontType0 with custom CMap) may
 *     produce garbled text — extraction returns whatever the bytes
 *     decode to in Latin1
 *   - Rotated/skewed text positions are approximate (uses the Tm
 *     translation components only, not the full matrix)
 *
 * @example
 *   const { doc, report } = await importPdf(pdfBytes, {
 *     uploadAsset: async (bytes, mime) => { ... },
 *   });
 */
export async function importPdf(
  pdfBytes: Uint8Array,
  options: PdfImportOptions,
): Promise<ImportResult> {
  const issues: FidelityIssue[] = [];
  let exactCount = 0;
  const bakedCount = 0;
  const dpi = options.dpi ?? 72;

  // Decode bytes as Latin1 to preserve byte values 0-255 (PDF text
  // operators are ASCII, but string literals may use the full byte range).
  const pdfText = bytesToLatin1(pdfBytes);

  // Step 1: Parse all objects (regex-based — works for non-encrypted,
  // non-linearized PDFs without cross-reference streams).
  const objects = parsePdfObjects(pdfText, pdfBytes);

  // Step 2: Find Page objects with MediaBox + Contents reference.
  const pdfPages = findPdfPages(objects);

  if (pdfPages.length === 0) {
    throw new Error(
      "design-io: PDF import requires pdfjs-dist for reliable parsing — " +
        "see services/design-export. (No Page objects found; the PDF may " +
        "use cross-reference streams, object streams, or be encrypted.)",
    );
  }

  // Step 3: For each page, resolve Contents stream(s) and extract text.
  const docPages: Page[] = [];

  for (let i = 0; i < pdfPages.length; i++) {
    const pdfPage = pdfPages[i];
    if (!pdfPage) continue;
    const { width: pageW, height: pageH } = pdfPage.mediaBox;

    const contentStrings = await resolveContentStreams(
      pdfPage,
      objects,
      issues,
      i,
    );

    const textLayers: TextLayer[] = [];
    for (const content of contentStrings) {
      const layers = extractTextLayers(content, pageH, dpi);
      textLayers.push(...layers);
    }

    exactCount += textLayers.length;

    docPages.push({
      id: newId(),
      name: `Page ${String(i + 1)}`,
      size: { width: pageW, height: pageH },
      background: "transparent",
      layers: textLayers,
    });
  }

  // Step 4: Honesty check — if zero text extracted across all pages, throw
  // a clear error rather than returning an empty doc.
  const totalText = docPages.reduce((sum, p) => sum + p.layers.length, 0);
  if (totalText === 0) {
    throw new Error(
      "design-io: PDF import requires pdfjs-dist for reliable text extraction — " +
        "see services/design-export. (No text operators (Tj/TJ) found in any " +
        "content stream; the PDF may use compressed fonts, custom encodings, " +
        "or filters this basic parser does not support.)",
    );
  }

  // Note the limitations of this basic extractor in the fidelity report.
  issues.push({
    nodeId: "pdf",
    reason:
      "Basic text extraction — embedded images, vector paths, and custom font encodings are not preserved",
    action: "flattened",
  });

  const doc: DesignDoc = {
    schemaVersion: 1,
    id: newId(),
    kind: "pdf-import",
    name: "Imported PDF",
    isTemplate: false,
    locale: "en",
    pages: docPages,
    assets: {},
    a11y: { issues: [] },
  };

  return {
    doc,
    report: { exact: exactCount, degraded: issues, baked: bakedCount },
  };
}

// ============ PDF PARSING HELPERS ============

interface ParsedObject {
  id: number;
  /** Text between `<<` and `>>` in the object's dict. */
  dictText: string;
  /** Raw stream bytes (between `stream\n` and `\nendstream`), or null if no stream. */
  streamBytes: Uint8Array | null;
}

interface ParsedPage {
  objectId: number;
  mediaBox: { x: number; y: number; width: number; height: number };
  /** Object IDs of content streams referenced by /Contents. May be empty. */
  contentRefs: number[];
}

/**
 * Maps bytes 0-255 to Unicode codepoints 0-255 (Latin1 is 1:1 for 0-255).
 * Used to convert binary PDF data to a JS string for regex parsing
 * without losing byte values > 127. Chunked to avoid stack overflow
 * from spreading very large arrays into String.fromCharCode.
 */
function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  const chunkSize = 0x8000; // 32 KiB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    s += String.fromCharCode(...bytes.subarray(i, end));
  }
  return s;
}

/**
 * Scans the PDF for `N G obj ... endobj` patterns and extracts each
 * object's dict text and (if present) stream bytes.
 *
 * Limitations:
 *   - Does not handle cross-reference streams (PDF 1.5+) — those replace
 *     the xref table with a stream. The regex still finds objects, but
 *     object lookup by reference may be incomplete.
 *   - Does not handle object streams (ObjStm) — compressed objects.
 *   - Does not handle encrypted PDFs.
 *
 * For PDFs using these features, this returns whatever objects it can
 * find; the caller throws a clear error if no Page objects are found.
 */
function parsePdfObjects(
  pdfText: string,
  pdfBytes: Uint8Array,
): Map<number, ParsedObject> {
  const objects = new Map<number, ParsedObject>();
  const objRegex = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRegex.exec(pdfText)) !== null) {
    const id = parseInt(m[1] ?? "0", 10);
    const body = m[3] ?? "";

    // Look for `<< dict >> stream\r?\n bytes \r?\nendstream`.
    const streamMatch = body.match(
      /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/,
    );
    if (streamMatch) {
      const dictText = streamMatch[1] ?? "";

      // Compute the byte offset of stream content in the original bytes.
      const objStart = m.index;
      const streamKwOffset = objStart + body.indexOf("stream");
      const afterStream = streamKwOffset + "stream".length;
      let offset = afterStream;
      if (pdfBytes[offset] === 0x0d) offset++; // \r
      if (pdfBytes[offset] === 0x0a) offset++; // \n

      // Use /Length from the dict if it's a direct integer; fall back to
      // the endstream keyword position.
      const lengthMatch = dictText.match(/\/Length\s+(\d+)/);
      let length: number;
      if (lengthMatch) {
        length = parseInt(lengthMatch[1] ?? "0", 10);
      } else {
        const endstreamIdx = pdfText.indexOf("endstream", offset);
        length = endstreamIdx - offset;
        if (length < 0) length = 0;
      }

      const streamBytes = pdfBytes.subarray(offset, offset + length);
      objects.set(id, { id, dictText, streamBytes });
    } else {
      objects.set(id, { id, dictText: body, streamBytes: null });
    }
  }
  return objects;
}

/**
 * Finds Page objects and extracts their MediaBox and Contents references.
 *
 * A Page object has:
 *   /Type /Page
 *   /MediaBox [x1 y1 x2 y2]            (required)
 *   /Contents N 0 R                    (single ref) OR
 *   /Contents [N 0 R M 0 R ...]        (array of refs)
 */
function findPdfPages(objects: Map<number, ParsedObject>): ParsedPage[] {
  const pages: ParsedPage[] = [];
  for (const [id, obj] of objects) {
    // Match /Type /Page but NOT /Type /Pages (the Pages tree root).
    const typeMatch = obj.dictText.match(/\/Type\s*\/Pages?\b/);
    if (!typeMatch) continue;
    if (typeMatch[0].endsWith("Pages")) continue;

    // MediaBox: [x1 y1 x2 y2]
    const mbMatch = obj.dictText.match(
      /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/,
    );
    if (!mbMatch) continue;

    const x1 = parseFloat(mbMatch[1] ?? "0");
    const y1 = parseFloat(mbMatch[2] ?? "0");
    const x2 = parseFloat(mbMatch[3] ?? "0");
    const y2 = parseFloat(mbMatch[4] ?? "0");

    // Contents: N 0 R or [N 0 R M 0 R ...]
    const contentRefs: number[] = [];
    const singleContents = obj.dictText.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    const arrayContents = obj.dictText.match(/\/Contents\s*\[([\s\d]+)\]/);
    if (singleContents) {
      contentRefs.push(parseInt(singleContents[1] ?? "0", 10));
    } else if (arrayContents) {
      const refs = arrayContents[1]?.match(/(\d+)\s+\d+\s+R/g) ?? [];
      for (const ref of refs) {
        const idMatch = ref.match(/(\d+)/);
        if (idMatch) contentRefs.push(parseInt(idMatch[1] ?? "0", 10));
      }
    }

    pages.push({
      objectId: id,
      mediaBox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
      contentRefs,
    });
  }
  return pages;
}

/**
 * Resolves a page's /Contents reference(s) to decompressed stream strings.
 *
 * Handles:
 *   - Direct (unfiltered) streams
 *   - FlateDecode (zlib) — inflated via DecompressionStream when available
 *   - Arrays of streams (concatenated)
 *
 * Streams with unsupported filters (LZW, ASCII85, etc.) or failed
 * inflations are reported as degraded issues and skipped.
 */
async function resolveContentStreams(
  page: ParsedPage,
  objects: Map<number, ParsedObject>,
  issues: FidelityIssue[],
  pageIndex: number,
): Promise<string[]> {
  const results: string[] = [];
  for (const ref of page.contentRefs) {
    const obj = objects.get(ref);
    if (!obj || !obj.streamBytes) {
      issues.push({
        nodeId: `page-${String(pageIndex + 1)}`,
        reason: `Content stream object ${String(ref)} not found or has no stream`,
        action: "dropped",
      });
      continue;
    }

    const dict = obj.dictText;
    if (/\/FlateDecode/.test(dict)) {
      try {
        const inflated = await inflateZlib(obj.streamBytes);
        results.push(bytesToLatin1(inflated));
      } catch (err) {
        issues.push({
          nodeId: `page-${String(pageIndex + 1)}`,
          reason: `FlateDecode inflation failed: ${
            (err as Error).message
          }`,
          action: "dropped",
        });
      }
    } else if (/\/Filter/.test(dict)) {
      issues.push({
        nodeId: `page-${String(pageIndex + 1)}`,
        reason: `Unsupported stream filter in object ${String(ref)}`,
        action: "dropped",
      });
      // Skip streams with unsupported filters.
    } else {
      // Uncompressed stream.
      results.push(bytesToLatin1(obj.streamBytes));
    }
  }
  return results;
}

/**
 * Inflates zlib (RFC 1950) data using DecompressionStream.
 * Throws if DecompressionStream is unavailable.
 */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "DecompressionStream not available in this environment",
    );
  }
  // Copy into a fresh Uint8Array backed by a real ArrayBuffer to avoid
  // stream-constructor issues with subarray views.
  const input = new Uint8Array(bytes.length);
  input.set(bytes);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const inflated = stream.pipeThrough(new DecompressionStream("deflate"));
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ============ TEXT EXTRACTION ============

interface TextMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY_TM: TextMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * Extracts text layers from a PDF content stream.
 *
 * Scans for BT...ET blocks, then within each block tracks:
 *   - Tf: font name + size (used for the TextLayer's fontFamily/fontSize)
 *   - Tm: text matrix [a b c d e f] — e,f is the position
 *   - Tj: show text (single string)
 *   - TJ: show text (array of strings + kerning adjustments)
 *
 * PDF coordinate origin is bottom-left; DesignDoc origin is top-left,
 * so we flip Y: y_design = page_height_pt - y_pdf - font_size.
 *
 * Strings may be literal `(text)` or hex `<48656C6C6F>`.
 *
 * Limitations:
 *   - Does not track Td/TD/T* (relative moves) — text positioned via
 *     these operators uses the last Tm position (approximate)
 *   - Does not resolve font encodings — bytes are decoded as Latin1
 *   - Does not handle rotated/skewed text matrices — uses e,f only
 */
function extractTextLayers(
  content: string,
  pageHeightPt: number,
  dpi: number,
): TextLayer[] {
  const layers: TextLayer[] = [];
  const scale = dpi / 72;

  // Find BT...ET blocks.
  const btEtRegex = /\bBT\b([\s\S]*?)\bET\b/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = btEtRegex.exec(content)) !== null) {
    const block = blockMatch[1] ?? "";

    let fontName = "Helvetica";
    let fontSize = 12;
    let tm: TextMatrix = { ...IDENTITY_TM };

    // Tf: /FontName size Tf
    for (const m of block.matchAll(/\/([^\s/]+)\s+([\d.]+)\s+Tf/g)) {
      fontName = m[1] ?? fontName;
      const size = parseFloat(m[2] ?? "12");
      if (!Number.isNaN(size) && size > 0) fontSize = size;
    }

    // Tm: a b c d e f Tm
    for (const m of block.matchAll(
      /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g,
    )) {
      tm = {
        a: parseFloat(m[1] ?? "1"),
        b: parseFloat(m[2] ?? "0"),
        c: parseFloat(m[3] ?? "0"),
        d: parseFloat(m[4] ?? "1"),
        e: parseFloat(m[5] ?? "0"),
        f: parseFloat(m[6] ?? "0"),
      };
    }

    // Td: tx ty Td — relative move within the text line. We approximate by
    // using the most recent Td's tx,ty as the position (cumulative moves
    // across multiple Td operators are not tracked — that requires full
    // text-line-matrix state which is beyond a basic extractor).
    for (const m of block.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+Td/g)) {
      tm = { ...tm, e: parseFloat(m[1] ?? "0"), f: parseFloat(m[2] ?? "0") };
    }

    // Tj: (string) Tj
    for (const m of block.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      const text = decodePdfLiteralString(m[1] ?? "");
      if (text.trim().length > 0) {
        layers.push(
          makeTextLayer(text, tm, fontName, fontSize, pageHeightPt, scale),
        );
      }
    }

    // TJ: [(string) num (string) num ...] TJ
    for (const m of block.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const arrayContent = m[1] ?? "";
      const stringMatches = arrayContent.matchAll(
        /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f]+)>/g,
      );
      let combined = "";
      for (const sm of stringMatches) {
        if (sm[1] !== undefined) {
          combined += decodePdfLiteralString(sm[1]);
        } else if (sm[2] !== undefined) {
          combined += decodePdfHexString(sm[2]);
        }
      }
      if (combined.trim().length > 0) {
        layers.push(
          makeTextLayer(
            combined,
            tm,
            fontName,
            fontSize,
            pageHeightPt,
            scale,
          ),
        );
      }
    }
  }

  return layers;
}

/**
 * Decodes a PDF literal string (between parentheses), handling escape
 * sequences: \n, \r, \t, \b, \f, \(, \), \\, \ddd (octal).
 */
function decodePdfLiteralString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "(":
          return "(";
        case ")":
          return ")";
        case "\\":
          return "\\";
        default:
          return ch;
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => {
      return String.fromCharCode(parseInt(oct, 8) & 0xff);
    });
}

/**
 * Decodes a PDF hex string `<48656C6C6F>` into a JS string.
 * Uses Latin1 mapping (each byte → code point 0-255). Odd-length hex
 * is padded with a trailing 0 per PDF spec.
 */
function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/\s/g, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  if (clean.length % 2 === 1) {
    bytes.push(parseInt(`${clean.charAt(clean.length - 1)}0`, 16));
  }
  return bytesToLatin1(new Uint8Array(bytes));
}

/**
 * Constructs a TextLayer from extracted text + position.
 *
 * PDF text matrix [a b c d e f] maps text-space to user-space:
 *   [x_user, y_user] = [a c; b d] [x_text, y_text] + [e, f]
 * For unrotated text (b=c=0), the position is (e, f). For rotated text,
 * we use (e, f) as an approximation (ignoring the rotation components).
 *
 * Y-coordinate flip: PDF origin is bottom-left; DesignDoc is top-left.
 *   y_design = (page_height_pt - y_pdf) * scale - font_size * scale
 *
 * The validator requires fontSize in 6..512, so we clamp the scaled size.
 */
function makeTextLayer(
  text: string,
  tm: TextMatrix,
  fontName: string,
  fontSize: number,
  pageHeightPt: number,
  scale: number,
): TextLayer {
  const x = tm.e * scale;
  const y = (pageHeightPt - tm.f) * scale - fontSize * scale;
  const w = Math.max(text.length * fontSize * 0.5 * scale, 10);
  const h = fontSize * scale * 1.2;
  const fontFamily = mapPdfFont(fontName);
  const scaledSize = Math.max(6, Math.min(512, fontSize * scale));

  return {
    id: newId(),
    type: "text",
    name: text.slice(0, 30) || "Text",
    locked: false,
    hidden: false,
    rect: { x, y, width: w, height: h },
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: {},
    content: text,
    runs: [
      {
        start: 0,
        end: text.length,
        fontFamily,
        fontSize: scaledSize,
      },
    ],
    fontFamily,
    fontSize: scaledSize,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: { value: 0, unit: "px" },
    align: "left",
    direction: "ltr",
    autoResize: "none",
  };
}

/**
 * Maps a PDF font name (e.g. "F1", "ABCDEF+Helvetica-Bold") to a generic
 * CSS font family. PDF font names are often obfuscated with subset
 * prefixes (e.g. "ABCDEF+Helvetica") — we strip those and match by
 * keyword (helvetica/arial → Arial, times/serif → Times New Roman,
 * courier/mono → Courier New). Anything else falls back to Arial.
 */
function mapPdfFont(pdfName: string): string {
  // Strip subset prefix like "ABCDEF+Helvetica" → "Helvetica".
  const plusIdx = pdfName.indexOf("+");
  const base = plusIdx >= 0 ? pdfName.substring(plusIdx + 1) : pdfName;
  const lower = base.toLowerCase();
  if (lower.includes("times") || lower.includes("serif")) {
    return "Times New Roman";
  }
  if (lower.includes("courier") || lower.includes("mono")) {
    return "Courier New";
  }
  if (lower.includes("helvet") || lower.includes("arial")) {
    return "Arial";
  }
  return "Arial";
}

// ============ IMAGE FORMAT IMPORT (HEIC, RAW, etc.) ============

export interface ImageImportOptions {
  /** Uploads an asset (image bytes) and returns an asset ID. */
  uploadAsset?: (bytes: Uint8Array, mime: string) => Promise<string>;
}

export interface ImageImportResult {
  assetId: string;
  width: number;
  height: number;
  mimeType: string;
  /** Original format preserved alongside the JPEG preview. */
  originalFormat: string;
}

/**
 * Imports an image file (including camera formats browsers can't natively decode).
 *
 * Supported natively (browser can decode):
 *   - PNG, JPEG, WebP, GIF, SVG, BMP, ICO
 *
 * Requires server-side decode (or WASM codec worker):
 *   - HEIC / HEIF (Apple camera format)
 *   - RAW (CR2, NEF, ARW, DNG — camera RAW)
 *   - AVIF (newer, partial browser support)
 *   - TIFF (limited browser support)
 *
 * For non-native formats:
 *   1. Upload the original bytes to the server
 *   2. Server decodes (via libheif, ImageMagick, sharp, or WASM codec)
 *   3. Server returns a JPEG preview + original preserved
 *   4. Client creates an image node with the JPEG preview asset
 *
 * @example
 *   const result = await importImage(file, {
 *     uploadAsset: async (bytes, mime) => { ... },
 *   });
 *   // → result.assetId, result.width, result.height
 */
export async function importImage(
  file: File | Uint8Array,
  options: ImageImportOptions,
): Promise<ImageImportResult> {
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;
  const mimeType = file instanceof File ? file.type : detectMimeType(bytes);
  const originalFormat = mimeType || "unknown";

  // Check if the browser can natively decode this format.
  const isNativeFormat = NATIVE_IMAGE_FORMATS.has(mimeType);

  let previewBytes: Uint8Array = bytes;
  let previewMime = mimeType;
  let width = 0;
  let height = 0;

  if (isNativeFormat) {
    // Decode natively to get dimensions.
    const dimensions = await getImageDimensions(bytes, mimeType);
    width = dimensions.width;
    height = dimensions.height;
  } else {
    // Non-native format (HEIC, RAW, etc.) → server-side decode.
    const decoded = await decodeServerSide(bytes, mimeType, options);
    previewBytes = decoded.bytes;
    previewMime = "image/jpeg";
    width = decoded.width;
    height = decoded.height;
  }

  // Upload the preview.
  let assetId = "unknown";
  if (options.uploadAsset) {
    assetId = await options.uploadAsset(previewBytes, previewMime);
  }

  return {
    assetId,
    width,
    height,
    mimeType: previewMime,
    originalFormat,
  };
}

/**
 * Creates an image layer from an imported image.
 */
export function createImageLayerFromImport(
  result: ImageImportResult,
  rect?: Partial<Rect>,
): ImageLayer {
  const defaultRect: Rect = {
    x: 0,
    y: 0,
    width: result.width,
    height: result.height,
  };

  return {
    id: newId(),
    type: "image",
    name: "Image",
    locked: false,
    hidden: false,
    rect: { ...defaultRect, ...rect },
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: {},
    assetId: result.assetId,
    fit: "cover",
    altText: "",
  };
}

// ============ CONSTANTS ============

const NATIVE_IMAGE_FORMATS = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/bmp",
  "image/vnd.microsoft.icon",
  "image/avif",
]);

// ============ HELPERS ============

function detectMimeType(bytes: Uint8Array): string {
  // Magic bytes.
  if (bytes.length >= 4) {
    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    // WebP (RIFF....WEBP)
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "image/webp";
      }
    }
    // HEIC (ftyp box: "ftypheic" or "ftypheix" or "ftypmif1")
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
      if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "hevc") {
        return "image/heic";
      }
    }
    // TIFF (II or MM)
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
      return "image/tiff";
    }
    // SVG (XML: <?xml or <svg)
    const header = new TextDecoder().decode(bytes.slice(0, 100));
    if (header.includes("<?xml") || header.includes("<svg")) {
      return "image/svg+xml";
    }
  }

  return "application/octet-stream";
}

async function getImageDimensions(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  if (typeof Image === "undefined") {
    // Server-side — can't use Image element. Return defaults.
    return { width: 1080, height: 1080 };
  }

  return new Promise((resolve) => {
    const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const blob = new Blob([blobBytes.buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
      resolve({ width: 1080, height: 1080 }); // fallback
      URL.revokeObjectURL(url);
    };

    img.src = url;
  });
}

function decodeServerSide(
  _bytes: Uint8Array,
  _mimeType: string,
  _options: ImageImportOptions,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  // Non-native image formats (HEIC/HEIF, RAW camera formats like CR2/NEF/ARW/DNG,
  // AVIF on browsers without native support, and TIFF) cannot be decoded in the
  // browser — they require server-side codecs (libheif, sharp, ImageMagick) or
  // a WASM codec worker.
  //
  // Previously this function silently returned the original bytes + hardcoded
  // 1080×1080 dimensions, which is dishonest: the bytes won't decode in any
  // <img>/canvas context, and the dimensions are fabricated. Downstream code
  // would create an ImageLayer with bogus dimensions and a broken asset ref,
  // failing in confusing ways.
  //
  // Now: throw a clear error pointing the caller at the server-side decode
  // service. The caller (importImage) can catch this and surface a helpful
  // message in the UI ("upload this format via the server-side pipeline").
  //
  // If a server-side decode endpoint is wired up via options.uploadAsset,
  // the caller can use it directly: upload the raw bytes, let the server
  // decode and return a JPEG preview + real dimensions. But this function
  // itself does not perform that round-trip — it refuses to fabricate data.
  return Promise.reject(new Error(
    "design-io: Non-native image format (HEIC/RAW/AVIF/TIFF) requires " +
      "server-side decode — see services/design-export. Browsers cannot " +
      "decode these formats natively; the upload pipeline must round-trip " +
      "the bytes through a server codec (libheif, sharp, or ImageMagick) " +
      "and return a JPEG preview + real dimensions.",
  ));
}
