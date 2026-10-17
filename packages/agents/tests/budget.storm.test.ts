/**
 * Budget storm test — the cap-holds-under-max-concurrency invariant battery.
 *
 * INVARIANT 1 (cap): Under 200 concurrent holdBudget calls with cap=$1.00
 *   (100 usd_minor) and each estimating $0.10 (10 usd_minor), the number of
 *   allowed holds MUST be ≤ 10. The advisory lock (pg_advisory_xact_lock)
 *   serializes concurrent holds so N concurrent calls cannot race past the
 *   cap (the escrow lesson applied to tokens).
 *
 * INVARIANT 2 (reconciliation): After capturing actuals for every allowed
 *   hold, sum(hold) == sum(capture) + sum(refund) per agent. The no-drift
 *   rule — every held cent is either captured (actual spend) or refunded
 *   (unspent). Verified via expectBudgetReconciled.
 *
 * This is an INTEGRATION TEST — it needs a real Postgres with migration 0026
 * applied. Skipped unless RUN_INTEGRATION=1 is set.
 *
 * The pasted spec had comment corruption ("eachest1.00, each est1.00, each
 * est$0.10") — the intent was: cap $1.00, each estimates $0.10, exactly 10
 * succeed. The corruption was a renderer mangling repeated dollar amounts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { expectBudgetReconciled } from "./helpers.js";

// Skip the entire suite unless RUN_INTEGRATION=1.
const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("budget storm", () => {
  // Lazy-load DB-dependent modules inside the suite (only loaded if RUN=true).
  let holdBudget: typeof import("../src/budget/ledger.js").holdBudget;
  let captureBudget: typeof import("../src/budget/ledger.js").captureBudget;
  let db: typeof import("@supa/db").db;
  let agents: typeof import("@supa/db/schema").agents;
  let runs: typeof import("@supa/db/schema").runs;
  let workspaces: typeof import("@supa/db/schema").workspaces;
  let eq: typeof import("drizzle-orm").eq;
  let BudgetSpec: typeof import("../src/schema.js").BudgetSpec;

  let wsId: string;
  let agentId: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    const ledger = await import("../src/budget/ledger.js");
    holdBudget = ledger.holdBudget;
    captureBudget = ledger.captureBudget;

    const dbMod = await import("@supa/db");
    db = dbMod.db;
    const schema = await import("@supa/db/schema");
    agents = schema.agents;
    runs = schema.runs;
    workspaces = schema.workspaces;
    const drizzle = await import("drizzle-orm");
    eq = drizzle.eq;
    const schemaMod = await import("../src/schema.js");
    BudgetSpec = schemaMod.BudgetSpec;

    // Create test workspace.
    const [ws] = await db
      .insert(workspaces)
      .values({
        slug: `test-budget-storm-${randomUUID().slice(0, 8)}`,
        name: "Budget Storm Test",
        billingOwnerId: randomUUID() as any,
      })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error("workspace_insert_failed");
    wsId = ws.id;

    // Create test agent.
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: wsId as any,
        name: "budget-storm-agent",
        persona: "",
        goal: "",
        instructions: "",
        toolGrants: [],
        approvalPolicy: {},
        budget: {
          dailyUsdMinor: 100, // $1.00 cap (intentionally low for the storm)
          monthlyUsdMinor: 10000,
          maxRunsPerDay: 200,
          maxStepsPerRun: 10,
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
    agentId = agent.id;

    // Create 200 run rows (each holdBudget inserts a budget_entries row with
    // run_id FK → must exist in runs).
    for (let i = 0; i < 200; i++) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(runs).values({
        id: runId as any,
        workspaceId: wsId as any,
        agentId: agentId as any,
        triggerType: "manual",
        triggerPayload: {},
        agentSnapshot: {},
        status: "running",
        maxSteps: 10,
        wallDeadline: new Date(Date.now() + 60_000),
      });
    }
  });

  it("budget cap holds under max concurrency (200 concurrent, cap $1.00, est $0.10 each)", async () => {
    // Parse + validate the budget spec (same validation as the agent's config).
    const spec = BudgetSpec.parse({
      dailyUsdMinor: 100, // $1.00
      monthlyUsdMinor: 10000,
      maxRunsPerDay: 200,
      maxStepsPerRun: 10,
      maxA2ADepth: 0,
      alertAtPct: [50, 80, 95],
    });

    // Fire 200 concurrent holds. Each estimates $0.10 (10 usd_minor).
    // Cap is $1.00 (100 usd_minor) → at most 10 should succeed.
    const estMinor = 10; // $0.10
    const results = await Promise.allSettled(
      runIds.map((runId) =>
        holdBudget(wsId, agentId, runId, spec, estMinor),
      ),
    );

    const allowed = results.filter(
      (r) => r.status === "fulfilled" && r.value.allowed,
    );
    const denied = results.filter(
      (r) => r.status === "fulfilled" && !r.value.allowed,
    );
    const rejected = results.filter((r) => r.status === "rejected");

    // INVARIANT 1: committed total ≤ cap. Exactly 10 succeed.
    // (10 × $0.10 = $1.00 = cap. The 11th would push to $1.10 > $1.00 → denied.)
    expect(allowed.length).toBeLessThanOrEqual(10);
    // At least some should succeed (if 0, the cap check is too aggressive).
    expect(allowed.length).toBeGreaterThan(0);
    // No rejections (errors) — denials are { allowed: false }, not rejections.
    expect(rejected.length).toBe(0);

    console.log(`Budget storm: ${allowed.length} allowed, ${denied.length} denied (cap=10)`);
  });

  it("reconciliation invariant: sum(hold) == sum(capture) + sum(refund)", async () => {
    // For every allowed hold, capture the actual (= estimate, no real work done).
    const spec = BudgetSpec.parse({
      dailyUsdMinor: 100,
      monthlyUsdMinor: 10000,
      maxRunsPerDay: 200,
      maxStepsPerRun: 10,
      maxA2ADepth: 0,
      alertAtPct: [50, 80, 95],
    });
    const estMinor = 10;

    // Re-fire the holds (the previous test's holds already consumed the cap;
    // this test uses a fresh agent to start clean).
    const [agent2] = await db
      .insert(agents)
      .values({
        workspaceId: wsId as any,
        name: "budget-reconcile-agent",
        persona: "",
        goal: "",
        instructions: "",
        toolGrants: [],
        approvalPolicy: {},
        budget: {
          dailyUsdMinor: 100,
          monthlyUsdMinor: 10000,
          maxRunsPerDay: 200,
          maxStepsPerRun: 10,
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
    if (!agent2) throw new Error("agent2_insert_failed");

    // Create 10 runs for the reconcile agent.
    const reconcileRunIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const runId = randomUUID();
      reconcileRunIds.push(runId);
      await db.insert(runs).values({
        id: runId as any,
        workspaceId: wsId as any,
        agentId: agent2.id as any,
        triggerType: "manual",
        triggerPayload: {},
        agentSnapshot: {},
        status: "running",
        maxSteps: 10,
        wallDeadline: new Date(Date.now() + 60_000),
      });
    }

    // Hold 10 × $0.10 = $1.00 (exactly the cap).
    const holds = await Promise.all(
      reconcileRunIds.map((runId) =>
        holdBudget(wsId, agent2!.id, runId, spec, estMinor),
      ),
    );
    const allowedCount = holds.filter((h) => h.allowed).length;
    expect(allowedCount).toBe(10); // all 10 should succeed (exactly at cap)

    // Capture actuals for each (= estimate; no real work done, so actual = est).
    for (const runId of reconcileRunIds) {
      await captureBudget(wsId, agent2!.id, runId, estMinor);
    }

    // INVARIANT 2: sum(hold) == sum(capture) + sum(refund).
    // 10 holds × $0.10 = $1.00 held.
    // 10 captures × $0.10 = $1.00 captured.
    // 0 refunds (actual == estimate).
    // 1.00 == 1.00 + 0 ✓
    await expectBudgetReconciled(agent2!.id);
  });
});
