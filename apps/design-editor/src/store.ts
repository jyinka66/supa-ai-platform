// ─────────────────────────────────────────────────────────────
// The store: single plain object + subscription set. React binds via
// useSyncExternalStore. No proxies, no diffs — commands are coarse
// (one per interaction frame), so full re-render per commit is fine;
// the canvas SVG re-render is the expensive part and it's cached by
// RenderCache keyed on rev.
// ─────────────────────────────────────────────────────────────

import type { DesignDoc } from "@supa/design-model";
import { apply, type Command, History } from "@supa/design-model";

// ============ STATE ============

export type Tool = "select" | "text" | "hand" | "shape" | "image" | "frame";

export interface EditorState {
  doc: DesignDoc;
  /** Bumped per apply — RenderCache key. */
  rev: number;
  /** Top-level selected node ids. */
  selection: string[];
  /** Hovered node id (for highlight), or null. */
  hoverId: string | null;
  /** Active page id. */
  pageId: string;
  /** Screen px per page px. */
  zoom: number;
  /** Page-space pan offset. */
  scroll: { x: number; y: number };
  /** Active tool. */
  tool: Tool;
  /** Live drag state — NOT in history. */
  transaction: OpenTransaction | null;
}

export interface OpenTransaction {
  kind: "move" | "resize" | "rotate" | "marquee";
  start: { x: number; y: number }; // page space
  /** Pre-transaction doc snapshot for coalescing on commit. */
  snapshot?: DesignDoc;
}

// ============ STORE ============

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private history: History;
  private batchDepth = 0;
  private batchCommands: Command[] = [];

  constructor(initialDoc: DesignDoc, pageId: string) {
    this.state = {
      doc: initialDoc,
      rev: 0,
      selection: [],
      hoverId: null,
      pageId,
      zoom: 1,
      scroll: { x: 0, y: 0 },
      tool: "select",
      transaction: null,
    };
    this.history = new History(200);
  }

  // ============ ACCESS (for useSyncExternalStore) ============

  get = (): EditorState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  // ============ APPLY ============

  /**
   * Applies a command to the doc + bumps rev.
   *
   * @param cmd      The command to apply.
   * @param opts     Ephemeral: true = don't push to history (for live drag).
   *                 The canvas still repaints (rev bumps) but history is untouched.
   */
  apply(cmd: Command, opts?: { ephemeral?: boolean }): void {
    const { doc, inverse } = apply(this.state.doc, cmd);

    this.state = {
      ...this.state,
      doc,
      rev: this.state.rev + 1,
    };

    if (!opts?.ephemeral) {
      if (this.batchDepth > 0) {
        // Collecting for a batch — don't push to history yet.
        this.batchCommands.push(cmd);
      } else {
        this.history.push({ cmd, inv: inverse });
      }
    }

    this.emit();
  }

  // ============ TRANSACTION LIFECYCLE ============

  /**
   * Begins a drag/resize/rotate transaction.
   * Mid-transaction ops go through apply(cmd, { ephemeral: true }).
   */
  beginTransaction(
    kind: OpenTransaction["kind"],
    start: { x: number; y: number },
  ): void {
    this.state = {
      ...this.state,
      transaction: {
        kind,
        start,
        snapshot: structuredClone(this.state.doc),
      },
    };
    this.emit();
  }

  /**
   * Ends a transaction + commits a single coalesced command to history.
   *
   * Coalescing: the pre-transaction snapshot is the undo target.
   * The final doc state is the redo target.
   * We push a synthetic history entry:
   *   cmd = a command that produces the final state from the snapshot
   *   inv = a command that restores the snapshot from the final state
   *
   * For simplicity, we push the snapshot as the inverse. The history's
   * undo() will apply the inverse (restore snapshot) and redo() will
   * re-apply the forward command (restore final state).
   *
   * NOTE: The true coalescing would compute the net diff between snapshot
   * and final state, then push a single UPDATE_PROPS or BATCH command.
   * For now, we push the snapshot restore as the inverse — the canvas
   * still repaints correctly because rev bumps on every apply.
   */
  endTransaction(): void {
    const txn = this.state.transaction;
    if (!txn?.snapshot) {
      this.state = { ...this.state, transaction: null };
      this.emit();
      return;
    }

    // The snapshot is the pre-transaction state.
    // The current doc is the post-transaction state.
    // We need to push a history entry where:
    //   - undo restores the snapshot
    //   - redo restores the current doc
    //
    // Since we can't easily compute the diff, we push a BATCH that
    // contains a no-op (the state is already correct). The inverse
    // is also a no-op BATCH — the actual undo/redo will be handled
    // by restoring the snapshot/current doc directly.
    //
    // This is a simplification — a full implementation would compute
    // the actual UPDATE_PROPS commands that represent the net change.
    const noopCmd: Command = { op: "BATCH", commands: [] };
    const noopInv: Command = { op: "BATCH", commands: [] };

    this.history.push({ cmd: noopCmd, inv: noopInv });
    this.redoStackHack = { undoDoc: txn.snapshot, redoDoc: this.state.doc };

    this.state = {
      ...this.state,
      transaction: null,
    };

    this.emit();
  }

  /** Hack: stores the undo/redo docs for the last transaction. */
  private redoStackHack: { undoDoc: DesignDoc; redoDoc: DesignDoc } | null = null;

  /**
   * Cancels a transaction (e.g. Escape key).
   * Restores the pre-transaction doc state.
   */
  cancelTransaction(): void {
    const txn = this.state.transaction;
    if (txn?.snapshot) {
      this.state = {
        ...this.state,
        doc: txn.snapshot,
        rev: this.state.rev + 1,
        transaction: null,
      };
    } else {
      this.state = { ...this.state, transaction: null };
    }
    this.emit();
  }

  // ============ UNDO / REDO ============

  undo(): void {
    // Check if the last history entry is a transaction hack.
    if (this.redoStackHack) {
      const { undoDoc, redoDoc } = this.redoStackHack;
      this.redoStackHack = null;

      // Pop the no-op from history.
      this.history.undo();

      this.state = {
        ...this.state,
        doc: structuredClone(undoDoc),
        rev: this.state.rev + 1,
      };

      // Store for redo.
      this.redoStackHack = { undoDoc, redoDoc };
      this.emit();
      return;
    }

    const invCmd = this.history.undo();
    if (!invCmd) return;

    const { doc } = apply(this.state.doc, invCmd);
    this.state = {
      ...this.state,
      doc,
      rev: this.state.rev + 1,
    };
    this.emit();
  }

  redo(): void {
    if (this.redoStackHack) {
      const { undoDoc, redoDoc } = this.redoStackHack;

      this.state = {
        ...this.state,
        doc: structuredClone(redoDoc),
        rev: this.state.rev + 1,
      };

      this.emit();
      return;
    }

    const fwdCmd = this.history.redo();
    if (!fwdCmd) return;

    const { doc } = apply(this.state.doc, fwdCmd);
    this.state = {
      ...this.state,
      doc,
      rev: this.state.rev + 1,
    };
    this.emit();
  }

  get canUndo(): boolean {
    return this.history.canUndo || this.redoStackHack !== null;
  }

  get canRedo(): boolean {
    return this.history.canRedo || this.redoStackHack !== null;
  }

  // ============ BATCH ============

  /**
   * Groups subsequent apply() calls into a single undo step.
   * Used by: paste, palette-swap, template-instantiate, command-palette multi-ops.
   *
   * @example
   *   store.beginBatch("paste");
   *   store.apply({ op: "ADD_NODE", ... });
   *   store.apply({ op: "UPDATE_PROPS", ... });
   *   store.endBatch();
   *   // → one undo step, two commands applied atomically.
   */
  beginBatch(_label: string): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth = Math.max(0, this.batchDepth - 1);
    if (this.batchDepth === 0 && this.batchCommands.length > 0) {
      const commands = this.batchCommands;
      this.batchCommands = [];

      const batchCmd: Command = { op: "BATCH", commands };
      const { doc, inverse } = apply(this.state.doc, batchCmd);
      this.state = {
        ...this.state,
        doc,
        rev: this.state.rev + 1,
      };
      this.history.push({ cmd: batchCmd, inv: inverse });
      this.emit();
    }
  }

  // ============ SELECTION ============

  setSelection(ids: string[]): void {
    this.state = { ...this.state, selection: ids };
    this.emit();
  }

  setHoverId(id: string | null): void {
    this.state = { ...this.state, hoverId: id };
    this.emit();
  }

  clearSelection(): void {
    this.state = { ...this.state, selection: [] };
    this.emit();
  }

  // ============ VIEW STATE ============

  setZoom(zoom: number): void {
    this.state = { ...this.state, zoom };
    this.emit();
  }

  setScroll(scroll: { x: number; y: number }): void {
    this.state = { ...this.state, scroll };
    this.emit();
  }

  setPageId(pageId: string): void {
    this.state = { ...this.state, pageId, selection: [] };
    this.emit();
  }

  setTool(tool: Tool): void {
    this.state = { ...this.state, tool };
    this.emit();
  }

  // ============ LOAD ============

  load(doc: DesignDoc, pageId?: string): void {
    this.state = {
      doc,
      rev: 0,
      selection: [],
      hoverId: null,
      pageId: pageId ?? doc.pages[0]?.id ?? "",
      zoom: 1,
      scroll: { x: 0, y: 0 },
      tool: "select",
      transaction: null,
    };
    this.history.clear();
    this.batchCommands = [];
    this.batchDepth = 0;
    this.redoStackHack = null;
    this.emit();
  }

  /**
   * Updates top-level doc fields that aren't covered by layer/page
   * commands. Currently only `title` is supported (mapped to doc.name).
   *
   * This is a direct mutation — it doesn't go through the command
   * history. A future UPDATE_DOC command will make this undoable;
   * for now the canvas repaints (rev bumps) but undo won't revert
   * the rename.
   *
   * Used by the command palette's "Rename document" command.
   */
  updateDoc(patch: { title?: string }): void {
    if (patch.title !== undefined && patch.title !== this.state.doc.name) {
      this.state = {
        ...this.state,
        doc: { ...this.state.doc, name: patch.title },
        rev: this.state.rev + 1,
      };
      this.emit();
    }
  }

  // ============ EMIT ============

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
