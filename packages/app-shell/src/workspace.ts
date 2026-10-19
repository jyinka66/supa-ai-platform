// ─────────────────────────────────────────────────────────────
// Workspace model: the units of navigation and persistence.
//   account → projects → documents → pages
//   document = DesignDoc + asset refs + bindings + sync metadata
//
// State machine for a document session:
//   loading → ready ⇄ syncing → offline-pending → ready
//                  ↘ conflict → resolving → ready
// The shell owns this machine; design-sync owns the transports.
// The editor mounts only in `ready|syncing|offline-pending`; `conflict`
// swaps in the resolution UI (design-sync's Conflictor UI from pass 1).
//
// Routing (URL is truth, back-button always works):
//   /projects                     → project browser
//   /d/:docId/:pageId?            → editor
//   /d/:docId/present             → presentation mode (render-only,
//                                   keyboard nav, zero editor code
//                                   loaded — split by import boundary)
//   /d/:docId/export             → export dialog deep-link (shareable
//                                   export settings)
// Route state → store (zoom/scroll/selection can serialize into the URL
// query for shareable viewport links: ?sel=nodeId&zoom=1.2&x=..&y=..).
// ─────────────────────────────────────────────────────────────

import type { DesignDoc } from "@supa/design-model";

// ============ ENTITIES ============

export interface Account {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  plan: "free" | "pro" | "team" | "enterprise";
}

export interface Project {
  id: string;
  name: string;
  accountId: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRef {
  id: string;
  name: string;
  projectId: string;
  kind: string; // "flyer" | "logo" | "presentation" | ...
  thumbnailSvg: string | null;
  templateId: { id: string; version: number } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Document = DesignDoc + asset refs + bindings + sync metadata.
 *
 * This is the full representation loaded when opening a document.
 * The DesignDoc is the design content; the rest is workspace metadata.
 */
export interface WorkspaceDocument {
  ref: DocumentRef;
  doc: DesignDoc;
  /** Asset references (storage paths, not the bytes). */
  assets: Record<string, { kind: "raster" | "svg"; ref: string; width?: number; height?: number }>;
  /** Template bindings (for re-instantiation on "update to latest"). */
  bindings: Record<string, unknown>;
  /** Sync metadata (collaboration state). */
  sync: SyncMetadata;
}

export interface SyncMetadata {
  /** Current revision (monotonically increasing). */
  rev: number;
  /** Last synced revision (what the server has). */
  lastSyncedRev: number;
  /** Pending operations (for offline → online replay). */
  pendingOps: unknown[];
  /** Collaborators currently viewing/editing (for presence). */
  collaborators: Collaborator[];
}

export interface Collaborator {
  userId: string;
  name: string;
  avatarUrl: string | null;
  color: string; // cursor color
  /** Current page + selection (for presence). */
  pageId: string | null;
  selection: string[];
  /** Last active timestamp (for "is this user still here?"). */
  lastActiveAt: number;
}

// ============ SESSION STATE MACHINE ============

export type SessionState =
  | { kind: "loading"; docId: string }
  | { kind: "ready"; doc: WorkspaceDocument; pageId: string }
  | { kind: "syncing"; doc: WorkspaceDocument; pageId: string; pendingRev: number }
  | { kind: "offline-pending"; doc: WorkspaceDocument; pageId: string; pendingOps: unknown[] }
  | { kind: "conflict"; doc: WorkspaceDocument; pageId: string; localRev: number; remoteRev: number }
  | { kind: "resolving"; doc: WorkspaceDocument; pageId: string; conflict: ConflictData }
  | { kind: "error"; docId: string; error: string };

export interface ConflictData {
  localDoc: DesignDoc;
  remoteDoc: DesignDoc;
  /** Per-node conflict details (for the resolution UI). */
  conflicts: Array<{
    nodeId: string;
    localChange: string;
    remoteChange: string;
  }>;
}

/**
 * Returns true if the editor should be mounted in the given state.
 *
 * The editor mounts in: ready, syncing, offline-pending.
 * It does NOT mount in: loading, conflict, resolving, error.
 */
export function editorMounted(state: SessionState): boolean {
  switch (state.kind) {
    case "ready":
    case "syncing":
    case "offline-pending":
      return true;
    default:
      return false;
  }
}

/**
 * Returns true if the conflict resolution UI should be shown.
 */
export function showingConflict(state: SessionState): boolean {
  return state.kind === "conflict" || state.kind === "resolving";
}

// ============ SESSION STORE ============

/**
 * Document session store — manages the state machine + transitions.
 *
 * The shell owns this store; the editor reads from it (mounted only in
 * ready/syncing/offline-pending).
 *
 * Transitions:
 *   loading → ready (on document load)
 *   ready → syncing (on command apply with unsaved changes)
 *   syncing → ready (on sync complete)
 *   ready → offline-pending (on network loss)
 *   offline-pending → ready (on reconnect + replay)
 *   syncing → conflict (on sync conflict)
 *   conflict → resolving (user opens conflict UI)
 *   resolving → ready (user resolves conflict)
 */
export class SessionStore {
  private state: SessionState;
  private listeners = new Set<() => void>();

  constructor(docId: string) {
    this.state = { kind: "loading", docId };
  }

  get = (): SessionState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  // ============ TRANSITIONS ============

  /** loading → ready (document loaded). */
  loadDocument(doc: WorkspaceDocument, pageId: string): void {
    if (this.state.kind !== "loading") return;
    this.state = { kind: "ready", doc, pageId };
    this.emit();
  }

  /** ready → syncing (command applied, changes pending). */
  beginSync(pendingRev: number): void {
    if (this.state.kind !== "ready") return;
    this.state = { ...this.state, kind: "syncing", pendingRev };
    this.emit();
  }

  /** syncing → ready (sync complete). */
  syncComplete(): void {
    if (this.state.kind !== "syncing") return;
    this.state = { kind: "ready", doc: this.state.doc, pageId: this.state.pageId };
    this.emit();
  }

  /** ready → offline-pending (network lost). */
  goOffline(pendingOps: unknown[]): void {
    if (this.state.kind !== "ready" && this.state.kind !== "syncing") return;
    this.state = { kind: "offline-pending", doc: this.state.doc, pageId: this.state.pageId, pendingOps };
    this.emit();
  }

  /** offline-pending → ready (reconnected + replayed). */
  goOnline(doc: WorkspaceDocument): void {
    if (this.state.kind !== "offline-pending") return;
    this.state = { kind: "ready", doc, pageId: this.state.pageId };
    this.emit();
  }

  /** syncing → conflict (sync conflict detected). */
  conflictDetected(localRev: number, remoteRev: number): void {
    if (this.state.kind !== "syncing") return;
    this.state = { kind: "conflict", doc: this.state.doc, pageId: this.state.pageId, localRev, remoteRev };
    this.emit();
  }

  /** conflict → resolving (user opens conflict UI). */
  beginResolve(conflict: ConflictData): void {
    if (this.state.kind !== "conflict") return;
    this.state = { kind: "resolving", doc: this.state.doc, pageId: this.state.pageId, conflict };
    this.emit();
  }

  /** resolving → ready (user resolved conflict). */
  resolveComplete(doc: WorkspaceDocument): void {
    if (this.state.kind !== "resolving") return;
    this.state = { kind: "ready", doc, pageId: this.state.pageId };
    this.emit();
  }

  /** any → error (load failure, etc.). */
  fail(error: string): void {
    const docId = "docId" in this.state ? this.state.docId : this.state.doc.ref.id;
    this.state = { kind: "error", docId, error };
    this.emit();
  }

  // ============ PAGE NAVIGATION ============

  setPageId(pageId: string): void {
    if (this.state.kind === "loading" || this.state.kind === "error") return;
    this.state = { ...this.state, pageId };
    this.emit();
  }

  // ============ EMIT ============

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

// ============ ROUTING ============

export interface RouteParams {
  /** /projects → project browser */
  /** /d/:docId/:pageId? → editor */
  /** /d/:docId/present → presentation mode */
  /** /d/:docId/export → export dialog */
  docId?: string;
  pageId?: string;
  mode?: "edit" | "present" | "export";
  /** Viewport state (serialized from URL query for shareable links). */
  sel?: string[];
  zoom?: number;
  x?: number;
  y?: number;
}

/**
 * Parses URL path + query into route params.
 *
 * @example
 *   parseRoute("/d/abc123/present?zoom=1.5") →
 *   { docId: "abc123", mode: "present", zoom: 1.5 }
 *
 *   parseRoute("/d/abc123/page2?sel=n1,n2&zoom=0.8&x=100&y=50") →
 *   { docId: "abc123", pageId: "page2", sel: ["n1","n2"], zoom: 0.8, x: 100, y: 50 }
 */
export function parseRoute(pathname: string, search: string): RouteParams {
  const params: RouteParams = {};
  const segments = pathname.split("/").filter(Boolean);

  // /projects
  if (segments[0] === "projects") {
    return params; // project browser — no doc
  }

  // /d/:docId/:pageId?
  if (segments[0] === "d" && segments[1]) {
    params.docId = segments[1];

    if (segments[2] === "present") {
      params.mode = "present";
    } else if (segments[2] === "export") {
      params.mode = "export";
    } else if (segments[2]) {
      params.pageId = segments[2];
      params.mode = "edit";
    } else {
      params.mode = "edit";
    }
  }

  // Parse query params (viewport state).
  const searchParams = new URLSearchParams(search);
  const sel = searchParams.get("sel");
  if (sel) params.sel = sel.split(",").filter(Boolean);

  const zoom = searchParams.get("zoom");
  if (zoom) params.zoom = parseFloat(zoom);

  const x = searchParams.get("x");
  if (x) params.x = parseFloat(x);

  const y = searchParams.get("y");
  if (y) params.y = parseFloat(y);

  return params;
}

/**
 * Serializes route params into a URL string.
 *
 * @example
 *   serializeRoute({ docId: "abc", pageId: "p1", sel: ["n1","n2"], zoom: 1.2, x: 100, y: 50 }) →
 *   "/d/abc/p1?sel=n1,n2&zoom=1.2&x=100&y=50"
 */
export function serializeRoute(params: RouteParams): string {
  if (!params.docId) return "/projects";

  let path = `/d/${params.docId}`;

  if (params.mode === "present") {
    path += "/present";
  } else if (params.mode === "export") {
    path += "/export";
  } else if (params.pageId) {
    path += `/${params.pageId}`;
  }

  const query: string[] = [];
  if (params.sel && params.sel.length > 0) query.push(`sel=${params.sel.join(",")}`);
  if (params.zoom !== undefined) query.push(`zoom=${String(params.zoom)}`);
  if (params.x !== undefined) query.push(`x=${String(params.x)}`);
  if (params.y !== undefined) query.push(`y=${String(params.y)}`);

  if (query.length > 0) path += `?${query.join("&")}`;

  return path;
}

/**
 * Returns true if the route is a project browser (no docId).
 */
export function isProjectBrowser(params: RouteParams): boolean {
  return !params.docId;
}

/**
 * Returns true if the route is presentation mode (zero editor code loaded).
 * Used by the bundler to split the editor chunk — present mode imports
 * only design-render, not design-editor.
 */
export function isPresentationMode(params: RouteParams): boolean {
  return params.mode === "present";
}

/**
 * Returns true if the route is the export dialog deep-link.
 */
export function isExportDialog(params: RouteParams): boolean {
  return params.mode === "export";
}
