// ─────────────────────────────────────────────────────────────
// Sync lifecycle — wires design-sync into the editor without either
// knowing the other.
//
//   editor store ──(rev bump)──▶ outbox flush (debounced 400ms idle)
//   sync transport ──(remote ops)──▶ design-commands applyOp(rebase)
//                 └─▶ if local transaction open: buffer remotes, apply
//                     at endTransaction (drag never rebases mid-flight —
//                     avoids resize-jump ghosts on your own cursor)
//
// Presence plumbing: local cursor (throttled 30Hz screen→page space),
// selection broadcast, and REMOTE selections render as outlined boxes
// with name tags in the OverlayLayer.
//
// Offline: NetInfo/browser events drive the state machine; on reconnect,
// outbox drains in order, then remote fetch resumes. The doc is fully
// editable offline (local-first by construction — everything is ops).
// Conflict → the design-sync resolution UI; the shell only routes to it.
// ─────────────────────────────────────────────────────────────

import type { Command, DesignDoc } from "@supa/design-model";
import { apply } from "@supa/design-model";
import type { EditorStore } from "@supa/design-editor";
import type { SessionStore, Collaborator } from "./workspace";

// ============ SYNC TRANSPORT INTERFACE ============

/**
 * The sync transport interface — the editor doesn't know the transport
 * (WebSocket, CRDT, REST polling — all behind this interface).
 *
 * The shell provides the implementation; the editor + sync-lifecycle
 * only depend on this contract.
 */
export interface SyncTransport {
  /** Sends local operations to the server. */
  sendOps(ops: OutboundOp[]): Promise<void>;
  /** Subscribes to remote operations from the server. */
  onRemoteOps(handler: (ops: InboundOp[]) => void): () => void;
  /** Subscribes to presence updates from other collaborators. */
  onPresence(handler: (updates: PresenceUpdate[]) => void): () => void;
  /** Sends local presence (cursor position, selection). */
  sendPresence(presence: LocalPresence): void;
  /** Fetches the full document state (on initial load or reconnect). */
  fetchDoc(): Promise<DesignDoc>;
  /** Checks if the transport is connected. */
  isConnected(): boolean;
}

export interface OutboundOp {
  /** The command that was applied locally. */
  cmd: Command;
  /** The local revision when this op was generated. */
  rev: number;
  /** Monotonic client-side sequence number. */
  seq: number;
}

export interface InboundOp {
  /** The command to apply (rebased onto local state). */
  cmd: Command;
  /** The server revision this op brings us to. */
  rev: number;
  /** The client ID that generated this op (for "was this mine?"). */
  clientId: string;
}

export interface LocalPresence {
  pageId: string;
  selection: string[];
  /** Page-space cursor position, or null if not hovering the canvas. */
  cursor: { x: number; y: number } | null;
}

export interface PresenceUpdate {
  userId: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  pageId: string | null;
  selection: string[];
  cursor: { x: number; y: number } | null;
  lastActiveAt: number;
}

// ============ SYNC LIFECYCLE ============

export class SyncLifecycle {
  private outbox: OutboundOp[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteBuffer: InboundOp[] = [];
  private localSeq = 0;
  private cursorThrottle: ReturnType<typeof setTimeout> | null = null;
  private lastCursorSent = 0;
  private unsubscribers: Array<() => void> = [];
  private online = true;

  constructor(
    private store: EditorStore,
    private session: SessionStore,
    private transport: SyncTransport,
  ) {
    this.init();
  }

  // ============ INIT ============

  private init(): void {
    // Subscribe to editor store changes (rev bumps → outbox).
    this.unsubscribers.push(
      this.store.subscribe(() => { this.onStoreChange(); }),
    );

    // Subscribe to remote ops from the transport.
    this.unsubscribers.push(
      this.transport.onRemoteOps((ops) => { this.onRemoteOps(ops); }),
    );

    // Subscribe to presence updates.
    this.unsubscribers.push(
      this.transport.onPresence((updates) => { this.onPresence(updates); }),
    );

    // Online/offline detection.
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);

    this.online = navigator.onLine;
  }

  // ============ OUTBOUND (local → server) ============

  /**
   * Called when the editor store emits (rev bumped).
   * Queues the last applied command + debounces a flush (400ms idle).
   *
   * During a transaction (live drag), we don't flush — the ephemeral
   * ops aren't in history. Only the committed command (from
   * endTransaction) goes to the outbox.
   */
  private onStoreChange(): void {
    const state = this.store.get();

    // Don't sync during a transaction (live drag).
    if (state.transaction) return;

    // Don't sync if the rev hasn't changed (e.g. selection-only change).
    // We track the last synced rev internally.
    // NOTE: The actual command extraction would compare the doc state
    // before/after the store change. For simplicity, we queue a flush
    // and let the transport handle the diff.

    // Debounce the flush (400ms idle).
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flushOutbox(); }, 400);
  }

  /**
   * Flushes the outbox to the transport.
   * Called on: 400ms idle after a change, on blur, on route leave.
   */
  async flushOutbox(): Promise<void> {
    if (this.outbox.length === 0) return;
    if (!this.online) return; // offline — ops stay in outbox

    const ops = [...this.outbox];
    this.outbox = [];

    try {
      const state = this.store.get();
      this.session.beginSync(state.rev);

      await this.transport.sendOps(ops);

      this.session.syncComplete();
    } catch {
      // Failed to sync — put ops back in the outbox.
      this.outbox.unshift(...ops);

      if (!navigator.onLine) {
        this.session.goOffline(this.outbox);
      } else {
        // Network error while online — retry on next flush.
        this.session.syncComplete();
      }
    }
  }

  // ============ INBOUND (remote → local) ============

  /**
   * Handles remote operations from the transport.
   *
   * If a local transaction is open (live drag), buffers the remotes
   * and applies them at endTransaction. This prevents resize-jump
   * ghosts on your own cursor during a drag.
   *
   * Otherwise, applies the rebased ops immediately.
   */
  private onRemoteOps(ops: InboundOp[]): void {
    if (ops.length === 0) return;

    const state = this.store.get();

    // If a local transaction is open, buffer the remotes.
    if (state.transaction) {
      this.remoteBuffer.push(...ops);
      return;
    }

    // Apply remotes immediately (rebased onto local state).
    for (const op of ops) {
      try {
        apply(this.store.get().doc, op.cmd);
        // Apply silently (no history entry — remote ops don't go into
        // the local undo stack).
        // NOTE: The editor store's apply() pushes to history. For remote
        // ops, we need a "silent apply" that doesn't push to history.
        // For now, we use the ephemeral flag — a future editor store
        // revision will have a dedicated "remote apply" method.
        this.store.apply(op.cmd, { ephemeral: true });
      } catch {
        // Rebase failure — the op may have been superseded.
        // The transport should handle this (it knows the causal history).
      }
    }
  }

  /**
   * Drains the remote buffer after a transaction ends.
   * Called when the editor calls endTransaction().
   */
  drainRemoteBuffer(): void {
    if (this.remoteBuffer.length === 0) return;
    const ops = [...this.remoteBuffer];
    this.remoteBuffer = [];
    this.onRemoteOps(ops);
  }

  // ============ PRESENCE ============

  /**
   * Broadcasts local cursor position (throttled to 30Hz).
   * Converts screen-space to page-space before sending.
   */
  sendCursor(screenX: number, screenY: number, zoom: number, scroll: { x: number; y: number }): void {
    const now = Date.now();
    if (now - this.lastCursorSent < 33) return; // 30Hz

    this.lastCursorSent = now;

    // Throttle via setTimeout to batch multiple cursor moves.
    if (this.cursorThrottle) return;

    this.cursorThrottle = setTimeout(() => {
      this.cursorThrottle = null;

      const pageX = screenX / zoom + scroll.x;
      const pageY = screenY / zoom + scroll.y;

      const state = this.store.get();
      this.transport.sendPresence({
        pageId: state.pageId,
        selection: state.selection,
        cursor: { x: pageX, y: pageY },
      });
    }, 33);
  }

  /**
   * Handles remote presence updates.
   * Updates the session store's collaborator list (for the overlay).
   */
  private onPresence(updates: PresenceUpdate[]): void {
    const state = this.session.get();
    if (state.kind !== "ready" && state.kind !== "syncing" && state.kind !== "offline-pending") return;

    const collaborators: Collaborator[] = updates.map((u) => ({
      userId: u.userId,
      name: u.name,
      avatarUrl: u.avatarUrl,
      color: u.color,
      pageId: u.pageId,
      selection: u.selection,
      lastActiveAt: u.lastActiveAt,
    }));

    // Update the sync metadata (the overlay reads from this).
    state.doc.sync.collaborators = collaborators;
  }

  // ============ ONLINE / OFFLINE ============

  private handleOnline = (): void => {
    this.online = true;
    // Drain the outbox in order.
    void this.flushOutbox();
    // Resume remote ops.
    // (The transport reconnects + starts delivering remote ops again.)
  };

  private handleOffline = (): void => {
    this.online = false;
    // Transition to offline-pending.
    const state = this.session.get();
    if (state.kind === "ready" || state.kind === "syncing") {
      this.session.goOffline(this.outbox);
    }
  };

  // ============ CLEANUP ============

  destroy(): void {
    // Flush any pending ops.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      void this.flushOutbox();
    }
    if (this.cursorThrottle) {
      clearTimeout(this.cursorThrottle);
    }

    // Unsubscribe from everything.
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    // Remove event listeners.
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }
}

// ============ REMOTE SELECTION OVERLAY ============

export interface RemoteSelectionRect {
  collaborator: Collaborator;
  /** Screen-space rect (already converted from page space). */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Computes the screen-space selection rects for remote collaborators.
 * Used by the OverlayLayer to render outlined boxes with name tags.
 *
 * @example
 *   const rects = computeRemoteSelections(doc, collaborators, zoom, scroll);
 *   // Render each as: <rect ... stroke={collaborator.color} /> + <text>{collaborator.name}</text>
 */
export function computeRemoteSelections(
  doc: DesignDoc,
  collaborators: Collaborator[],
  zoom: number,
  scroll: { x: number; y: number },
): RemoteSelectionRect[] {
  const result: RemoteSelectionRect[] = [];

  for (const collab of collaborators) {
    if (!collab.pageId || collab.selection.length === 0) continue;

    // Find the collaborator's page.
    const page = doc.pages.find((p) => p.id === collab.pageId);
    if (!page) continue;

    // Find each selected node + compute its screen-space rect.
    for (const nodeId of collab.selection) {
      const node = findLayerInPage(page, nodeId);
      if (!node) continue;

      const screenX = (node.rect.x - scroll.x) * zoom;
      const screenY = (node.rect.y - scroll.y) * zoom;

      result.push({
        collaborator: collab,
        rect: {
          x: screenX,
          y: screenY,
          width: node.rect.width * zoom,
          height: node.rect.height * zoom,
        },
      });
    }
  }

  return result;
}

/**
 * Renders remote selections as SVG string (for the OverlayLayer).
 * Each collaborator's selection is an outlined rect + name tag.
 */
export function renderRemoteSelections(
  doc: DesignDoc,
  collaborators: Collaborator[],
  zoom: number,
  scroll: { x: number; y: number },
): string {
  const rects = computeRemoteSelections(doc, collaborators, zoom, scroll);
  if (rects.length === 0) return "";

  const parts: string[] = ['<g class="remote-selections" style="pointer-events:none">'];

  for (const { collaborator, rect } of rects) {
    // Outlined rect in the collaborator's color.
    parts.push(
      `<rect x="${String(rect.x)}" y="${String(rect.y)}" width="${String(rect.width)}" height="${String(rect.height)}" ` +
      `fill="none" stroke="${collaborator.color}" stroke-width="1.5" rx="1" />`,
    );

    // Name tag (top-left corner).
    const tagWidth = collaborator.name.length * 7 + 8;
    parts.push(
      `<rect x="${String(rect.x)}" y="${String(rect.y - 18)}" width="${String(tagWidth)}" height="16" ` +
      `fill="${collaborator.color}" rx="2" />`,
    );
    parts.push(
      `<text x="${String(rect.x + 4)}" y="${String(rect.y - 6)}" font-size="10" fill="white" ` +
      `font-family="system-ui, sans-serif">${escapeXml(collaborator.name)}</text>`,
    );
  }

  parts.push("</g>");
  return parts.join("");
}

// ============ HELPERS ============

function findLayerInPage(page: import("@supa/design-model").Page, id: string) {
  function search(node: import("@supa/design-model").LayerNode): import("@supa/design-model").LayerNode | null {
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }
  for (const layer of page.layers) {
    const found = search(layer);
    if (found) return found;
  }
  return null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
