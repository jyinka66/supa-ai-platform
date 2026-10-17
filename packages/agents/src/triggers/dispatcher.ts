// Trigger dispatcher — the single gate through which all non-manual runs enter.
//
//   enqueueRun(input)
//     Gate 1: agent must be 'active' (killed/paused agents take no new runs).
//     Gate 2: triggers enabled? (kill switch flips this off workspace-wide).
//             Manual triggers bypass Gate 2 (a user-initiated run always fires
//             if the agent is active — Gate 2 is about auto-triggers).
//     Gate 3: concurrency cap — count active runs, reject if at cap.
//     Idempotency: same key within 10 min → return existing run id, no dup.
//     Insert: create the runs row with status='queued' + the idempotency key
//             + chain depth. A separate worker picks up queued runs + drives
//             them via runAgent (or runQueued, the resume-from-existing-row
//             path — a follow-up).
//     Return: the run id, or null if a gate denied the enqueue.
//
//   wireTriggers()
//     Subscribe to the facts stream. For each fact, find event triggers whose
//     config->>'event' matches the fact's kind. For each match, fire
//     enqueueRun with triggerType='event' + idempotencyKey = `${fact.id}:${trigger.id}`
//     (so an event fires each trigger at most once — the dedup window).
//
//   matchEventTriggers(fact)
//     Query agent_triggers where kind='event' AND enabled=true AND
//     config->>'event' = fact.kind. Returns [{ wsId, agentId, triggerId, idem }].
//
// CRITICAL: triggers are dispatched ONLY through this gate. The kill switch
// disables agent_triggers here (Gate 2 reads `enabled`), and budget/approval
// floors still apply (the worker that picks up the queued run calls runAgent,
// which holds budget + checks approvals per tool call).
//
// WEBHOOK TRIGGERS: HMAC-verified at the API route layer (POST /api/webhooks/:id),
// which calls enqueueRun with triggerType='webhook'. The HMAC verification is
// NOT in this module — it's the API route's responsibility (defense-in-depth:
// the route verifies the signature, the dispatcher trusts the caller). A future
// impl may move HMAC verification here if the dispatcher becomes the single
// entry point for webhooks (currently the route is the entry point).

import { db } from "@supa/db";
import { agents, runs, agentTriggers } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { facts, type Fact } from "../platform.js";
import type { PermissionSet } from "../permissions.js";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type TriggerType = "manual" | "schedule" | "event" | "webhook" | "chain";

export interface EnqueueRunInput {
  wsId: string;
  agentId: string;
  triggerType: TriggerType;
  /** Payload carried into the run (e.g. the triggering event's data). */
  triggerPayload?: unknown;
  /**
   * Idempotency key. Same key within 10 min → return existing run, no dup.
   * For event triggers: `${factId}:${triggerId}` (each event fires each
   * trigger at most once). For manual triggers: usually null (each click
   * is a distinct intent). For webhooks: the webhook's delivery id.
   */
  idempotencyKey?: string;
  /** a2a chain — the permission chain carried from the calling agent. */
  inheritedChain?: PermissionSet[];
  /** a2a chain depth (0 for direct, 1-3 for chained). */
  depth?: number;
}

export interface EnqueueRunResult {
  /** The run id, or null if a gate denied the enqueue. */
  runId: string | null;
  /** Why the enqueue was denied (for telemetry / UI feedback). */
  reason?: "agent_not_active" | "triggers_disabled" | "concurrency_cap" | "duplicate";
}

// ───────────────────────────────────────────────
// enqueueRun — 3 gates + idempotency + insert
// ───────────────────────────────────────────────

/**
 * Enqueue a run. All non-manual triggers MUST go through this gate (the kill
 * switch disables triggers here via Gate 2). Manual triggers bypass Gate 2
 * (a user-initiated run always fires if the agent is active — Gate 2 is about
 * auto-triggers, not user intent).
 *
 * The insert + idempotency check + concurrency count are in ONE transaction
 * (race-safe: two concurrent enqueues with the same key → only one wins,
 * the other gets the existing run id via the dedup check inside the tx).
 */
export async function enqueueRun(input: EnqueueRunInput): Promise<EnqueueRunResult> {
  return db.transaction(async (tx) => {
    // ─── Gate 1: agent must be active ─────────────────────
    const agentRows = await tx
      .select({
        id: agents.id,
        status: agents.status,
        maxConcurrentRuns: agents.maxConcurrentRuns,
      })
      .from(agents)
      .where(and(eq(agents.id, input.agentId as any), eq(agents.workspaceId, input.wsId as any)))
      .limit(1);
    const agent = agentRows[0];
    if (!agent || agent.status !== "active") {
      return { runId: null, reason: "agent_not_active" };
    }

    // ─── Gate 2: triggers enabled? (kill switch flips this off) ─────────
    // Manual triggers bypass Gate 2 — a user-initiated run always fires if
    // the agent is active. Gate 2 is about auto-triggers (schedule/event/
    // webhook), which the kill switch disables workspace-wide.
    if (input.triggerType !== "manual") {
      const triggerRows = await tx
        .select({ id: agentTriggers.id })
        .from(agentTriggers)
        .where(
          and(
            eq(agentTriggers.workspaceId, input.wsId as any),
            eq(agentTriggers.agentId, input.agentId as any),
            eq(agentTriggers.enabled, true),
          ),
        )
        .limit(1);
      if (!triggerRows.length) {
        return { runId: null, reason: "triggers_disabled" };
      }
    }

    // ─── Gate 3: concurrency cap ─────────────────────────
    // Count active runs (queued + running + awaiting_approval). If at cap,
    // emit a throttled fact + return null.
    const countRows = await tx
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, input.agentId as any),
          sql`${runs.status} in ('queued','running','awaiting_approval')`,
        ),
      );
    const activeCount = Number(countRows[0]?.n ?? 0);
    if (activeCount >= agent.maxConcurrentRuns) {
      // Emit OUTSIDE the transaction (best-effort; the gate decision is
      // already made — the fact is for telemetry, not for correctness).
      // We emit after the transaction returns to avoid blocking on the fact.
      queueMicrotask(() => {
        facts.emit(input.wsId, "agent.run.throttled", {
          agentId: input.agentId,
          active: activeCount,
          cap: agent.maxConcurrentRuns,
        }).catch(() => {/* best-effort */});
      });
      return { runId: null, reason: "concurrency_cap" };
    }

    // ─── Idempotency: same key within 10 min → return existing ─────────
    if (input.idempotencyKey) {
      const dupeRows = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, input.agentId as any),
            eq(runs.idempotencyKey, input.idempotencyKey),
            sql`${runs.createdAt} > now() - interval '10 minutes'`,
          ),
        )
        .limit(1);
      if (dupeRows[0]) {
        return { runId: dupeRows[0].id, reason: "duplicate" };
      }
    }

    // ─── Insert the queued run ───────────────────────────
    // The unique index on (agent_id, idempotency_key) where not null is the
    // race-safety backstop: if two concurrent transactions both pass the
    // dedup check (both see no existing row), only one insert wins; the other
    // throws unique-violation (caught below → re-read the existing row).
    try {
      const insertRows = await tx
        .insert(runs)
        .values({
          workspaceId: input.wsId as any,
          agentId: input.agentId as any,
          triggerType: input.triggerType,
          triggerPayload: (input.triggerPayload ?? {}) as any,
          idempotencyKey: input.idempotencyKey ?? null,
          chainDepth: input.depth ?? 0,
          agentSnapshot: {}, // populated by the worker when it picks up the run
          status: "queued",
          maxSteps: 40, // default; worker will use the agent's budget.maxStepsPerRun
          wallDeadline: new Date(Date.now() + 10 * 60 * 1000), // 10 min default
        })
        .returning({ id: runs.id });
      const run = insertRows[0];
      if (!run) {
        return { runId: null };
      }

      // Emit the queued fact OUTSIDE the transaction (best-effort).
      const runId = run.id;
      queueMicrotask(() => {
        facts.emit(input.wsId, "agent.run.queued", {
          runId,
          agentId: input.agentId,
          trigger: input.triggerType,
        }).catch(() => {/* best-effort */});
      });

      return { runId };
    } catch (err: any) {
      // 23505 = unique_violation on (agent_id, idempotency_key). A concurrent
      // enqueue with the same key beat us — re-read the existing row.
      if (err?.code === "23505" && input.idempotencyKey) {
        const dupeRows = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.agentId, input.agentId as any),
              eq(runs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (dupeRows[0]) {
          return { runId: dupeRows[0].id, reason: "duplicate" };
        }
      }
      throw err;
    }
  });
}

// ───────────────────────────────────────────────
// wireTriggers — subscribe to facts, match event triggers, enqueue
// ───────────────────────────────────────────────

/**
 * Wire event triggers to the facts stream. Call once at boot.
 *
 * For each emitted fact, find event triggers whose config->>'event' matches
 * the fact's kind. For each match, fire enqueueRun with:
 *   - triggerType: 'event'
 *   - triggerPayload: the fact itself (the agent's run can read what happened)
 *   - idempotencyKey: `${fact.id}:${trigger.id}` (each event fires each trigger
 *     at most once — the dedup window)
 *
 * The subscriber is best-effort: if enqueueRun throws (e.g. DB down), the
 * error is logged + the next fact is still processed. The fact is already
 * persisted (facts.emit writes to activity_facts before fanning out to
 * subscribers); a missed trigger fire is recoverable by replaying the fact
 * stream (a follow-up: a catch-up job that scans recent facts + fires any
 * triggers that didn't fire — the idempotency key makes this safe).
 *
 * Returns an unsubscribe function (for tests / shutdown).
 */
export function wireTriggers(): () => void {
  return facts.subscribe(async (fact) => {
    try {
      const matches = await matchEventTriggers(fact);
      await Promise.allSettled(
        matches.map((m) =>
          enqueueRun({
            wsId: m.wsId,
            agentId: m.agentId,
            triggerType: "event",
            triggerPayload: fact,
            idempotencyKey: m.idem,
          }),
        ),
      );
    } catch (err) {
      console.error("[wireTriggers] error matching fact:", fact.id, err);
    }
  });
}

// ───────────────────────────────────────────────
// matchEventTriggers — find triggers whose config->>'event' = fact.kind
// ───────────────────────────────────────────────

export interface EventTriggerMatch {
  wsId: string;
  agentId: string;
  triggerId: string;
  /** Idempotency key: `${factId}:${triggerId}` — each event fires each trigger at most once. */
  idem: string;
}

/**
 * Find event triggers whose config->>'event' matches the fact's kind.
 *
 * Queries agent_triggers where kind='event' AND enabled=true AND
 * config->>'event' = fact.kind. Returns one match per (wsId, agentId, triggerId).
 *
 * The idempotency key is `${fact.id}:${trigger.id}` — so the same event
 * firing the same trigger twice (e.g. a catch-up replay) is a no-op (the
 * dedup check in enqueueRun returns the existing run id).
 */
export async function matchEventTriggers(fact: Fact): Promise<EventTriggerMatch[]> {
  const rows = await db
    .select({
      wsId: agentTriggers.workspaceId,
      agentId: agentTriggers.agentId,
      triggerId: agentTriggers.id,
    })
    .from(agentTriggers)
    .where(
      and(
        eq(agentTriggers.enabled, true),
        eq(agentTriggers.kind, "event"),
        sql`${agentTriggers.config}->>'event' = ${fact.kind}`,
      ),
    );

  return rows.map((r) => ({
    wsId: r.wsId as string,
    agentId: r.agentId as string,
    triggerId: r.triggerId as string,
    idem: `${fact.id}:${r.triggerId}`,
  }));
}

// ───────────────────────────────────────────────
// createTrigger — for the agent settings UI
// ───────────────────────────────────────────────

export interface CreateTriggerInput {
  wsId: string;
  agentId: string;
  kind: "schedule" | "event" | "webhook";
  config: {
    cron?: string;
    event?: string;
    webhookUrl?: string;
    webhookSecretHash?: string;
  };
  enabled?: boolean;
}

/**
 * Create a trigger row. Used by the agent settings UI (POST /api/agents/:id/triggers).
 * The trigger starts enabled by default; the kill switch flips enabled=false
 * workspace-wide (and the user can re-enable individually after the kill
 * switch is disengaged).
 */
export async function createTrigger(input: CreateTriggerInput): Promise<{ id: string }> {
  const rows = await db
    .insert(agentTriggers)
    .values({
      workspaceId: input.wsId as any,
      agentId: input.agentId as any,
      kind: input.kind,
      config: input.config as any,
      enabled: input.enabled ?? true,
    })
    .returning({ id: agentTriggers.id });
  const row = rows[0];
  if (!row) throw new Error("trigger_insert_failed");
  return { id: row.id };
}

/**
 * Disable all triggers for a workspace — called by the kill switch.
 * Atomic single UPDATE (the kill switch's "triggers disabled" step, now
 * wired against the real agent_triggers table that landed in migration 0027).
 */
export async function disableTriggersForWorkspace(wsId: string): Promise<number> {
  const rows = await db
    .update(agentTriggers)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(agentTriggers.workspaceId, wsId as any),
        eq(agentTriggers.enabled, true),
      ),
    )
    .returning({ id: agentTriggers.id });
  return rows.length;
}
