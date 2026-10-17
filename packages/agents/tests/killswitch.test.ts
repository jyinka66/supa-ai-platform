/**
 * Kill switch test — the 60-second invariant battery.
 *
 * INVARIANT: killSwitch(wsId, owner) must halt all running agents + queued/
 * running runs within 60 seconds wall-clock.
 *
 *   1. Engage kill switch.
 *   2. Poll: count of runs with status in ('queued','running') must reach 0.
 *   3. Assert elapsed < 60_000 ms.
 *
 * The kill switch atomically updates agents → 'killed' + runs → 'cancelled'
 * in a single transaction. The poll should reach 0 almost immediately (the
 * transaction is one round-trip). The 60s is the SLO, not the expected time.
 *
 * This is an INTEGRATION TEST — it needs a real Postgres with migration 0026
 * applied. Skipped unless RUN_INTEGRATION=1 is set.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("kill switch", () => {
  let killSwitch: typeof import("../src/killswitch.js").killSwitch;
  let db: typeof import("@supa/db").db;
  let agents: typeof import("@supa/db/schema").agents;
  let runs: typeof import("@supa/db/schema").runs;
  let workspaces: typeof import("@supa/db/schema").workspaces;
  let eq: typeof import("drizzle-orm").eq;
  let and: typeof import("drizzle-orm").and;
  let inArray: typeof import("drizzle-orm").inArray;
  let sql: typeof import("drizzle-orm").sql;

  let wsId: string;
  let agentIds: string[] = [];
  const NUM_AGENTS = 50;

  beforeAll(async () => {
    const ks = await import("../src/killswitch.js");
    killSwitch = ks.killSwitch;

    const dbMod = await import("@supa/db");
    db = dbMod.db;
    const schema = await import("@supa/db/schema");
    agents = schema.agents;
    runs = schema.runs;
    workspaces = schema.workspaces;
    const drizzle = await import("drizzle-orm");
    eq = drizzle.eq;
    and = drizzle.and;
    inArray = drizzle.inArray;
    sql = drizzle.sql;

    // Create test workspace.
    const [ws] = await db
      .insert(workspaces)
      .values({
        slug: `test-killswitch-${randomUUID().slice(0, 8)}`,
        name: "Kill Switch Test",
        billingOwnerId: randomUUID() as any,
      })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error("workspace_insert_failed");
    wsId = ws.id;

    // Create 50 agents in 'active' status.
    for (let i = 0; i < NUM_AGENTS; i++) {
      const [agent] = await db
        .insert(agents)
        .values({
          workspaceId: wsId as any,
          name: `killswitch-agent-${i}`,
          persona: "",
          goal: "",
          instructions: "",
          toolGrants: [],
          approvalPolicy: {},
          budget: {
            dailyUsdMinor: 200,
            monthlyUsdMinor: 2000,
            maxRunsPerDay: 20,
            maxStepsPerRun: 20,
            maxA2ADepth: 0,
            alertAtPct: [50, 80, 95],
          },
          status: "active",
          visibility: "private",
          locale: "en",
          configVersion: 1,
          createdBy: randomUUID() as any,
        })
        .returning({ id: agents.id });
      if (!agent) throw new Error("agent_insert_failed");
      agentIds.push(agent.id);

      // Create a 'running' run for each agent.
      await db.insert(runs).values({
        workspaceId: wsId as any,
        agentId: agent.id as any,
        triggerType: "manual",
        triggerPayload: {},
        agentSnapshot: {},
        status: "running",
        maxSteps: 20,
        wallDeadline: new Date(Date.now() + 5 * 60_000),
      });
    }
  });

  it("kill switch halts everything within 60s", async () => {
    const t0 = Date.now();

    // Engage the kill switch.
    const result = await killSwitch({
      wsId,
      byUserId: randomUUID(),
      callerRole: "owner",
    });

    expect(result.sloViolated).toBe(false);

    // Poll: count of runs with status in ('queued','running') must reach 0.
    await waitFor(
      async () => {
        const rows = await db
          .select({ count: sql<number>`count(*)` })
          .from(runs)
          .where(
            and(
              eq(runs.workspaceId, wsId as any),
              inArray(runs.status, ["queued", "running"]),
            ),
          );
        const count = Number(rows[0]?.count ?? 0);
        return count === 0;
      },
      { timeoutMs: 60_000, intervalMs: 200 },
    );

    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(60_000);

    console.log(`Kill switch halted ${NUM_AGENTS} agents in ${elapsed}ms`);

    // Verify all agents are 'killed'.
    const killedAgents = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, wsId as any),
          eq(agents.status, "killed"),
        ),
      );
    expect(Number(killedAgents[0]?.count ?? 0)).toBe(NUM_AGENTS);

    // Verify all runs are 'cancelled'.
    const cancelledRuns = await db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, wsId as any),
          eq(runs.status, "cancelled"),
        ),
      );
    expect(Number(cancelledRuns[0]?.count ?? 0)).toBe(NUM_AGENTS);
  });
});
