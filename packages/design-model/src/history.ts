// Undo/redo stacks of {command, inverse}. Redo cleared on new command.
// Memory-bounded: cap 200 entries, evict oldest (autosave journal is the
// deep history; in-memory stacks are for session UX only).

import type { Command } from "./commands";

interface HistoryEntry {
  /** The forward command (for redo). */
  cmd: Command;
  /** The inverse command (for undo). */
  inv: Command;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  /**
   * Pushes a command + its inverse onto the undo stack.
   * Clears the redo stack (any new command invalidates the redo path).
   * Evicts the oldest entry if the stack exceeds maxEntries.
   *
   * @example
   *   const { doc: newDoc, inverse } = apply(currentDoc, cmd);
   *   history.push({ cmd, inv: inverse });
   *   setCurrentDoc(newDoc);
   */
  push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxEntries) {
      this.undoStack.shift(); // evict oldest
    }
    this.redoStack = [];
  }

  /**
   * Pops the last entry from the undo stack and returns the inverse command.
   * The caller applies the inverse to get the previous doc state.
   *
   * @returns The inverse command, or null if the undo stack is empty.
   *
   * @example
   *   const invCmd = history.undo();
   *   if (invCmd) {
   *     const { doc: prevDoc } = apply(currentDoc, invCmd);
   *     setCurrentDoc(prevDoc);
   *   }
   */
  undo(): Command | null {
    const entry = this.undoStack.pop();
    if (entry) {
      this.redoStack.push(entry);
      return entry.inv;
    }
    return null;
  }

  /**
   * Pops the last entry from the redo stack and returns the forward command.
   * The caller applies the command to get the next doc state.
   *
   * @returns The forward command, or null if the redo stack is empty.
   *
   * @example
   *   const fwdCmd = history.redo();
   *   if (fwdCmd) {
   *     const { doc: nextDoc } = apply(currentDoc, fwdCmd);
   *     setCurrentDoc(nextDoc);
   *   }
   */
  redo(): Command | null {
    const entry = this.redoStack.pop();
    if (entry) {
      this.undoStack.push(entry);
      return entry.cmd;
    }
    return null;
  }

  /** True if there are commands to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** True if there are commands to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Returns the number of undoable commands. */
  get undoCount(): number {
    return this.undoStack.length;
  }

  /** Returns the number of redoable commands. */
  get redoCount(): number {
    return this.redoStack.length;
  }

  /** Clears both stacks (e.g. when loading a new document). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Returns a snapshot of the undo stack for serialization
   * (e.g. for collaboration or session persistence).
   * The redo stack is NOT serialized — it's session-only state.
   */
  serialize(): HistoryEntry[] {
    return [...this.undoStack];
  }

  /**
   * Restores the undo stack from a serialized snapshot.
   * Clears the redo stack (can't redo into an unknown future).
   */
  deserialize(entries: HistoryEntry[]): void {
    this.undoStack = [...entries].slice(-this.maxEntries);
    this.redoStack = [];
  }
}
