// Test helpers shared across the three invariant batteries.
//
//   generateFuzzCases — seeded PRNG produces n fuzz cases (reproducible).
//   makeTool          — minimal ToolDef stub (canInvoke only uses id + requiredPermission).
//   makePerms         — convenience SetPermissionSet constructor.
//   waitFor           — poll-until-true with timeout.
//   expectBudgetReconciled — queries budget_entries + asserts sum(hold) = sum(capture) + sum(refund).
//                            (DB-dependent — only called from integration tests.)

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  canInvoke,
  SetPermissionSet,
  type ToolDef,
  type PermissionSet,
} from "../src/permissions.js";
import type { ToolClass, ApprovalPolicy } from "../src/schema.js";

// ───────────────────────────────────────────────
// Seeded PRNG (mulberry32) — deterministic fuzz cases.
// ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────
// Tool / perm stubs
// ───────────────────────────────────────────────

/** Minimal ToolDef stub. canInvoke only reads `id` + `requiredPermission`. */
export function makeTool(id: string, requiredPermission: string): ToolDef {
  return {
    id,
    cls: "read_only" as ToolClass,
    description: "",
    inputSchema: z.any(),
    requiredPermission,
    defaultApproval: "never_ask_but_log" as ApprovalPolicy,
    timeoutMs: 5000,
  };
}

/** Convenience: wrap a string[] into a SetPermissionSet. */
export function makePerms(perms: string[]): PermissionSet {
  return new SetPermissionSet(perms);
}

// ───────────────────────────────────────────────
// Fuzz case generator
// ───────────────────────────────────────────────

export interface FuzzCase {
  tool: ToolDef;
  grants: string[];
  grantorPerms: PermissionSet;
  chainPerms: PermissionSet[];
}

/**
 * Generate n fuzz cases for the privilege escalation property test.
 *
 * Cases are generated from a seeded PRNG (mulberry32, seed=42) so the test
 * is reproducible — if a violation is found, the same seed reproduces it.
 *
 * Distribution (tuned for ~40% allowed rate, good mix of allowed/denied):
 *   - 70% chance the tool's id is in grants (30% denied: tool_not_granted).
 *   - 70% chance the grantor has the requiredPermission (30% denied: missing).
 *   - 0-3 chain members, each 70% chance to have the requiredPermission.
 *   - Chain of length N with all perms: 0.7^N chance. For N=3: ~34%.
 *   - Overall allowed rate ≈ 0.7 × 0.7 × 0.7^avg_chain_len ≈ 0.7 × 0.7 × 0.7^1.5 ≈ 29%.
 *
 * NOTE: For 1M+ cases, use `forEachFuzzCase` (streaming) instead of
 * `generateFuzzCases` (materializes the full array — OOMs at ~1M).
 */
export function generateFuzzCases(n: number, seed = 42): FuzzCase[] {
  const rng = mulberry32(seed);
  const cases: FuzzCase[] = [];

  for (let i = 0; i < n; i++) {
    cases.push(generateOneFuzzCase(rng));
  }

  return cases;
}

/**
 * Streaming fuzz case generator — calls `fn(tc)` for each of `n` cases
 * without materializing the full array. Used for 1M+ case tests where
 * holding all cases in memory would OOM.
 */
export function forEachFuzzCase(
  n: number,
  fn: (tc: FuzzCase, i: number) => void,
  seed = 42,
): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    fn(generateOneFuzzCase(rng), i);
  }
}

/** Generate a single fuzz case from a PRNG. */
function generateOneFuzzCase(rng: () => number): FuzzCase {
  // 10 possible tool ids + 10 possible perms (small space → collisions →
  // realistic distribution).
  const toolId = `tool_${Math.floor(rng() * 10)}`;
  const requiredPerm = `perm_${Math.floor(rng() * 10)}`;
  const tool = makeTool(toolId, requiredPerm);

  // Grants: 70% chance to include the tool's id. Add some random others.
  const grants: string[] = [];
  if (rng() > 0.3) grants.push(toolId);
  for (let j = 0; j < 5; j++) {
    if (rng() > 0.5) grants.push(`tool_${j}`);
  }

  // Grantor perms: 70% chance to include the required perm.
  const grantorPermsList: string[] = [];
  if (rng() > 0.3) grantorPermsList.push(requiredPerm);
  for (let j = 0; j < 5; j++) {
    if (rng() > 0.5) grantorPermsList.push(`perm_${j}`);
  }
  const grantorPerms = makePerms(grantorPermsList);

  // Chain: 0-3 PermissionSets, each 70% chance to include the required perm.
  const chainLen = Math.floor(rng() * 4);
  const chainPerms: PermissionSet[] = [];
  for (let j = 0; j < chainLen; j++) {
    const chainPermsList: string[] = [];
    if (rng() > 0.3) chainPermsList.push(requiredPerm);
    for (let k = 0; k < 5; k++) {
      if (rng() > 0.5) chainPermsList.push(`perm_${k}`);
    }
    chainPerms.push(makePerms(chainPermsList));
  }

  return { tool, grants, grantorPerms, chainPerms };
}

// ───────────────────────────────────────────────
// waitFor — poll-until-true with timeout
// ───────────────────────────────────────────────

/**
 * Poll `fn` until it returns true, or throw after `timeoutMs`.
 * Used by the killswitch test to poll for runs reaching terminal status.
 */
export async function waitFor(
  fn: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms`);
}

// ───────────────────────────────────────────────
// expectBudgetReconciled — DB-dependent, only called from integration tests
// ───────────────────────────────────────────────

/**
 * Assert the budget reconciliation invariant for an agent:
 *   sum(hold) == sum(capture) + sum(refund)
 *
 * This is the "no-drift" rule — every held cent is either captured (actual
 * spend) or refunded (unspent). The budget storm test asserts this after
 * chaos injection (200 concurrent holds + captures).
 *
 * DB-dependent: only called from integration tests (budget.storm.test.ts).
 */
export async function expectBudgetReconciled(agentId: string): Promise<void> {
  // Dynamic import — this module transitively imports @supa/db.
  const { db } = await import("@supa/db");
  const { budgetEntries } = await import("@supa/db/schema");
  const { eq, sql } = await import("drizzle-orm");

  const result = await db
    .select({
      held: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'hold' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      captured: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'capture' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      refunded: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'refund' then ${budgetEntries.usdMinor} else 0 end), 0)`,
    })
    .from(budgetEntries)
    .where(eq(budgetEntries.agentId, agentId as any));

  const held = Number(result[0]?.held ?? 0);
  const captured = Number(result[0]?.captured ?? 0);
  const refunded = Number(result[0]?.refunded ?? 0);

  // THE INVARIANT: sum(hold) == sum(capture) + sum(refund)
  expect(held).toBe(captured + refunded);
}

// ───────────────────────────────────────────────
// Re-export test primitives so test files can import from one place.
// ───────────────────────────────────────────────

export { describe, it, expect, canInvoke };
