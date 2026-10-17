// Memory store — redaction, scoping, TTL.
//
//   write      — UPSERT-on-dedup: identical (agent_id, kind, content) bumps
//                last_used_at instead of duplicating (drift defense). PII
//                redaction applied before the write (the redacted text is what
//                lands in the row; the original is never stored). TTL via
//                opts.ttlHours → expires_at = now + ttlHours.
//
//   recall     — filtered by kinds (optional) + TTL (only non-expired rows
//                returned). Ordered by confidence desc, then last_used_at desc
//                (LRU ties broken by confidence).
//
//   userEdit   — user-facing edit (always available, GDPR acceptance criteria).
//                Re-redacts the new content, bumps confidence by +0.2 capped at
//                1.0 (user-edited = more trusted), updates updated_at.
//                Workspace-scoped: the WHERE clause requires both id AND ws_id
//                (a user from another workspace can't touch this row even with a
//                leaked id — RLS is the backstop, but defense-in-depth here too).
//
//   userDelete — hard delete (the user explicitly asked; this is the right-to-
//                erasure surface). Same workspace scoping as userEdit.
//
// Provenance flows: agent writes are provenance='agent'; user edits flip it to
// 'user' (the memory now reflects the user's authoritative view). template_seed
// is set by the agent's onboarding template loader (not via this store).

import { db } from "@supa/db";
import { agentMemory } from "@supa/db/schema";
import { eq, and, desc, gt, isNull, or, inArray, sql } from "drizzle-orm";
import { redactPII } from "../platform.js";

export type MemoryKind = "fact" | "episode" | "procedure" | "preference";
export type MemoryProvenance = "agent" | "user" | "template_seed";

export interface MemoryRecord {
  id: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  redacted: boolean;
  provenance: MemoryProvenance;
  confidence: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WriteOpts {
  provenance?: MemoryProvenance;
  /** Hours until the memory expires. null = no expiry (default). */
  ttlHours?: number | null;
  /** Confidence 0..1, default 0.5. */
  confidence?: number;
}

export interface RecallQuery {
  /** Filter to specific kinds. null/undefined = all kinds. */
  kinds?: readonly MemoryKind[];
  /** Max rows, default 20. */
  limit?: number;
}

/**
 * Agent memory store. One instance per RunContext (per run). Writes go through
 * PII redaction → upsert (dedup-on-conflict bumps last_used_at). Reads are
 * workspace + agent scoped + TTL-honoring. User-facing view/edit/delete are
 * always available (acceptance criteria).
 */
export class MemoryStore {
  constructor(
    private readonly wsId: string,
    private readonly agentId: string,
  ) {}

  /**
   * Write a memory. UPSERT-on-dedup: identical (agent_id, kind, content) bumps
   * last_used_at + updated_at instead of duplicating (drift defense — the
   * dedup unique index is the source of truth, the on-conflict-do-update makes
   * the second write a bump rather than a no-op or an error).
   *
   * PII is redacted BEFORE the write; the redacted text is what lands in the
   * row. The `redacted` flag is set if any rule matched, so the agent's recall
   * can mark "[redacted]" in the UI when the flag is set.
   *
   * TTL: opts.ttlHours → expires_at = now + ttlHours. null = no expiry.
   */
  async write(
    kind: MemoryKind,
    content: string,
    opts: WriteOpts = {},
  ): Promise<void> {
    const redacted = redactPII(content);
    const provenance = opts.provenance ?? "agent";
    const confidence = (opts.confidence ?? 0.5).toString();
    const expiresAt =
      opts.ttlHours != null && opts.ttlHours > 0
        ? sql`now() + (${opts.ttlHours} || ' hours')::interval`
        : null;

    await db
      .insert(agentMemory)
      .values({
        workspaceId: this.wsId as any,
        agentId: this.agentId as any,
        kind,
        content: redacted.text,
        redacted: redacted.redactedSomething,
        provenance,
        confidence,
        expiresAt,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          agentMemory.agentId,
          agentMemory.kind,
          agentMemory.content,
        ],
        set: {
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Recall memories. Filtered by kinds (optional) + TTL (only non-expired rows
   * returned — `expires_at IS NULL OR expires_at > now()`). Ordered by
   * confidence desc, then last_used_at desc nulls last (LRU tie-break).
   *
   * The kind filter is workspace + agent scoped — a recall never crosses agent
   * boundaries (memory is the agent's only persistent knowledge surface; a
   * sibling agent's memory is not visible).
   */
  async recall(query: RecallQuery = {}): Promise<MemoryRecord[]> {
    const kinds = query.kinds;
    const limit = query.limit ?? 20;

    const rows = await db
      .select({
        id: agentMemory.id,
        agentId: agentMemory.agentId,
        kind: agentMemory.kind,
        content: agentMemory.content,
        redacted: agentMemory.redacted,
        provenance: agentMemory.provenance,
        confidence: agentMemory.confidence,
        lastUsedAt: agentMemory.lastUsedAt,
        expiresAt: agentMemory.expiresAt,
        createdAt: agentMemory.createdAt,
        updatedAt: agentMemory.updatedAt,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.agentId, this.agentId as any),
          eq(agentMemory.workspaceId, this.wsId as any),
          // TTL: include rows with no expiry OR expiry in the future.
          or(
            isNull(agentMemory.expiresAt),
            gt(agentMemory.expiresAt, new Date()),
          ),
          // Kind filter: if kinds is provided, restrict to those.
          ...(kinds && kinds.length > 0
            ? [inArray(agentMemory.kind, [...kinds] as string[])]
            : []),
        ),
      )
      .orderBy(
        desc(agentMemory.confidence),
        desc(agentMemory.lastUsedAt),
      )
      .limit(limit);

    return rows as unknown as MemoryRecord[];
  }

  /** Backward-compatible single-kind recall. */
  async read(kind: MemoryKind, limit = 10): Promise<MemoryRecord[]> {
    return this.recall({ kinds: [kind], limit });
  }

  /**
   * User-facing edit. Re-redacts the new content (PII rules evolve; the new
   * text gets fresh redaction). Bumps confidence by +0.2 capped at 1.0
   * (user-edited = more trusted; the cap prevents runaway confidence from
   * repeated edits). Flips provenance to 'user' (the memory now reflects the
   * user's authoritative view, not the agent's hypothesis).
   *
   * Workspace-scoped: WHERE id AND ws_id (defense-in-depth against a leaked
   * id from another workspace; RLS is the backstop, but the explicit scope
   * means even an RLS bypass can't cross tenants here).
   */
  async userEdit(id: string, newContent: string): Promise<void> {
    const redacted = redactPII(newContent);
    await db
      .update(agentMemory)
      .set({
        content: redacted.text,
        redacted: redacted.redactedSomething,
        provenance: "user",
        // Bump confidence by +0.2 capped at 1.0. least() prevents runaway.
        confidence: sql`least((${agentMemory.confidence}::numeric + 0.2), 1.0)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentMemory.id, id as any),
          eq(agentMemory.workspaceId, this.wsId as any),
        ),
      );
  }

  /**
   * User-facing delete. Hard delete (the user explicitly asked — right-to-
   * erasure surface). Same workspace scoping as userEdit. The row is gone;
   * no tombstone, no audit trail of the deleted content (the user asked for
   * erasure; an audit trail of the content would defeat the point).
   *
   * Note: if a memory fact was already emitted to the activity_facts table
   * referencing this memory, that fact is NOT deleted (facts are append-only
   * by the invoice-void rule — corrections are reversing entries, not
   * deletes). The fact ref carries the memory id only, never the content —
   * so the erasure is complete from a PII standpoint.
   */
  async userDelete(id: string): Promise<void> {
    await db
      .delete(agentMemory)
      .where(
        and(
          eq(agentMemory.id, id as any),
          eq(agentMemory.workspaceId, this.wsId as any),
        ),
      );
  }
}
