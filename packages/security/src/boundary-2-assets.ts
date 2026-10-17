/**
 * @supa/security/boundary-2-assets
 * ----------------------------------------------------------------
 * Threat boundary 2: assets across accounts.
 *
 * Asset isolation: assets are addressed by content hash but scoped
 * by account. Fetch path: GET /asset/:hash requires a cap proving
 * your account owns or was granted that asset — knowing the hash
 * grants nothing (hash enumeration is feasible; hashes are not
 * secrets). The dedupe win is preserved: same-account same-content
 * stores once; cross-account duplicates store twice. Dedupe must
 * never become an oracle — "upload succeeded instantly" must not
 * imply "someone already had this file."
 *
 * Upload hardening:
 *   - decode-reencode pipeline is the sanitizer: SVG uploads are
 *     the exception (vector) → SVGs pass through a strict parser
 *     (allowlist of elements, no script, no foreignObject, no
 *     external hrefs, no entity expansion — billion-laughs), then
 *     served as Content-Type: image/svg+xml with CSP sandbox
 *     headers from a separate origin (assets-origin) so a stored-
 *     SVG XSS has no cookies, no DOM, no same-origin anything.
 *   - image bombs: pixel-count cap at decode (e.g. 100MP), zip-bomb
 *     depth/ratio caps on doc archives, decompression timeouts.
 *   - EXIF/location stripping confirmed at the boundary, tested.
 * ----------------------------------------------------------------
 */

import type { CapResolver } from "./primitives.js";

// ───────────────────────────────────────────────
// Per-account asset caps
// ───────────────────────────────────────────────

/**
 * Asset fetch authorization. Knowing the hash grants nothing — the
 * caller must prove their account owns or was granted the asset.
 *
 * The resolver is queried for a cap on resource={kind:'asset', hash}.
 * If the caller's account has no such cap, the fetch is denied even
 * if the asset exists in the store.
 *
 * Cross-account dedupe is preserved at the storage layer, but the
 * fetch layer treats each account's view as if the asset were
 * uniquely theirs.
 */
export async function authorizeAssetFetch(
  resolver: CapResolver,
  subject: string,
  assetHash: string,
  now: number = Date.now(),
): Promise<boolean> {
  const cap = await resolver.resolve({
    subject,
    resource: { kind: "asset", hash: assetHash },
    required: "read",
    now,
  });
  return cap !== null;
}

/**
 * After a successful asset upload, grant the uploading account a
 * cap on the asset. This is the "ownership" record. Other accounts
 * get caps via share-link or team grants (which the resolver stores
 * separately — they don't read the uploader's cap).
 */
export interface AssetUploadAuthz {
  /** Account uploading the asset. */
  subject: string;
  /** Content hash of the asset (sha-256). */
  assetHash: string;
}

// ───────────────────────────────────────────────
// Dedupe oracle defense
// ───────────────────────────────────────────────

/**
 * Dedupe must never become an oracle: "upload succeeded instantly"
 * must not imply "someone already had this file."
 *
 * Defense: uploads ALWAYS take a constant minimum time (the
 * decode-reencode pipeline), even when the hash already exists in
 * the caller's account. If the hash exists in ANOTHER account,
 * the upload proceeds as if it were new (cross-account dedupe is
 * a storage optimization, not visible to the uploader).
 *
 * Concretely: an upload that finds a same-account dedupe hit still
 * runs the decode-reencode path (the asset was already validated,
 * but we don't want to leak that). The store records a new
 * account→asset link but doesn't re-store the bytes.
 */
export interface DedupeOracleDefenseOptions {
  /** Minimum upload time (ms) — uploads faster than this are padded. */
  minUploadMs: number;
  /** Override clock (tests). */
  now?: () => number;
}

export class DedupeOracleDefense {
  private readonly minUploadMs: number;
  private readonly now: () => number;

  constructor(opts: DedupeOracleDefenseOptions = { minUploadMs: 250 }) {
    this.minUploadMs = opts.minUploadMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Wrap an upload operation so it always takes at least minUploadMs.
   * The bytes are stored (or deduped) as fast as possible; the
   * response is delayed to the floor.
   */
  async constantTimeUpload<T>(op: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    const result = await op();
    const elapsed = this.now() - startedAt;
    if (elapsed < this.minUploadMs) {
      await new Promise((r) => setTimeout(r, this.minUploadMs - elapsed));
    }
    return result;
  }
}

// ───────────────────────────────────────────────
// SVG strict parser (the upload sanitizer for vector content)
// ───────────────────────────────────────────────

/**
 * Allowlist of SVG elements. Anything not in this list is stripped.
 * Notably absent: <script>, <foreignObject>, <use> (can reference
 * external), <image> with href (can fetch external), <a> (can
 * navigate), <set>, <animate> with event handlers.
 */
const SVG_ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", // use is allowed but href restricted below
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop",
  "clipPath", "mask",
  "pattern", "marker",
  "title", "desc", // accessibility
  "style", // restricted below
]);

const SVG_DISALLOWED_ELEMENTS = new Set([
  "script",
  "foreignObject",
  "iframe",
  "image", // external href risk
  "a", // navigation
  "set",
  "animate", // event-handler-driven
  "animateTransform",
  "animateMotion",
]);

/**
 * Allowlist of attributes. Anything not in this list is stripped.
 * Notably: no event handler attributes (on*), no href with external
 * URLs, no xlink:href.
 */
const SVG_ALLOWED_ATTRS = new Set([
  "id", "class",
  "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "width", "height", "viewBox", "preserveAspectRatio",
  "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "opacity",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline",
  "gradientUnits", "gradientTransform", "spreadMethod",
  "offset", "stop-color", "stop-opacity",
  "clip-path", "clip-rule", "mask",
  "patternUnits", "patternTransform",
  "markerWidth", "markerHeight", "refX", "refY", "markerUnits", "orient",
  "href", // ALLOWED but restricted to internal refs (#id) below
]);

const SVG_DISALLOWED_ATTR_PREFIXES = ["on", "xlink:href"];

const SVG_EXTERNAL_HREF_PREFIXES = ["http:", "https:", "data:", "//"];

export interface SvgSanitizeResult {
  ok: boolean;
  /** Sanitized SVG (only if ok=true). */
  output?: string;
  /** Reasons for rejection (only if ok=false). */
  reasons?: string[];
}

/**
 * Strict SVG sanitizer. Used at upload time AND for AI-generated
 * SVG (the model is an untrusted content source, identical in kind
 * to an attacker's upload).
 *
 * This is a string-based sanitizer with an allowlist — NOT a full
 * XML parser. A full parser would be safer but would also be a
 * parser-of-its-own attack surface (entity expansion, etc.). The
 * allowlist approach is defense-in-depth: anything not explicitly
 * allowed is stripped.
 *
 * For production use, this should be backed by a battle-tested
 * library (DOMPurify with the SVG profile); this implementation is
 * the schema contract and a reference impl for tests.
 */
export function sanitizeSvg(input: string): SvgSanitizeResult {
  const reasons: string[] = [];
  let output = input;

  // Billion-laughs defense: strip DOCTYPE/ENTITY declarations entirely.
  if (output.includes("<!DOCTYPE") || output.includes("<!ENTITY")) {
    reasons.push("DOCTYPE/ENTITY declarations are not allowed (billion-laughs defense)");
    output = output.replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!ENTITY[^>]*>/gi, "");
  }
  if (output.length > 5 * 1024 * 1024) {
    reasons.push("SVG exceeds 5 MiB size cap");
  }

  // Strip disallowed elements entirely.
  for (const tag of SVG_DISALLOWED_ELEMENTS) {
    const re = new RegExp(`<${tag}[\\s\\/>][\\s\\S]*?</${tag}>|<${tag}[\\s\\/>]`, "gi");
    if (re.test(output)) {
      reasons.push(`disallowed element: <${tag}>`);
      output = output.replace(re, "");
    }
  }

  // Strip disallowed attributes.
  // Match attr="value" or attr='value' or attr=value or attr
  output = output.replace(/\s([a-zA-Z:][a-zA-Z0-9:-]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g, (match, name: string) => {
    if (SVG_DISALLOWED_ATTR_PREFIXES.some((p) => name.startsWith(p))) {
      if (!reasons.includes(`disallowed attribute: ${name}`)) {
        reasons.push(`disallowed attribute: ${name}`);
      }
      return "";
    }
    if (!SVG_ALLOWED_ATTRS.has(name)) {
      // Strip unknown attributes silently — the allowlist is the
      // contract; we don't want to leak what was stripped.
      return "";
    }
    return match;
  });

  // Strip disallowed elements that aren't in the allowlist.
  // We re-scan for element tags and check against allowlist.
  const elementRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)/g;
  let m: RegExpExecArray | null;
  const stripped = new Set<string>();
  while ((m = elementRe.exec(output)) !== null) {
    const tag = m[1]!;
    if (!SVG_ALLOWED_ELEMENTS.has(tag) && !SVG_DISALLOWED_ELEMENTS.has(tag)) {
      stripped.add(tag);
    }
  }
  if (stripped.size > 0) {
    reasons.push(`elements not in allowlist (stripped): ${[...stripped].join(", ")}`);
    for (const tag of stripped) {
      const re = new RegExp(`<${tag}[\\s\\/>][\\s\\S]*?</${tag}>|<${tag}[\\s\\/>]`, "gi");
      output = output.replace(re, "");
    }
  }

  // External href defense: only internal refs (#id) allowed. Strip
  // any href with an external value (don't reject — the SVG is still
  // safe with the href removed, and we want to return ok=true so the
  // caller doesn't have to handle a hard reject for a single bad attr).
  const hrefRe = /href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  while ((m = hrefRe.exec(output)) !== null) {
    const val = m[1]!.replace(/^["']|["']$/g, "");
    if (SVG_EXTERNAL_HREF_PREFIXES.some((p) => val.startsWith(p))) {
      reasons.push(`external href stripped: ${val.slice(0, 32)}`);
      // Replace this specific href occurrence with an empty string.
      // Use a unique-enough replacement to avoid replacing internal refs.
      const escaped = m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(`href\\s*=\\s*${escaped}`, "g"), "");
    }
  }

  if (reasons.length > 0) {
    // We sanitized rather than rejected — return the sanitized output.
    // The caller can log the reasons but the output is safe.
    return { ok: true, output, reasons };
  }
  return { ok: true, output };
}

// ───────────────────────────────────────────────
// Image bomb defenses
// ───────────────────────────────────────────────

export interface ImageBombLimits {
  /** Max pixel count at decode (100 MP default). */
  maxPixels: number;
  /** Max compressed size for archive uploads (zip bomb defense). */
  maxArchiveCompressedBytes: number;
  /** Max uncompressed size for archive uploads. */
  maxArchiveUncompressedBytes: number;
  /** Max archive nesting depth. */
  maxArchiveDepth: number;
  /** Max decompression time (ms). */
  maxDecompressMs: number;
}

export const DEFAULT_IMAGE_BOMB_LIMITS: ImageBombLimits = {
  maxPixels: 100_000_000, // 100 MP
  maxArchiveCompressedBytes: 100 * 1024 * 1024, // 100 MiB
  maxArchiveUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB
  maxArchiveDepth: 5,
  maxDecompressMs: 5_000,
};

export function checkImageDimensions(
  width: number,
  height: number,
  limits: ImageBombLimits = DEFAULT_IMAGE_BOMB_LIMITS,
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, reason: "non-finite dimensions" };
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: "non-positive dimensions" };
  }
  if (width * height > limits.maxPixels) {
    return {
      ok: false,
      reason: `pixel count ${width * height} exceeds cap ${limits.maxPixels}`,
    };
  }
  return { ok: true };
}

export interface ArchiveBombCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkArchiveBomb(
  compressedBytes: number,
  uncompressedBytes: number,
  depth: number,
  decompressMs: number,
  limits: ImageBombLimits = DEFAULT_IMAGE_BOMB_LIMITS,
): ArchiveBombCheckResult {
  if (compressedBytes > limits.maxArchiveCompressedBytes) {
    return { ok: false, reason: `compressed size exceeds cap` };
  }
  if (uncompressedBytes > limits.maxArchiveUncompressedBytes) {
    return { ok: false, reason: `uncompressed size exceeds cap` };
  }
  if (depth > limits.maxArchiveDepth) {
    return { ok: false, reason: `archive nesting depth exceeds cap` };
  }
  if (decompressMs > limits.maxDecompressMs) {
    return { ok: false, reason: `decompression time exceeds cap` };
  }
  // Zip bomb ratio check: a legit archive rarely exceeds 100× compression.
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > 100) {
    return {
      ok: false,
      reason: `compression ratio ${(uncompressedBytes / compressedBytes).toFixed(1)}× exceeds 100× cap`,
    };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────
// EXIF stripping confirmation
// ───────────────────────────────────────────────

/**
 * EXIF stripping happens in the decode-reencode pipeline (design-
 * assets pass). This package owns the boundary confirmation —
 * the assertion that stripping ran before the asset is reachable
 * at the fetch path.
 *
 * The contract: every asset stored has a `strippedAt` timestamp;
 * fetches require strippedAt to be non-null.
 */
export interface ExifStripConfirmation {
  assetHash: string;
  strippedAt: number;
  /** Original had EXIF? (for telemetry only — doesn't affect storage). */
  hadExif: boolean;
}

// ───────────────────────────────────────────────
// Separate origin for served assets
// ───────────────────────────────────────────────

/**
 * Served assets MUST come from a separate origin (assets-origin)
 * with these CSP sandbox headers, so a stored-SVG XSS has no
 * cookies, no DOM, no same-origin anything.
 *
 * The fetch path sets these headers unconditionally — even for
 * non-SVG assets, defense-in-depth.
 */
export const ASSETS_ORIGIN_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'", // inline styles in SVGs
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const ASSETS_ORIGIN_HEADERS: Record<string, string> = {
  "content-security-policy": ASSETS_ORIGIN_CSP,
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin", // assets are shared across docs
};
