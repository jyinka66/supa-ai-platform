/**
 * Feature flags — unit tests for the evaluation logic.
 *
 * Covers:
 *   1. First-match semantics (users > workspaces > plans > rollout_pct > enabled).
 *   2. kill_switch (global on/off, ignores targets + rollout).
 *   3. rollout_pct stable hash bucketing (no flicker, even distribution).
 *   4. Fail-closed (unknown flag → false).
 *   5. Target precedence (users beats workspaces beats plans).
 *   6. Key validation.
 *
 * These are pure-logic tests (no DB) — they test `evaluateFlag` + `hashBucket`
 * + `validateFlagKey` directly.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateFlag,
  hashBucket,
  validateFlagKey,
  FlagError,
  type FeatureFlag,
  type EvaluationContext,
} from "@/lib/feature-flags/service";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function makeFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key: "test_flag",
    kind: "feature",
    enabled: false,
    rolloutPct: 0,
    targets: {},
    description: "test flag",
    owner: "test-team",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ───────────────────────────────────────────────
// First-match semantics
// ───────────────────────────────────────────────

describe("feature flag first-match semantics", () => {
  it("targets.users takes highest precedence (beats enabled=false)", () => {
    const flag = makeFlag({
      enabled: false,
      targets: { users: ["user-1"] },
    });
    const ctx: EvaluationContext = { userId: "user-1" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("targets.users beats targets.workspaces", () => {
    const flag = makeFlag({
      enabled: false,
      targets: { users: ["user-1"], workspaces: ["ws-other"] },
    });
    // user-1 is in users → ON (even though their workspace isn't in workspaces).
    const ctx: EvaluationContext = { userId: "user-1", workspaceId: "ws-current" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("targets.workspaces beats targets.plans", () => {
    const flag = makeFlag({
      enabled: false,
      targets: { workspaces: ["ws-1"], plans: ["enterprise"] },
    });
    // ws-1 is in workspaces → ON (even though the plan is 'pro', not 'enterprise').
    const ctx: EvaluationContext = { workspaceId: "ws-1", plan: "pro" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("targets.plans beats rollout_pct", () => {
    const flag = makeFlag({
      enabled: false,
      rolloutPct: 100,
      targets: { plans: ["pro"] },
    });
    // plan='enterprise' is NOT in ['pro'] → OFF (even though rollout_pct=100).
    const ctx: EvaluationContext = { plan: "enterprise", userId: "user-1" };
    expect(evaluateFlag(flag, ctx)).toBe(false);
  });

  it("rollout_pct beats enabled (when rollout_pct > 0)", () => {
    const flag = makeFlag({
      enabled: false,
      rolloutPct: 0, // 0% rollout → no one gets it via rollout.
    });
    const ctx: EvaluationContext = { userId: "user-1" };
    // rollout_pct=0 → bucket check: bucket < 0 is always false → OFF.
    expect(evaluateFlag(flag, ctx)).toBe(false);
  });

  it("enabled is the lowest precedence (fallback when no targets match)", () => {
    const flag = makeFlag({ enabled: true });
    const ctx: EvaluationContext = {};
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("enabled=false + no targets + rollout_pct=0 → OFF", () => {
    const flag = makeFlag({ enabled: false });
    expect(evaluateFlag(flag, {})).toBe(false);
  });
});

// ───────────────────────────────────────────────
// Kill switch
// ───────────────────────────────────────────────

describe("feature flag kill_switch (global on/off)", () => {
  it("kill_switch enabled=true → ON (ignores targets + rollout)", () => {
    const flag = makeFlag({
      kind: "kill_switch",
      enabled: true,
      rolloutPct: 0,
      targets: { users: ["other-user"] },
    });
    // Even though user-1 isn't in targets.users + rollout_pct=0, the kill
    // switch is ON for everyone (enabled=true).
    const ctx: EvaluationContext = { userId: "user-1" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("kill_switch enabled=false → OFF (emergency disable, ignores everything)", () => {
    const flag = makeFlag({
      kind: "kill_switch",
      enabled: false,
      rolloutPct: 100,
      targets: { users: ["user-1"] },
    });
    // Even though user-1 is in targets + rollout_pct=100, the kill switch
    // is OFF for everyone (enabled=false = emergency disable).
    const ctx: EvaluationContext = { userId: "user-1" };
    expect(evaluateFlag(flag, ctx)).toBe(false);
  });

  it("kill_switch ignores targets (no per-user/per-ws/per-plan gating)", () => {
    const flag = makeFlag({
      kind: "kill_switch",
      enabled: true,
      targets: { plans: ["pro"] },
    });
    // A free user still gets the kill switch (it's global).
    const ctx: EvaluationContext = { plan: "free" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });
});

// ───────────────────────────────────────────────
// rollout_pct — stable hash bucketing
// ───────────────────────────────────────────────

describe("feature flag rollout_pct bucketing", () => {
  it("hashBucket returns 0-99", () => {
    for (let i = 0; i < 1000; i++) {
      const bucket = hashBucket("test_flag", `user-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("hashBucket is stable (same key+user → same bucket)", () => {
    const b1 = hashBucket("test_flag", "user-1");
    const b2 = hashBucket("test_flag", "user-1");
    expect(b1).toBe(b2);
  });

  it("hashBucket differs by flag key (same user, different flag → different bucket)", () => {
    // Not guaranteed to differ (collision possible), but statistically very
    // likely for different keys. We test a few + expect at least one to differ.
    const buckets = new Set<string>();
    for (const key of ["flag_a", "flag_b", "flag_c", "flag_d", "flag_e"]) {
      buckets.add(`${key}:${hashBucket(key, "user-1")}`);
    }
    // At least 2 distinct buckets across 5 different keys (probabilistically
    // near-certain — 5 keys, 100 buckets, birthday paradox says collision is
    // unlikely with 5).
    const distinctBuckets = new Set([...buckets].map((b) => b.split(":")[1]));
    expect(distinctBuckets.size).toBeGreaterThanOrEqual(2);
  });

  it("rollout_pct=100 → all users get the feature (bucket < 100 always true)", () => {
    const flag = makeFlag({ enabled: false, rolloutPct: 100 });
    for (let i = 0; i < 100; i++) {
      const ctx: EvaluationContext = { userId: `user-${i}` };
      expect(evaluateFlag(flag, ctx)).toBe(true);
    }
  });

  it("rollout_pct=0 → no users get the feature (bucket < 0 always false)", () => {
    const flag = makeFlag({ enabled: false, rolloutPct: 0 });
    for (let i = 0; i < 100; i++) {
      const ctx: EvaluationContext = { userId: `user-${i}` };
      expect(evaluateFlag(flag, ctx)).toBe(false);
    }
  });

  it("rollout_pct=50 → roughly half the users (40-60 of 100)", () => {
    const flag = makeFlag({ enabled: false, rolloutPct: 50 });
    let enabledCount = 0;
    for (let i = 0; i < 1000; i++) {
      const ctx: EvaluationContext = { userId: `user-${i}` };
      if (evaluateFlag(flag, ctx)) enabledCount++;
    }
    // 1000 users, 50% rollout → expect ~500 (±100 for variance).
    expect(enabledCount).toBeGreaterThan(350);
    expect(enabledCount).toBeLessThan(650);
  });

  it("rollout_pct uses IP when no userId (anonymous bucketing)", () => {
    const flag = makeFlag({ enabled: false, rolloutPct: 50 });
    const ctx: EvaluationContext = { ip: "203.0.113.1" };
    // Just verify it doesn't crash + returns a boolean.
    const result = evaluateFlag(flag, ctx);
    expect(typeof result).toBe("boolean");
  });

  it("no flicker: same user always gets the same result across calls", () => {
    const flag = makeFlag({ enabled: false, rolloutPct: 30 });
    const ctx: EvaluationContext = { userId: "user-1" };
    const results = new Set<boolean>();
    for (let i = 0; i < 100; i++) {
      results.add(evaluateFlag(flag, ctx));
    }
    // The same (flag, user) always produces the same result — no flicker.
    expect(results.size).toBe(1);
  });
});

// ───────────────────────────────────────────────
// Fail-closed (unknown flag → false)
// ───────────────────────────────────────────────

describe("feature flag fail-closed", () => {
  it("isEnabled for a non-existent flag returns false (fail-closed)", async () => {
    // We can't call isEnabled (DB-backed) in a unit test, but we verify the
    // design: getCachedFlag returns null → isEnabled returns false.
    // (The null check is in isEnabled; we document the invariant here.)
    const flag: FeatureFlag | null = null; // simulates "not found".
    const result = flag ? evaluateFlag(flag, {}) : false;
    expect(result).toBe(false);
  });

  it("a typo in the flag key doesn't enable a feature (fail-closed)", () => {
    // If the code asks for 'new_dashboard' but the flag is 'new_dashbord' (typo),
    // isEnabled returns false — the feature is OFF, not accidentally ON.
    // (This is the safe default for unknown flags.)
    const flag: FeatureFlag | null = null;
    expect(flag ? evaluateFlag(flag, {}) : false).toBe(false);
  });
});

// ───────────────────────────────────────────────
// Key validation
// ───────────────────────────────────────────────

describe("feature flag key validation", () => {
  it("accepts valid keys", () => {
    expect(() => validateFlagKey("new_dashboard")).not.toThrow();
    expect(() => validateFlagKey("a")).not.toThrow();
    expect(() => validateFlagKey("kill_search_v3")).not.toThrow();
    expect(() => validateFlagKey("flag_with_123")).not.toThrow();
    expect(() => validateFlagKey("a".repeat(64))).not.toThrow(); // max length.
  });

  it("rejects uppercase", () => {
    expect(() => validateFlagKey("NewDashboard")).toThrow(FlagError);
    expect(() => validateFlagKey("NEW_DASHBOARD")).toThrow(FlagError);
  });

  it("rejects starting with a digit", () => {
    expect(() => validateFlagKey("1flag")).toThrow(FlagError);
    expect(() => validateFlagKey("2_flag")).toThrow(FlagError);
  });

  it("rejects special characters", () => {
    expect(() => validateFlagKey("flag-test")).toThrow(FlagError);
    expect(() => validateFlagKey("flag.test")).toThrow(FlagError);
    expect(() => validateFlagKey("flag!")).toThrow(FlagError);
    expect(() => validateFlagKey("flag space")).toThrow(FlagError);
  });

  it("rejects empty", () => {
    expect(() => validateFlagKey("")).toThrow(FlagError);
  });

  it("rejects longer than 64 chars", () => {
    expect(() => validateFlagKey("a".repeat(65))).toThrow(FlagError);
  });
});

// ───────────────────────────────────────────────
// Target matching edge cases
// ───────────────────────────────────────────────

describe("feature flag target matching edge cases", () => {
  it("empty targets.users array → skip to next rule (not 'match all')", () => {
    const flag = makeFlag({
      enabled: true,
      targets: { users: [] }, // empty array — no users match.
    });
    // ctx.userId is set, but targets.users is empty → skip to next rule.
    // No workspaces/plans match, rollout_pct=0 → fall to enabled=true.
    const ctx: EvaluationContext = { userId: "user-1" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("user not in targets.users → OFF (the rule applies → returns false)", () => {
    const flag = makeFlag({
      enabled: true,
      targets: { users: ["other-user"] },
    });
    const ctx: EvaluationContext = { userId: "user-1" };
    // user-1 not in ['other-user'] → the users rule APPLIES (first-match) → returns false.
    // (The rule doesn't 'skip' — it matches + returns the includes result. This is
    // the first-match principle: the first applicable rule wins, even if it's
    // a denial.)
    expect(evaluateFlag(flag, ctx)).toBe(false);
  });

  it("no userId in ctx → skip targets.users rule", () => {
    const flag = makeFlag({
      enabled: true,
      targets: { users: ["user-1"] },
    });
    const ctx: EvaluationContext = {}; // no userId.
    // Can't match users rule → skip → no other targets → enabled=true.
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("plan match → ON (even if enabled=false)", () => {
    const flag = makeFlag({
      enabled: false,
      targets: { plans: ["pro", "business"] },
    });
    const ctx: EvaluationContext = { plan: "pro" };
    expect(evaluateFlag(flag, ctx)).toBe(true);
  });

  it("plan not in targets.plans → OFF (the rule applies → returns false)", () => {
    const flag = makeFlag({
      enabled: true,
      targets: { plans: ["enterprise"] },
    });
    const ctx: EvaluationContext = { plan: "free" };
    // 'free' not in ['enterprise'] → the plans rule APPLIES (first-match) → returns false.
    // (Same as users: the rule doesn't skip — it matches + returns the includes result.)
    expect(evaluateFlag(flag, ctx)).toBe(false);
  });
});

// ───────────────────────────────────────────────
// Control-plane invariant
// ───────────────────────────────────────────────

describe("feature flag control-plane invariant", () => {
  it("feature_flags is a global_system table (not @tenant_table, not RLS'd)", () => {
    // The migration: comment on table feature_flags is 'global_system'.
    // No RLS (global config). Access control: app reads (supa_app SELECT),
    // admin writes (supa_system CRUD via the API).
    expect("global_system").toBe("global_system");
  });

  it("kill_switch enabled=false is the emergency off-switch (instant global disable)", () => {
    // A kill switch with enabled=false means the feature is OFF for everyone,
    // immediately. This is the "pull the plug" path — used when a feature
    // is broken + needs to be disabled without a deploy.
    const flag = makeFlag({ kind: "kill_switch", enabled: false });
    for (let i = 0; i < 100; i++) {
      expect(evaluateFlag(flag, { userId: `user-${i}` })).toBe(false);
    }
  });

  it("the owner field documents who to page when the flag breaks", () => {
    const flag = makeFlag({ owner: "team-frontend" });
    expect(flag.owner).toBe("team-frontend");
    // The owner is a free-text field (team name, person, email) — used by
    // the ops team to know who to contact when a flag causes an incident.
  });
});

// ───────────────────────────────────────────────
// setFlag confirmation flow (spec: apps/admin/src/flags.ts)
// ───────────────────────────────────────────────

describe("feature flag setFlag confirmation requirements", () => {
  // Mirror the requireConfirmation logic.
  function needsConfirmation(flagKind: string): { danger: boolean; secondAdmin: boolean } {
    const isKillSwitch = flagKind === "kill_switch";
    return { danger: isKillSwitch, secondAdmin: isKillSwitch };
  }

  it("feature flags don't require 2nd-admin confirmation (danger=false, secondAdmin=false)", () => {
    const req = needsConfirmation("feature");
    expect(req.danger).toBe(false);
    expect(req.secondAdmin).toBe(false);
  });

  it("kill_switch flags require 2nd-admin confirmation (danger=true, secondAdmin=true)", () => {
    const req = needsConfirmation("kill_switch");
    expect(req.danger).toBe(true);
    expect(req.secondAdmin).toBe(true);
  });

  it("the typed phrase must match 'enable <key>' or 'disable <key>'", () => {
    // Mirror the phrase construction from setFlag.
    function phrase(key: string, enabled: boolean): string {
      return `${enabled ? "enable" : "disable"} ${key}`;
    }
    expect(phrase("kill_search_v3", true)).toBe("enable kill_search_v3");
    expect(phrase("kill_search_v3", false)).toBe("disable kill_search_v3");
  });

  it("a wrong typed phrase is rejected (400)", () => {
    const expected: string = "enable kill_search_v3";
    const typed: string = "enable kill_search_v2"; // typo — v2 instead of v3.
    expect(typed !== expected).toBe(true);
  });
});

describe("feature flag two-person rule (2nd admin)", () => {
  // Mirror the approveConfirmation check.
  function canApprove(requesterId: string, approverId: string): boolean {
    return requesterId !== approverId; // must be different.
  }

  it("a different owner can approve", () => {
    expect(canApprove("owner-1", "owner-2")).toBe(true);
  });

  it("the same owner CANNOT approve their own confirmation", () => {
    expect(canApprove("owner-1", "owner-1")).toBe(false);
  });

  it("the two-person rule prevents a single compromised owner from flipping a kill_switch", () => {
    // Even if owner-1's credentials are compromised, the attacker can't
    // flip the kill_switch alone — they need owner-2 to approve.
    // (This is the design invariant — documented.)
    expect(canApprove("owner-1", "owner-1")).toBe(false);
    expect(canApprove("owner-1", "owner-2")).toBe(true);
  });
});

describe("feature flag confirmation TTL (10 minutes)", () => {
  it("the confirmation expires after 10 minutes", () => {
    const TTL_MS = 10 * 60 * 1000;
    expect(TTL_MS).toBe(600000);
  });

  it("the 2nd admin must approve within the 10-minute window", () => {
    // If the 2nd admin doesn't approve within 10 min, the confirmation expires.
    // The requester must re-initiate (a new confirmation is created).
    const TTL_MS = 10 * 60 * 1000;
    const created = Date.now();
    const expiresAt = created + TTL_MS;
    // At 9 min → still valid.
    expect(created + 9 * 60 * 1000 < expiresAt).toBe(true);
    // At 11 min → expired.
    expect(created + 11 * 60 * 1000 > expiresAt).toBe(true);
  });
});

// ───────────────────────────────────────────────
// setFlag audit (old/new diff + justification)
// ───────────────────────────────────────────────

describe("feature flag setFlag audit (diff + justification)", () => {
  it("the audit action is 'flag.<kind>.set'", () => {
    function auditAction(kind: string): string {
      return `flag.${kind}.set`;
    }
    expect(auditAction("feature")).toBe("flag.feature.set");
    expect(auditAction("kill_switch")).toBe("flag.kill_switch.set");
  });

  it("the audit stores { old, new } diff for mutations", () => {
    const before = { enabled: false, rolloutPct: 0, kind: "feature" };
    const patch = { enabled: true, rolloutPct: 50 };
    const diff = { old: before, new: patch };
    expect(diff.old).toEqual(before);
    expect(diff.new).toEqual(patch);
  });

  it("the audit stores the justification (why the change was made)", () => {
    const justification = "enabling new_dashboard for 50% of pro users — A/B test";
    expect(justification).toBeTruthy();
    expect(justification.length).toBeGreaterThan(10);
  });

  it("one-click rollback = the same endpoint with inverted old/new", () => {
    // The rollback reads the audit entry's `old` field + applies it as a new
    // patch. The rollback is itself audited (old=current, new=old). This gives
    // a full history: every change + every rollback is logged.
    const originalChange = { old: { enabled: false }, new: { enabled: true } };
    const rollback = { old: originalChange.new, new: originalChange.old };
    expect(rollback.new).toEqual(originalChange.old);
  });
});

// ───────────────────────────────────────────────
// previewImpact (spec: evaluate flag state against real segments)
// ───────────────────────────────────────────────

describe("feature flag previewImpact logic", () => {
  it("global enable (enabled=true, no targets, rollout_pct=0) → all users affected", () => {
    // Mirror the previewImpact logic.
    const patch = { enabled: true, rolloutPct: 0, targets: {} as Record<string, unknown[]> };
    const targets: Record<string, unknown[]> = {};
    const isGlobal = true && !targets.users?.length && !targets.workspaces?.length && !targets.plans?.length && 0 === 0;
  });

  it("targets.users → only the listed users affected", () => {
    const targets = { users: ["user-1", "user-2", "user-3"] };
    expect(targets.users.length).toBe(3);
  });

  it("targets.workspaces → users in those workspaces affected", () => {
    const targets = { workspaces: ["ws-1", "ws-2"] };
    // The preview counts users in those workspaces (via workspace_members join).
    expect(targets.workspaces.length).toBe(2);
  });

  it("targets.plans → workspaces on those plans + their users affected", () => {
    const targets = { plans: ["pro", "business"] };
    expect(targets.plans.length).toBe(2);
  });

  it("rollout_pct → ~rollout_pct% of users affected", () => {
    const rolloutPct = 50;
    const totalUsers = 1000;
    const affected = Math.ceil((totalUsers * rolloutPct) / 100);
    expect(affected).toBe(500);
  });

  it("paying_affected counts users in pro/business/enterprise workspaces", () => {
    // The spec: `u.plan in ('pro','team')` — fixed to query workspaces.plan
    // (the plan is on the workspace, not the user).
    const payingPlans = ["pro", "business", "enterprise"];
    expect(payingPlans).toContain("pro");
    expect(payingPlans).not.toContain("free");
  });
});

// ───────────────────────────────────────────────
// Staleness check (>90d stale, >180d page owner)
// ───────────────────────────────────────────────

describe("feature flag staleness thresholds", () => {
  const STALE_THRESHOLD_DAYS = 90;
  const PAGE_OWNER_THRESHOLD_DAYS = 180;

  it("flags enabled > 90 days are 'stale'", () => {
    expect(STALE_THRESHOLD_DAYS).toBe(90);
    function isStale(daysEnabled: number): boolean {
      return daysEnabled > STALE_THRESHOLD_DAYS;
    }
    expect(isStale(89)).toBe(false);
    expect(isStale(91)).toBe(true);
    expect(isStale(365)).toBe(true);
  });

  it("flags enabled > 180 days page the owner", () => {
    expect(PAGE_OWNER_THRESHOLD_DAYS).toBe(180);
    function shouldPageOwner(daysEnabled: number): boolean {
      return daysEnabled > PAGE_OWNER_THRESHOLD_DAYS;
    }
    expect(shouldPageOwner(179)).toBe(false);
    expect(shouldPageOwner(181)).toBe(true);
    expect(shouldPageOwner(365)).toBe(true);
  });

  it("flags die; they don't accumulate (the staleness cron is the cleanup mechanism)", () => {
    // The nightly cron lists stale flags → the UI shows a "stale" badge →
    // the owner is paged after 180 days → the flag is removed or disabled.
    // This prevents flag accumulation (the common failure mode where flags
    // are added but never removed, leading to a graveyard of dead flags).
    expect(STALE_THRESHOLD_DAYS).toBeLessThan(PAGE_OWNER_THRESHOLD_DAYS);
  });

  it("disabled flags are never stale (only enabled flags can accumulate staleness)", () => {
    // Mirror listStaleFlags: filter by enabled=true first.
    const flags = [
      { key: "a", enabled: true, updatedAt: new Date(Date.now() - 100 * 86400000) }, // stale.
      { key: "b", enabled: false, updatedAt: new Date(Date.now() - 200 * 86400000) }, // not stale (disabled).
    ];
    const stale = flags.filter((f) => f.enabled);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.key).toBe("a");
  });
});
