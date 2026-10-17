/**
 * Fuzz privilege test — the no-privilege-escalation invariant battery.
 *
 * INVARIANT: if canInvoke returns ok=true, then:
 *   1. tool.id is in agentGrants (the tool was explicitly granted).
 *   2. grantorPerms.allows(tool.requiredPermission) (the grantor has the perm).
 *   3. Every p in chainPerms: p.allows(tool.requiredPermission) (transitive chain).
 *
 * If any condition fails but gate.ok is true → PRIVILEGE ESCALATION BUG.
 *
 * This test runs 1,000,000 fuzzed cases with a fast path (no per-case expect;
 * violations are collected + asserted at the end). The seeded PRNG (mulberry32,
 * seed=42) makes the test reproducible — if a violation is found, the same
 * seed reproduces it.
 *
 * Permission revocation is checked LIVE per call: a fuzz case where the
 * grantor's permission set is missing the requiredPermission (simulating a
 * mid-run revocation) must deny the call. This is the "live check, every call,
 * never trusts stored config" rule from the executor.
 *
 * This is a PURE UNIT TEST — no DB, no mocks, no I/O. It runs in <2s.
 */

import { describe, it, expect } from "vitest";
import {
  canInvoke,
  forEachFuzzCase,
  type FuzzCase,
} from "./helpers.js";

describe("privilege escalation fuzz", () => {
  it("no privilege escalation under 1M fuzzed cases", () => {
    let violations = 0;
    let firstViolation: FuzzCase | null = null;
    let allowedCount = 0;
    let deniedCount = 0;

    // Streaming: generate + check one at a time (no array materialized).
    forEachFuzzCase(1_000_000, (tc) => {
      const gate = canInvoke(tc.tool, tc.grants, tc.grantorPerms, tc.chainPerms);

      if (gate.ok) {
        allowedCount++;
        // INVARIANT: every allowed call must be justified by the full chain.
        const toolGranted = tc.grants.includes(tc.tool.id);
        const grantorHasPerm = tc.grantorPerms.allows(tc.tool.requiredPermission);
        const chainAllHavePerm = tc.chainPerms.every(
          (p) => p.allows(tc.tool.requiredPermission),
        );

        if (!toolGranted || !grantorHasPerm || !chainAllHavePerm) {
          violations++;
          if (!firstViolation) firstViolation = tc;
        }
      } else {
        deniedCount++;
      }
    });

    if (violations > 0) {
      const tc = firstViolation!;
      console.error("First violation:", {
        toolId: tc.tool.id,
        requiredPermission: tc.tool.requiredPermission,
        grants: tc.grants,
        grantorPermsAllows: tc.grantorPerms.allows(tc.tool.requiredPermission),
        chainPermsAllow: tc.chainPerms.map((p) =>
          p.allows(tc.tool.requiredPermission),
        ),
      });
    }
    expect(violations).toBe(0);
  });

  it("canInvoke denies when tool not granted", () => {
    const tool = { id: "t1", requiredPermission: "p1" } as any;
    const gate = canInvoke(tool, [], { allows: () => true } as any, []);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("tool_not_granted");
  });

  it("canInvoke denies when grantor lacks permission (mid-run revocation)", () => {
    // Simulates: grantor's permission was REVOKED mid-run.
    // The live check (per-call, not per-config) catches this.
    const tool = { id: "t1", requiredPermission: "p1" } as any;
    const grantorPermsRevoked = { allows: () => false } as any; // perm revoked
    const gate = canInvoke(tool, ["t1"], grantorPermsRevoked, []);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("permission_missing");
  });

  it("canInvoke denies when any chain member lacks permission", () => {
    const tool = { id: "t1", requiredPermission: "p1" } as any;
    const grantorPerms = { allows: () => true } as any;
    const chainComplete = [{ allows: () => true } as any, { allows: () => true } as any];
    const chainWithGap = [{ allows: () => true } as any, { allows: () => false } as any];

    // Full chain → allowed
    expect(canInvoke(tool, ["t1"], grantorPerms, chainComplete).ok).toBe(true);
    // Chain with one gap → denied (the intersection rule)
    expect(canInvoke(tool, ["t1"], grantorPerms, chainWithGap).ok).toBe(false);
  });

  it("canInvoke allows when grants + grantor + full chain all present", () => {
    const tool = { id: "t1", requiredPermission: "p1" } as any;
    const grantorPerms = { allows: () => true } as any;
    const chain = [{ allows: () => true } as any, { allows: () => true } as any];
    const gate = canInvoke(tool, ["t1", "t2"], grantorPerms, chain);
    expect(gate.ok).toBe(true);
    expect(gate.reason).toBeUndefined();
  });

  it("canInvoke with empty chain (no a2a) only checks grantor", () => {
    const tool = { id: "t1", requiredPermission: "p1" } as any;
    const grantorPerms = { allows: () => true } as any;
    const gate = canInvoke(tool, ["t1"], grantorPerms, []);
    expect(gate.ok).toBe(true);
  });
});
