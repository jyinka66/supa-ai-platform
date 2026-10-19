// ─────────────────────────────────────────────────────────────
// Crash-safe autosave journal.
//
// Append-only journal, persisted to IndexedDB via the storage adapter.
// Recovery = replay journal onto last full snapshot. Every entry:
//   { seq, ts, snapshot?: DesignDoc, commands?: Command[] }
//
// Snapshot written every 50 commands OR 30s, whichever first; commands
// in between are the delta. Replay is deterministic (commands carry all
// ids — no generated state inside apply), so recovery is exact.
//
// Wall clock is OK here — the journal is metadata, not content. The
// doc itself (DesignDoc) has no timestamps per the spec rules.
// ─────────────────────────────────────────────────────────────

import type { DesignDoc } from "./types";
import type { Command } from "./commands";
import { apply } from "./apply";

export interface JournalEntry {
  /** Monotonically increasing sequence number. */
  seq: number;
  /** Wall-clock timestamp (journal metadata, not doc content). */
  ts: number;
  /** Full doc snapshot (written every SNAPSHOT_INTERVAL commands or SNAPSHOT_MS). */
  snapshot?: DesignDoc;
  /** Delta commands since the last snapshot. */
  commands?: Command[];
}

export interface JournalOptions {
  /** Max commands between snapshots (default 50). */
  snapshotInterval: number;
  /** Max time between snapshots in ms (default 30000). */
  snapshotMs: number;
  /** Max journal entries to keep (default 1000 — older entries are pruned after a snapshot). */
  maxEntries: number;
}

const DEFAULT_OPTIONS: JournalOptions = {
  snapshotInterval: 50,
  snapshotMs: 30_000,
  maxEntries: 1000,
};

/**
 * Storage adapter interface — the journal doesn't know about IndexedDB
 * directly. The caller provides an adapter that persists entries.
 *
 * In the browser, this is backed by IndexedDB. In tests, it can be
 * an in-memory array. In Node.js (SSR), it can be a no-op.
 */
export interface JournalStorage {
  /** Appends entries to persistent storage. */
  append(entries: JournalEntry[]): Promise<void>;
  /** Reads all entries since the given sequence number. */
  readSince(seq: number): Promise<JournalEntry[]>;
  /** Reads all entries (for full recovery). */
  readAll(): Promise<JournalEntry[]>;
  /** Deletes entries before the given sequence number (pruning). */
  pruneBefore(seq: number): Promise<void>;
  /** Clears all entries (for testing or reset). */
  clear(): Promise<void>;
}

/**
 * Append-only journal for crash-safe autosave.
 *
 * Usage:
 *   const journal = new Journal(storage, currentDoc);
 *
 *   // After each command:
 *   const { doc: newDoc, inverse } = apply(currentDoc, cmd);
 *   journal.append(cmd);
 *   currentDoc = newDoc;
 *
 *   // On crash + reload:
 *   const recovered = await Journal.recover(storage);
 *   if (recovered) currentDoc = recovered;
 */
export class Journal {
  private seq = 0;
  private commandsSinceSnapshot: Command[] = [];
  private lastSnapshotTime: number;
  private lastSnapshotDoc: DesignDoc;
  private readonly opts: JournalOptions;

  constructor(
    private readonly storage: JournalStorage,
    initialDoc: DesignDoc,
    opts?: Partial<JournalOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.lastSnapshotDoc = initialDoc;
    this.lastSnapshotTime = Date.now();
    // Write the initial snapshot.
    void this.writeSnapshot(initialDoc);
  }

  /**
   * Appends a command to the journal.
   * If the snapshot interval or time threshold is reached, writes a
   * full snapshot instead of the command delta.
   *
   * @param cmd The command to journal.
   * @param currentDoc The current doc state (for snapshot if needed).
   */
  async append(cmd: Command, currentDoc?: DesignDoc): Promise<void> {
    this.seq++;
    this.commandsSinceSnapshot.push(cmd);

    const shouldSnapshot =
      this.commandsSinceSnapshot.length >= this.opts.snapshotInterval ||
      Date.now() - this.lastSnapshotTime >= this.opts.snapshotMs;

    if (shouldSnapshot && currentDoc) {
      await this.writeSnapshot(currentDoc);
      this.commandsSinceSnapshot = [];
    } else {
      // Write the command delta.
      const entry: JournalEntry = {
        seq: this.seq,
        ts: Date.now(),
        commands: [cmd],
      };
      await this.storage.append([entry]);
    }
  }

  /**
   * Appends multiple commands as a single journal entry (batch undo step).
   */
  async appendBatch(commands: Command[], currentDoc?: DesignDoc): Promise<void> {
    this.seq++;
    this.commandsSinceSnapshot.push(...commands);

    const shouldSnapshot =
      this.commandsSinceSnapshot.length >= this.opts.snapshotInterval ||
      Date.now() - this.lastSnapshotTime >= this.opts.snapshotMs;

    if (shouldSnapshot && currentDoc) {
      await this.writeSnapshot(currentDoc);
      this.commandsSinceSnapshot = [];
    } else {
      const entry: JournalEntry = {
        seq: this.seq,
        ts: Date.now(),
        commands,
      };
      await this.storage.append([entry]);
    }
  }

  /**
   * Forces a snapshot write (e.g. on blur, route change, or explicit save).
   */
  async flush(currentDoc: DesignDoc): Promise<void> {
    await this.writeSnapshot(currentDoc);
    this.commandsSinceSnapshot = [];
  }

  /**
   * Writes a full doc snapshot to the journal.
   */
  private async writeSnapshot(doc: DesignDoc): Promise<void> {
    this.seq++;
    this.lastSnapshotDoc = doc;
    this.lastSnapshotTime = Date.now();

    const entry: JournalEntry = {
      seq: this.seq,
      ts: this.lastSnapshotTime,
      snapshot: doc,
    };
    await this.storage.append([entry]);

    // Prune old entries (keep only entries after the last snapshot).
    await this.storage.pruneBefore(this.seq - this.opts.maxEntries).catch(() => {
      // Best-effort pruning — don't fail the write.
    });
  }

  /**
   * Returns the sequence number of the last journal entry.
   */
  get lastSeq(): number {
    return this.seq;
  }

  // ============ STATIC RECOVERY ============

  /**
   * Recovers the doc from the journal.
   *
   * Finds the last snapshot, then replays all commands after it.
   * If no snapshot exists, starts from an empty doc (shouldn't happen
   * if the Journal was constructed properly).
   *
   * @returns The recovered doc, or null if the journal is empty.
   *
   * @example
   *   const recovered = await Journal.recover(storage);
   *   if (recovered) {
   *     const errors = validate(recovered);
   *     if (errors.length === 0) {
   *       setDoc(recovered);
   *     } else {
   *       console.error('Recovery produced invalid doc', errors);
   *     }
   *   }
   */
  static async recover(storage: JournalStorage): Promise<DesignDoc | null> {
    const entries = await storage.readAll();
    if (entries.length === 0) return null;

    // Find the last snapshot.
    let snapshotIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.snapshot) {
        snapshotIdx = i;
        break;
      }
    }

    // Start from the snapshot (or null if none found).
    let doc: DesignDoc | null = null;
    let startIdx = 0;

    if (snapshotIdx >= 0) {
      const snapshotEntry = entries[snapshotIdx];
      if (snapshotEntry?.snapshot) {
        doc = structuredClone(snapshotEntry.snapshot);
        startIdx = snapshotIdx + 1;
      }
    }

    if (!doc) {
      // No snapshot — can't recover (shouldn't happen if Journal was
      // constructed with an initial doc).
      return null;
    }

    // Replay all commands after the snapshot.
    for (let i = startIdx; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.commands) {
        for (const cmd of entry.commands) {
          const result = apply(doc, cmd);
          doc = result.doc;
        }
      }
      // Ignore intermediate snapshots — we already have the latest one.
    }

    return doc;
  }
}

// ============ IN-MEMORY STORAGE ADAPTER (for tests) ============

export class InMemoryJournalStorage implements JournalStorage {
  private entries: JournalEntry[] = [];

  append(entries: JournalEntry[]): Promise<void> {
    this.entries.push(...entries);
    return Promise.resolve();
  }

  async readSince(seq: number): Promise<JournalEntry[]> {
    return this.entries.filter((e) => e.seq > seq);
  }

  async readAll(): Promise<JournalEntry[]> {
    return [...this.entries];
  }

  pruneBefore(seq: number): Promise<void> {
    this.entries = this.entries.filter((e) => e.seq >= seq);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}
