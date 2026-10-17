// Kill switch — the 60-second invariant.
//
// Workspace kill switch. Triggered from workspace settings (owner/admin).
// Within 60 seconds wall-clock, agent-side, measured:
//   1. All agents → status='killed' (single UPDATE, workspace-scoped)
//   2. All queued/running/awaiting_approval runs → cancelled; the executor
//      loop observes runs.cancelled_at each step (added to driveLoop) and
//      returns { kind: 'failed', reason: 'cancelled' } on the next iteration
//   3. Triggers (schedules/webhooks) disabled at the dispatch gate — SKIPPED
//      here because agent_triggers table doesn't exist yet (follow-up); a fact
//      is emitted recording the skip so the audit trail is honest
//   4. Notification to owners + fact stream entry for the audit trail
//
// The 60s invariant is measured: wall-clock from start to finish, emitted in
// the fact stream. If it exceeds 60s, an alert fact is emitted (the operator
// needs to know the invariant was violated — this is the kill switch's own
// SLO).
//
// Idempotency: if nothing actually changed (no agents were already active, no
// runs were already queued), the facts + notify are NOT re-fired (avoids
// spamming owners on a double-click or retry).

import { db } from "@supa/db";
import { agents, runs, agentTriggers } from "@supa/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { facts, notify } from "./platform.js";

/** The kill switch's SLO. If the wall-clock exceeds this, an alert fires. */
const KILL_SWITCH_SLO_MS = 60 * 1000;

/** Roles allowed to engage the kill switch. */
const ALLOWED_ROLES = ["owner", "admin"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

export interface KillSwitchInput {
  wsId: string;
  byUserId: string;
  /** Caller's role in the workspace — asserted to be owner/admin (defense-in-depth;
   *  the API route is the real gate via `can(scope, "settings.update", ...)`). */
  callerRole: string;
}

export interface KillSwitchResult {
  /** Wall-clock ms from start to finish. Emitted in the fact stream. */
  elapsedMs: number;
  /** Number of agents transitioned to 'killed'. */
  agentsKilled: number;
  /** Number of runs transitioned to 'cancelled'. */
  runsCancelled: number;
  /** Number of triggers transitioned to disabled. */
  triggersDisabled: number;
  /** Whether the 60s SLO was violated. */
  sloViolated: boolean;
  /** Whether this was a no-op (nothing to kill — idempotency guard). */
  noOp: boolean;
}

/**
 * Engage the workspace kill switch. Atomic agents → killed + runs → cancelled
 * in a single transaction (the two UPDATEs are coupled — a run can't reference
 * a killed agent, so the agents + runs transitions must be atomic).
 *
 * The 60s wall-clock is measured; if exceeded, an alert fact is emitted.
 *
 * Triggers-disable is wired against the agent_triggers table (migration 0027).
 * It's the third UPDATE inside the transaction: agents → killed, runs →
 * cancelled, triggers → disabled. All three are atomic — a killed workspace
 * has no active agents, no running runs, AND no enabled triggers.
 *
 * Idempotent: if nothing changed (no active agents, no queued runs, no enabled
 * triggers), the facts + notify are NOT re-fired (avoids owner spam on
 * double-click / retry).
 */
export async function killSwitch(input: KillSwitchInput): Promise<KillSwitchResult> {
  // Defense-in-depth: assert the caller's role. The API route is the real
  // gate (via workspace-core's can()), but this assertion means a caller that
  // forgot the gate fails loudly here, not silently.
  if (!ALLOWED_ROLES.includes(input.callerRole as AllowedRole)) {
    throw new Error(`kill_switch_unauthorized:${input.callerRole}`);
  }

  const start = Date.now();

  // Atomic: agents → killed + runs → cancelled + triggers → disabled in ONE
  // transaction. The three UPDATEs are coupled — a killed workspace has no
  // active agents, no running runs, AND no enabled triggers.
  const { agentsKilled, runsCancelled, triggersDisabled } = await db.transaction(async (tx) => {
    // 1. Agents → killed. Only agents that aren't already killed (idempotency:
    // a second call is a no-op on already-killed agents).
    const killedAgents = await tx
      .update(agents)
      .set({ status: "killed", updatedAt: new Date() })
      .where(
        and(
          eq(agents.workspaceId, input.wsId as any),
          inArray(agents.status, ["draft", "active", "paused"]),
        ),
      )
      .returning({ id: agents.id });

    // 2. Runs → cancelled. Only queued/running/awaiting_approval runs.
    const cancelledRuns = await tx
      .update(runs)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        finishedAt: new Date(),
        failureReason: "kill_switch_engaged",
      })
      .where(
        and(
          eq(runs.workspaceId, input.wsId as any),
          inArray(runs.status, ["queued", "running", "awaiting_approval"]),
        ),
      )
      .returning({ id: runs.id });

    // 3. Triggers → disabled. Only enabled triggers (idempotency: a second
    // call is a no-op on already-disabled triggers).
    const disabledTriggers = await tx
      .update(agentTriggers)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(agentTriggers.workspaceId, input.wsId as any),
          eq(agentTriggers.enabled, true),
        ),
      )
      .returning({ id: agentTriggers.id });

    return {
      agentsKilled: killedAgents.length,
      runsCancelled: cancelledRuns.length,
      triggersDisabled: disabledTriggers.length,
    };
  });

  const elapsedMs = Date.now() - start;
  const sloViolated = elapsedMs > KILL_SWITCH_SLO_MS;
  const noOp = agentsKilled === 0 && runsCancelled === 0 && triggersDisabled === 0;

  // 4. Facts + notify. Only fire if something changed (idempotency guard —
  //    a no-op call doesn't re-notify owners).
  if (!noOp) {
    // The kill event itself — carries the elapsed time + counts for the audit trail.
    await facts.emit(input.wsId, "agent.killswitch.engaged", {
      byUserId: input.byUserId,
      callerRole: input.callerRole,
      elapsedMs,
      agentsKilled,
      runsCancelled,
      triggersDisabled,
      sloViolated,
    });

    // SLO violation alert — emitted as a SEPARATE fact so a downstream alerting
    // rule can subscribe to 'agent.killswitch.slo_violated' without parsing
    // the engaged event's payload.
    if (sloViolated) {
      await facts.emit(input.wsId, "agent.killswitch.slo_violated", {
        byUserId: input.byUserId,
        elapsedMs,
        sloMs: KILL_SWITCH_SLO_MS,
      });
    }

    // Notify owners via the matrix (in_app + email).
    await notify.send("in_app", {
      wsId: input.wsId,
      kind: "agent.killed",
      byUserId: input.byUserId,
      agentsKilled,
      runsCancelled,
      triggersDisabled,
      channels: ["in_app", "email"],
    });
    await notify.send("email", {
      wsId: input.wsId,
      kind: "agent.killed",
      byUserId: input.byUserId,
      agentsKilled,
      runsCancelled,
      triggersDisabled,
    });
  } else {
    // No-op: emit a low-key "engaged_noop" fact so the audit trail records
    // that the kill switch was triggered but had nothing to do. Operators
    // can use this to detect "I hit the kill switch and nothing happened"
    // scenarios (e.g. agents were already killed by a prior call).
    await facts.emit(input.wsId, "agent.killswitch.engaged_noop", {
      byUserId: input.byUserId,
      elapsedMs,
    });
  }

  return {
    elapsedMs,
    agentsKilled,
    runsCancelled,
    triggersDisabled,
    sloViolated,
    noOp,
  };
}
