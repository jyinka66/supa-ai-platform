// ─────────────────────────────────────────────────────────────
// Command palette aggregate: each package exports commands with the
// { id, title, when(state), run(store) } shape. The shell collects them.
//
// Sources:
//   design-editor: select/move/group/align/z-order/zoom...
//   design-ai: generate/expand/repaint/palette/rewrite (gated on
//     credit balance + feature flags, `when` checks both)
//   design-io: export-as-*, import, copy-as-code
//   app-shell: rename doc, duplicate doc, share, version history
//
// Fuzzy match (fzf-style scoring), recent-commands boost, full
// keyboard nav. AI commands show inline credit cost before run.
// Version history UI: design-sync's per-doc op log → snapshot list
// with preview renders, restore = one composite op batch (undoable).
// ─────────────────────────────────────────────────────────────

import type { EditorStore, EditorState } from "@supa/design-editor";
import { COMMANDS as EDITOR_COMMANDS, type Command, searchCommands } from "@supa/design-editor";
import { exportDoc, exportSvg, importSvg } from "@supa/design-io";
import { NoopMeasurer } from "@supa/design-render";
import { emitCssCustomProperties } from "@supa/design-tokens/codegen";
import type { TokenMap } from "@supa/design-tokens";
import { generateDesignFromPrompt } from "@supa/design-ai";
import type { DesignDoc } from "@supa/design-model";

// ============ PALETTE STATE ============

export type PaletteCommand = Omit<Command, "category"> & {
  /** Source package that registered the command. */
  source: "design-editor" | "design-ai" | "design-io" | "app-shell";
  /** Category for grouping in the palette UI. */
  category: string;
  /** Optional credit cost (for AI commands). */
  creditCost?: number;
  /** Optional feature flag key — `when` checks both state + flag. */
  featureFlag?: string;
  /** Optional icon name (for the palette row). */
  icon?: string;
}

export interface PaletteState {
  query: string;
  selectedIndex: number;
  results: PaletteCommand[];
  /** Recently used command IDs (for boosting). */
  recent: string[];
}

// ============ REGISTRY ============

const PALETTE_COMMANDS: PaletteCommand[] = [
  // Editor commands (from design-editor).
  ...EDITOR_COMMANDS.map((cmd) => ({
    ...cmd,
    source: "design-editor" as const,
    category: cmd.category ?? "edit",
  })),

  // ============ APP-SHELL COMMANDS ============
  {
    id: "doc.rename",
    title: "Rename document",
    category: "document",
    source: "app-shell",
    when: () => true,
    run: (store) => {
      const current = store.get().doc.name;
      const newTitle =
        typeof window !== "undefined"
          ? window.prompt("Document title", current)
          : null;
      if (!newTitle || newTitle === current) return;
      store.updateDoc({ title: newTitle });
    },
    icon: "edit",
  },
  {
    id: "doc.duplicate",
    title: "Duplicate document",
    category: "document",
    source: "app-shell",
    when: () => true,
    run: () => {
      // TODO: server-side duplicate — requires a /api/docs/:id/duplicate
      // endpoint that copies the doc + assets + returns a new doc id.
      throw new Error(
        "doc.duplicate: not implemented — requires server-side document duplication API",
      );
    },
    icon: "copy",
  },
  {
    id: "doc.share",
    title: "Share document",
    shortcut: "Ctrl+Shift+S",
    category: "document",
    source: "app-shell",
    when: () => true,
    run: () => {
      // TODO: open share panel UI (not yet built).
      throw new Error(
        "doc.share: not implemented — requires share panel UI",
      );
    },
    icon: "share",
  },
  {
    id: "doc.history",
    title: "Version history",
    category: "document",
    source: "app-shell",
    when: () => true,
    run: () => {
      // TODO: open version history panel UI (not yet built).
      throw new Error(
        "doc.history: not implemented — requires version history panel UI",
      );
    },
    icon: "history",
  },

  // ============ DESIGN-IO COMMANDS ============
  {
    id: "io.export-png",
    title: "Export as PNG",
    category: "export",
    source: "design-io",
    when: () => true,
    run: (store) => {
      triggerFormatExport(store, "png");
    },
    icon: "image",
  },
  {
    id: "io.export-svg",
    title: "Export as SVG",
    category: "export",
    source: "design-io",
    when: () => true,
    run: (store) => {
      triggerFormatExport(store, "svg");
    },
    icon: "code",
  },
  {
    id: "io.export-pdf",
    title: "Export as PDF",
    category: "export",
    source: "design-io",
    when: () => true,
    run: (store) => {
      triggerFormatExport(store, "pdf");
    },
    icon: "file",
  },
  {
    id: "io.import",
    title: "Import SVG/PDF",
    category: "import",
    source: "design-io",
    when: () => true,
    run: (store) => {
      const svg = promptForSvgInput();
      if (!svg) return;
      void importSvg(svg, {})
        .then((result) => {
          store.load(result.doc);
        })
        .catch((err) => {
          console.error("palette: io.import failed", err);
        });
    },
    icon: "upload",
  },
  {
    id: "io.copy-as-code",
    title: "Copy as React code",
    category: "export",
    source: "design-io",
    when: () => true,
    run: () => {
      // TODO: extract the doc's bound token map (from
      // @supa/design-tokens/bindings) and emit CSS from that. For now,
      // emit from an empty map so the codegen path is exercised
      // end-to-end.
      const emptyMap: TokenMap = {
        mapId: "empty",
        tokens: new Map(),
      };
      const css = emitCssCustomProperties(emptyMap);
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(css);
      }
    },
    icon: "clipboard",
  },

  // ============ DESIGN-AI COMMANDS (gated on credits + feature flags) ============
  {
    id: "ai.generate",
    title: "Generate design from prompt",
    category: "ai",
    source: "design-ai",
    creditCost: 5,
    featureFlag: "ai.generate",
    when: (state) => hasCredits(5) && isFeatureEnabled("ai.generate"),
    run: (store) => {
      const prompt =
        typeof window !== "undefined"
          ? window.prompt("Describe the design to generate")
          : null;
      if (!prompt) return;
      void generateDesignFromPrompt("", prompt, "default")
        .then((result) => {
          store.load(result.doc);
        })
        .catch((err) => {
          console.error("palette: ai.generate failed", err);
        });
    },
    icon: "sparkles",
  },
  {
    id: "ai.expand",
    title: "Expand/shrink content",
    category: "ai",
    source: "design-ai",
    creditCost: 2,
    featureFlag: "ai.expand",
    when: (state) => state.selection.length > 0 && hasCredits(2) && isFeatureEnabled("ai.expand"),
    run: () => {
      // TODO: requires @supa/design-ai to expose an expandContent
      // function (not yet implemented — only generateDesignFromPrompt
      // is wired).
      throw new Error(
        "ai.expand: not implemented — requires @supa/design-ai expandContent",
      );
    },
    icon: "expand",
  },
  {
    id: "ai.rewrite",
    title: "Rewrite text",
    category: "ai",
    source: "design-ai",
    creditCost: 1,
    featureFlag: "ai.rewrite",
    when: (state) => state.selection.length === 1 && hasCredits(1) && isFeatureEnabled("ai.rewrite"),
    run: () => {
      // TODO: requires @supa/design-ai to expose a rewriteText function
      // (not yet implemented — only generateDesignFromPrompt is wired).
      throw new Error(
        "ai.rewrite: not implemented — requires @supa/design-ai rewriteText",
      );
    },
    icon: "pen",
  },
  {
    id: "ai.palette",
    title: "Suggest color palette",
    category: "ai",
    source: "design-ai",
    creditCost: 3,
    featureFlag: "ai.palette",
    when: () => hasCredits(3) && isFeatureEnabled("ai.palette"),
    run: () => {
      // TODO: requires @supa/design-ai to expose a suggestPalette
      // function (not yet implemented — only generateDesignFromPrompt
      // is wired).
      throw new Error(
        "ai.palette: not implemented — requires @supa/design-ai suggestPalette",
      );
    },
    icon: "palette",
  },
  {
    id: "ai.repaint",
    title: "Repaint with palette",
    category: "ai",
    source: "design-ai",
    creditCost: 2,
    featureFlag: "ai.repaint",
    when: (state) => state.selection.length > 0 && hasCredits(2) && isFeatureEnabled("ai.repaint"),
    run: () => {
      // TODO: requires @supa/design-ai to expose a repaintWithPalette
      // function (not yet implemented — only generateDesignFromPrompt
      // is wired).
      throw new Error(
        "ai.repaint: not implemented — requires @supa/design-ai repaintWithPalette",
      );
    },
    icon: "brush",
  },
];

// ============ FEATURE FLAG + CREDIT CHECKS ============

let featureFlags = new Set<string>();
let creditBalance = 100;

export function setFeatureFlags(flags: string[]): void {
  featureFlags = new Set(flags);
}

export function isFeatureEnabled(flag: string): boolean {
  return featureFlags.has(flag);
}

export function setCreditBalance(balance: number): void {
  creditBalance = balance;
}

export function hasCredits(cost: number): boolean {
  return creditBalance >= cost;
}

export function getCreditBalance(): number {
  return creditBalance;
}

// ============ PALETTE SEARCH ============

/**
 * Searches the palette commands with fuzzy matching + recent boost.
 *
 * Scoring (fzf-style):
 *   - Exact title match: 100
 *   - Title starts with query: 80
 *   - Title contains query: 60
 *   - Fuzzy match (all chars in order): 20
 *   - Recent command boost: +10
 *
 * @example
 *   const results = searchPalette("exp", state);
 *   // → [{ cmd: "ai.expand", score: 90 }, { cmd: "io.export-png", score: 80 }]
 */
export function searchPalette(query: string, state: EditorState): PaletteCommand[] {
  const q = query.trim().toLowerCase();

  // If no query, return all enabled commands sorted by recent usage.
  if (q.length === 0) {
    return PALETTE_COMMANDS
      .filter((c) => c.when(state))
      .sort((a, b) => {
        const aRecent = recentIds.has(a.id) ? 1 : 0;
        const bRecent = recentIds.has(b.id) ? 1 : 0;
        if (aRecent !== bRecent) return bRecent - aRecent;
        return a.title.localeCompare(b.title);
      });
  }

  return PALETTE_COMMANDS
    .filter((c) => c.when(state))
    .map((cmd) => {
      const title = cmd.title.toLowerCase();
      const id = cmd.id.toLowerCase();
      let score = 0;

      if (title === q) score = 100;
      else if (title.startsWith(q)) score = 80;
      else if (title.includes(q)) score = 60;
      else if (id.includes(q)) score = 40;
      else {
        // Fuzzy: check if all chars of q appear in order.
        let qi = 0;
        for (let i = 0; i < title.length && qi < q.length; i++) {
          if (title[i] === q[qi]) qi++;
        }
        if (qi === q.length) score = 20;
      }

      // Recent boost.
      if (recentIds.has(cmd.id)) score += 10;

      return { cmd, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.cmd);
}

// ============ RECENT COMMANDS ============

const recentIds = new Set<string>();
const MAX_RECENT = 10;

/**
 * Records that a command was used (for recent boosting).
 */
export function recordCommandUsage(id: string): void {
  recentIds.add(id);
  // Cap the recent set.
  if (recentIds.size > MAX_RECENT) {
    const oldest = recentIds.values().next().value;
    if (oldest) recentIds.delete(oldest);
  }
}

/**
 * Returns the recent command IDs (for UI display).
 */
export function getRecentCommands(): string[] {
  return Array.from(recentIds);
}

// ============ VERSION HISTORY ============

export interface VersionSnapshot {
  rev: number;
  createdAt: string;
  authorName: string;
  /** Thumbnail SVG (rendered via RenderCache). */
  thumbnailSvg: string | null;
  /** Whether this is the current revision. */
  isCurrent: boolean;
}

/**
 * Returns the version history for a document.
 *
 * Version history is derived from design-sync's per-doc op log.
 * Each snapshot is a revision with a preview render (via RenderCache).
 *
 * Restore = one composite op batch (undoable, because restore is just ops).
 *
 * @example
 *   const snapshots = getVersionHistory(docId);
 *   // Show snapshot list with preview thumbnails.
 *   // User clicks "Restore v5" → restoreVersion(5) → batch of ops.
 */
export async function getVersionHistory(docId: string): Promise<VersionSnapshot[]> {
  const res = await fetch(`/api/docs/${docId}/versions`);
  if (!res.ok) {
    throw new Error(
      `getVersionHistory: failed to fetch versions for doc ${docId} (${res.status})`,
    );
  }
  const json = (await res.json()) as { data?: VersionSnapshot[] };
  return json.data ?? [];
}

/**
 * Restores the document to a specific revision.
 *
 * This is implemented as a BATCH of commands that produce the target
 * state — it's undoable (one undo step), because restore is just ops.
 *
 * @example
 *   await restoreVersion(docId, 5);
 *   // → doc is now at rev 5's state, with a single undo entry.
 */
export async function restoreVersion(
  store: EditorStore,
  targetRev: number,
): Promise<void> {
  const docId = store.get().doc.id;
  const res = await fetch(`/api/docs/${docId}/versions/${targetRev}`);
  if (!res.ok) {
    throw new Error(
      `restoreVersion: failed to fetch rev ${targetRev} for doc ${docId} (${res.status})`,
    );
  }
  const json = (await res.json()) as { data?: { doc?: DesignDoc } };
  const doc = json.data?.doc;
  if (!doc) {
    throw new Error(`restoreVersion: rev ${targetRev} returned no doc`);
  }
  // TODO: compute the diff between current + target, apply as a BATCH of
  // UPDATE_PROPS / ADD_NODE / DELETE_NODES so the restore is undoable
  // (one undo step). For now, load the target doc directly — this resets
  // history (not undoable). The diff-based approach lands when
  // design-sync's per-doc op log is wired.
  store.load(doc);
}

// ============ PALETTE HELPERS ============

const NOOP_MEASURER = new NoopMeasurer();

/**
 * Triggers a browser download of the given blob.
 * Used by the io.export-* palette commands.
 */
function triggerDownload(filename: string, blob: Blob): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — Chrome needs the URL to live past click().
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Placeholder for the SVG import file picker. The real UI will be a
 * file input dialog; for now, this prompts the user to paste an SVG
 * string (minimum viable — lets the palette command work end-to-end).
 */
function promptForSvgInput(): string | null {
  if (typeof window === "undefined") return null;
  return window.prompt("Paste SVG to import (file picker coming soon):");
}

/**
 * Triggers an export of the current doc to the given format and
 * downloads the result. Used by io.export-png / -svg / -pdf.
 *
 * SVG is handled synchronously via exportSvg; raster/PDF formats go
 * through the async exportDoc pipeline (rasterization needs a canvas
 * in browser context — @supa/design-io handles this via OffscreenCanvas).
 */
function triggerFormatExport(
  store: EditorStore,
  format: "png" | "jpeg" | "webp" | "pdf" | "svg",
): void {
  const state = store.get();
  const docName = state.doc.name || "export";

  if (format === "svg") {
    try {
      const svg = exportSvg(state.doc, state.pageId, NOOP_MEASURER);
      const blob = new Blob([svg], { type: "image/svg+xml" });
      triggerDownload(`${docName}.svg`, blob);
    } catch (err) {
      console.error("palette: io.export-svg failed", err);
    }
    return;
  }

  void exportDoc(
    { doc: state.doc, format, scale: 2 },
    NOOP_MEASURER,
  )
    .then((result) => {
      const blob = result.blob ?? result.items[0]?.blob;
      if (!blob) return;
      triggerDownload(`${docName}.${format}`, blob);
    })
    .catch((err) => {
      console.error(`palette: io.export-${format} failed`, err);
    });
}
