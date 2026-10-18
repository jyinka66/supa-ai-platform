// ─────────────────────────────────────────────────────────────
// Text measurement — where editor/export parity lives or dies.
//
// Rules:
//   1. One cache, process-wide, keyed family|weight|size|text.
//   2. Measured in the same rasterizer that renders — client uses
//      Canvas 2D measureText; server export uses fontkit on the same
//      font binaries. Both go through this interface; the golden-render
//      harness asserts parity within 1px per line, CI-failing otherwise.
//   3. LRU cap 8,000 entries (a heavy session touches maybe 300; cap
//      is paranoia).
//   4. Line layout (wrapping, alignment, direction) is NOT done here —
//      shaping belongs to the renderer; measurement is the primitive
//      it consumes.
// ─────────────────────────────────────────────────────────────

/**
 * Text measurement interface — implemented by both client (Canvas) and
 * server (fontkit) to ensure editor ↔ export parity.
 *
 * The measure function returns the advance width (in pixels) of a text
 * string at the given font settings. This is the primitive consumed by
 * the renderer for line wrapping, text truncation, and auto-resize.
 *
 * @example
 *   const measurer = new CanvasMeasurer();
 *   const width = measurer.measure("Hello world", {
 *     family: "Inter",
 *     weight: 400,
 *     size: 16,
 *   });
 *   // width ≈ 78.5 (px at 1x)
 */
export interface TextMeasurer {
  measure(
    text: string,
    font: { family: string; weight: number; size: number },
  ): number;
}

// ============ LRU CACHE ============

/**
 * Simple LRU cache with a max entry count.
 * Uses a Map (which maintains insertion order in JS) for O(1) get/set.
 * On get, the entry is moved to the end (most recently used).
 * On set when full, the first entry (least recently used) is evicted.
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used).
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Evict the oldest (first) entry.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ============ FONT STACK HELPER ============

/**
 * Converts a font family name to a CSS font stack with fallbacks.
 * The primary family is loaded from the font registry; fallbacks ensure
 * the text is still measurable if the custom font hasn't loaded yet.
 */
function fontStack(family: string): string {
  const FALLBACKS: Record<string, string> = {
    Inter: '"Inter", system-ui, -apple-system, sans-serif',
    Roboto: '"Roboto", system-ui, sans-serif',
    "Noto Sans": '"Noto Sans", system-ui, sans-serif',
    "Noto Sans Arabic": '"Noto Sans Arabic", sans-serif',
    "Noto Sans JP": '"Noto Sans JP", sans-serif',
    "Noto Sans KR": '"Noto Sans KR", sans-serif',
    "Noto Sans SC": '"Noto Sans SC", sans-serif',
    "Noto Sans Devanagari": '"Noto Sans Devanagari", sans-serif',
  };

  return FALLBACKS[family] ?? `"${String(family)}", system-ui, sans-serif`;
}

// ============ CANVAS MEASURER (client) ============

/**
 * Client-side text measurer using Canvas 2D `measureText`.
 *
 * Uses `OffscreenCanvas` (available in all modern browsers + Node 18+)
 * to avoid DOM dependency. The canvas is 0×0 — we only need the context
 * for `measureText`, not for rendering.
 *
 * The LRU cache (8,000 entries) prevents re-measuring the same string
 * on every frame. A typical design doc has ~300 unique text strings;
 * 8,000 is paranoia for very large docs.
 *
 * @example
 *   const measurer = new CanvasMeasurer();
 *   const width = measurer.measure("Hello", { family: "Inter", weight: 400, size: 16 });
 */
export class CanvasMeasurer implements TextMeasurer {
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private cache = new LRUCache<string, number>(8000);

  constructor() {
    // OffscreenCanvas is available in modern browsers + Node 18+.
    // Fall back to a regular canvas if OffscreenCanvas is unavailable.
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(0, 0);
      const context = canvas.getContext("2d");
      if (context) this.ctx = context;
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 0;
      canvas.height = 0;
      const context = canvas.getContext("2d");
      if (context) this.ctx = context;
    } else {
      // SSR / Node without canvas — returns 0 for all measurements.
      // The server should use ServerMeasurer (fontkit) instead.
      this.ctx = null;
    }
  }

  measure(
    text: string,
    f: { family: string; weight: number; size: number },
  ): number {
    const key = `${String(f.family)}|${String(f.weight)}|${String(f.size)}|${String(text)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    if (!this.ctx) {
      // No canvas context — return an estimate (avg char width * length).
      // This is a fallback; the golden-render harness will catch parity issues.
      const estimate = text.length * f.size * 0.5;
      this.cache.set(key, estimate);
      return estimate;
    }

    this.ctx.font = `${String(f.weight)} ${String(f.size)}px ${String(fontStack(f.family))}`;
    const m = this.ctx.measureText(text).width;
    this.cache.set(key, m);
    return m;
  }
}

// ============ SERVER MEASURER (fontkit) ============

/**
 * A loaded font binary — the shape `ServerMeasurer` consumes.
 * `layout(text)` returns the advance width for the given string
 * (already shaped + advanced). `unitsPerEm` is the font's design
 * unit grid (typically 1000 or 2048) used to convert to pixel size.
 */
export interface LoadedFont {
  layout: (text: string) => { advanceWidth: number };
  unitsPerEm: number;
}

/**
 * Font registry — knows how to produce a `LoadedFont` for a
 * (family, weight) pair. Implemented by `ConsoleFontRegistry`
 * (file-system-backed, fontkit when available) and by any custom
 * registry the host wants to wire in (e.g., CDN-backed).
 */
export interface FontRegistry {
  load: (family: string, weight: number) => LoadedFont;
}

/**
 * Server-side text measurer using a `FontRegistry` (typically
 * `ConsoleFontRegistry`).
 *
 * Loads font binaries from the same registry the CDN serves, ensuring
 * the server measures with the EXACT same glyphs the browser renders.
 *
 * Per-glyph advance sum via `font.layout(text)` gives correct shaping
 * advances for Arabic/Indic, matching browser output (both consume
 * HarfBuzz-shaped results for these scripts).
 *
 * @example
 *   const measurer = new ServerMeasurer(new ConsoleFontRegistry());
 *   const width = measurer.measure("Hello", { family: "Inter", weight: 400, size: 16 });
 */
export class ServerMeasurer implements TextMeasurer {
  private cache = new LRUCache<string, number>(8000);

  constructor(private fontRegistry?: FontRegistry) {}

  measure(
    text: string,
    f: { family: string; weight: number; size: number },
  ): number {
    const key = `${String(f.family)}|${String(f.weight)}|${String(f.size)}|${String(text)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    if (!this.fontRegistry) {
      // No font registry — return estimate (will fail golden-render parity).
      const estimate = text.length * f.size * 0.5;
      this.cache.set(key, estimate);
      return estimate;
    }

    const font = this.fontRegistry.load(f.family, f.weight);
    const layout = font.layout(text);
    const width = (layout.advanceWidth / font.unitsPerEm) * f.size;

    this.cache.set(key, width);
    return width;
  }
}

// ============ CONSOLE FONT REGISTRY (file-system + fontkit) ============

/**
 * Lazy-require a Node-only CommonJS module without TypeScript needing
 * `@types/node` in this React-library tsconfig. The cast-via-unknown
 * + the runtime check lets us call `require` only when it actually
 * exists (Node); in browsers / bundlers the helper returns
 * `undefined`, and the ConsoleFontRegistry degrades to the estimate
 * path with a clear `console.warn`.
 */
const nodeRequire: ((mod: string) => unknown) | undefined =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as unknown as { require?: unknown }).require === "function"
    ? (globalThis as unknown as { require: (mod: string) => unknown }).require
    : undefined;

/**
 * Minimal type shim for the `node:fs` methods we use. Declared
 * locally (instead of importing `@types/node`) so the React-library
 * tsconfig doesn't need a node-types dep — the ConsoleFontRegistry
 * is only reached in Node, where the real `node:fs` matches this
 * interface exactly.
 */
interface NodeFsShim {
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
  readFileSync(path: string): Uint8Array;
}

/** Minimal type shim for the `node:path` methods we use. */
interface NodePathShim {
  join(...paths: string[]): string;
}

/** Minimal type shim for the `fontkit` API surface we use. */
interface FontkitShim {
  create(buf: Uint8Array): {
    layout: (text: string) => { advanceWidth: number };
    unitsPerEm: number;
  };
}

/**
 * Default font search paths, ordered by platform priority:
 *   - /usr/share/fonts (Linux — Debian/Ubuntu/Fedora/Arch)
 *   - /usr/local/share/fonts (Linux — manually installed)
 *   - /Library/Fonts (macOS — user-installed)
 *   - /System/Library/Fonts (macOS — system fonts)
 *   - C:\Windows\Fonts (Windows)
 *
 * Missing paths are skipped silently — the warning fires per
 * (family, weight) when no matching font file is found in any path.
 */
export const DEFAULT_FONT_SEARCH_PATHS: readonly string[] = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/Library/Fonts",
  "/System/Library/Fonts",
  "C:\\Windows\\Fonts",
];

/**
 * File-system-backed font registry. Scans standard font directories
 * for font files matching the requested family + weight, and parses
 * them via `fontkit` (when installed) for accurate glyph advances.
 *
 * When `fontkit` isn't installed or no matching font file is found,
 * the registry logs a clear `console.warn` and falls back to a
 * heuristic per-character advance estimate. The estimate will fail
 * editor↔export parity in the golden-render harness, but it keeps
 * callers (CI containers without fonts installed, fresh dev boxes)
 * from crashing — measurement still returns a real number.
 *
 * Designed to be passed to `new ServerMeasurer(new ConsoleFontRegistry())`.
 *
 * @example
 *   const measurer = new ServerMeasurer(new ConsoleFontRegistry());
 *   // First load scans /usr/share/fonts/ for "Inter" 400 — if
 *   // found and fontkit is installed, subsequent measures use the
 *   // real glyph advances. Otherwise a console.warn fires once.
 */
export class ConsoleFontRegistry implements FontRegistry {
  private readonly searchPaths: readonly string[];
  private readonly fonts = new Map<string, LoadedFont>();
  private readonly warnedKeys = new Set<string>();
  private scannedFiles: string[] | null = null;

  constructor(searchPaths?: readonly string[]) {
    this.searchPaths = searchPaths ?? DEFAULT_FONT_SEARCH_PATHS;
  }

  load(family: string, weight: number): LoadedFont {
    const key = `${String(family.toLowerCase())}|${String(weight)}`;
    const cached = this.fonts.get(key);
    if (cached) return cached;

    const file = this.findFontFile(family, weight);
    if (!file) {
      this.warnOnce(
        family,
        weight,
        `no font file matching "${String(family)}" weight ${String(weight)} found in [${String(this.searchPaths.join(", "))}]`,
      );
      const est = this.estimateFont();
      this.fonts.set(key, est);
      return est;
    }

    const font = this.tryLoadWithFontkit(file);
    if (!font) {
      this.warnOnce(
        family,
        weight,
        `fontkit unavailable or failed to parse ${String(file)} — install the "fontkit" package for accurate measurement`,
      );
      const est = this.estimateFont();
      this.fonts.set(key, est);
      return est;
    }
    this.fonts.set(key, font);
    return font;
  }

  /** Scan a font directory tree for .ttf/.otf/.ttc/.woff files. */
  private findFontFile(family: string, weight: number): string | null {
    const files = this.scanFonts();
    if (files.length === 0) return null;
    const famLower = family.toLowerCase().replace(/\s+/g, "");
    // Loose match — the file path contains the family name (ignoring
    // whitespace and case). Real-world fonts live at paths like
    // /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf.
    const matches = files.filter((f) => {
      const base = f.toLowerCase().replace(/\s+/g, "");
      return base.includes(famLower);
    });
    if (matches.length === 0) return null;
    // Prefer a file with the requested weight token in its name
    // (e.g. "Inter-Bold.ttf" for weight 700, "Inter-Regular.ttf" for 400).
    const weightStr = String(weight);
    const exactWeight = matches.find((f) => {
      const lower = f.toLowerCase();
      return (
        lower.includes(`-${String(weightStr)}.`) ||
        lower.includes(`-${String(weightStr)}-`) ||
        lower.includes(`-${String(weightStr)}_`) ||
        // Map common weight names → numbers for the loose match.
        (weight === 400 && /-regular[-.]/i.test(f)) ||
        (weight === 700 && /-bold[-.]/i.test(f)) ||
        (weight === 500 && /-medium[-.]/i.test(f)) ||
        (weight === 600 && /-semibold[-.]/i.test(f)) ||
        (weight === 300 && /-light[-.]/i.test(f))
      );
    });
    if (exactWeight) return exactWeight;
    return matches[0] ?? null;
  }

  /** Synchronous recursive walk of the font search paths. */
  private scanFonts(): readonly string[] {
    if (this.scannedFiles) return this.scannedFiles;
    const files: string[] = [];
    for (const root of this.searchPaths) {
      try {
        this.walkSync(root, files);
      } catch {
        // Path missing or unreadable — skip silently. The warning
        // fires later per-(family, weight) when no match is found.
      }
    }
    this.scannedFiles = files;
    return files;
  }

  private walkSync(dir: string, out: string[]): void {
    // Lazy-require node:fs so this module is importable in browsers
    // (the require call is only reached when something actually
    // calls load(), which only happens server-side). We use the
    // Function constructor to dodge the React-library tsconfig —
    // this package doesn't ship with @types/node as a hard dep,
    // and adding it would risk DOM↔node type conflicts elsewhere.
    if (!nodeRequire) return;
    const fs = nodeRequire("node:fs") as NodeFsShim | undefined;
    const path = nodeRequire("node:path") as NodePathShim | undefined;
    if (!fs || !path) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st: ReturnType<typeof fs.statSync>;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        this.walkSync(full, out);
      } else if (/\.(ttf|otf|ttc|woff2?)$/i.test(name)) {
        out.push(full);
      }
    }
  }

  /**
   * Try to parse a font file with `fontkit`. Returns null if fontkit
   * isn't installed or the file can't be parsed — callers fall back
   * to the estimate.
   */
  private tryLoadWithFontkit(file: string): LoadedFont | null {
    try {
      if (!nodeRequire) return null;
      // fontkit isn't a declared dependency — dynamic require so the
      // module loads fine without it. When the host has installed
      // fontkit, we get accurate glyph shaping for free.
      const fontkit = nodeRequire("fontkit") as FontkitShim | undefined;
      if (!fontkit) return null;
      const fs = nodeRequire("node:fs") as NodeFsShim | undefined;
      if (!fs) return null;
      const buf = fs.readFileSync(file);
      const font = fontkit.create(buf);
      return {
        layout: (text: string) => font.layout(text),
        unitsPerEm: font.unitsPerEm,
      };
    } catch {
      return null;
    }
  }

  /**
   * Heuristic estimate font — 0.5em advance per character, in font
   * units (1000 unitsPerEm). This is the same estimate the
   * fontless `ServerMeasurer` would produce, but expressed as a
   * `LoadedFont` so the rest of the pipeline doesn't need a special
   * case.
   */
  private estimateFont(): LoadedFont {
    return {
      layout: (text: string) => ({
        advanceWidth: text.length * 500, // 0.5em per char in font units
      }),
      unitsPerEm: 1000,
    };
  }

  /**
   * Warn once per (family, weight, reason) tuple — repeat warnings
   * would flood the console in a hot loop (each measure call hits
   * `load`). The first warning per cause is enough.
   */
  private warnOnce(family: string, weight: number, reason: string): void {
    const key = `${String(family)}|${String(weight)}|${String(reason)}`;
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    // eslint-disable-next-line no-console
    console.warn(
      `[design-render] ConsoleFontRegistry: ${String(reason)}. ` +
        `Falling back to a per-character advance estimate for "${String(family)}" weight ${String(weight)}. ` +
        `Editor↔export parity will be impaired until the font is installed.`,
    );
  }
}

// ============ NOOP MEASURER (for tests) ============

/**
 * No-op measurer for tests — returns a fixed advance per character.
 * Useful for unit tests that don't need real measurement.
 */
export class NoopMeasurer implements TextMeasurer {
  constructor(private charWidth = 8) {}

  measure(
    text: string,
    _f: { family: string; weight: number; size: number },
  ): number {
    return text.length * this.charWidth;
  }
}
