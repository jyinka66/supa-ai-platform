/**
 * Onboarding metrics tests.
 *
 * Covers:
 *   - time-to-first-edit / time-to-first-share
 *   - D7 return computation
 *   - D7 return by onboarding path (template vs empty-canvas)
 *   - coach dismissal rate per trigger
 *   - sticky A/B assignment
 *   - KPI snapshot aggregation
 */

import { describe, it, expect } from "vitest";
import {
  OnboardingFunnelTracker,
  assignCoachVariant,
  computeKpiSnapshot,
  type OnboardingFunnelEvent,
} from "../src/metrics.js";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

const T0 = 1_700_000_000_000; // fixed epoch
const DAY = 86_400_000;

function event(
  kind: OnboardingFunnelEvent["kind"],
  accountId: string,
  ts: number,
  extra?: Record<string, unknown>,
): OnboardingFunnelEvent {
  return { kind, ts, accountId, ...extra } as OnboardingFunnelEvent;
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("OnboardingFunnelTracker — time-to-first-*", () => {
  it("computes time-to-first-edit from onboarding start", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("doc-materialized", "u1", T0 + 1000, { docId: "d1", path: "template" }));
    tracker.record(event("first-edit", "u1", T0 + 60_000, { docId: "d1" }));
    expect(tracker.computeTimeToFirstEdit("u1")).toBe(60_000);
  });

  it("returns null if no first-edit recorded", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    expect(tracker.computeTimeToFirstEdit("u1")).toBeNull();
  });

  it("computes time-to-first-share", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("first-share", "u1", T0 + 120_000, { docId: "d1" }));
    expect(tracker.computeTimeToFirstShare("u1")).toBe(120_000);
  });

  it("first-edit is recorded only once (no overwrite on later events)", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("first-edit", "u1", T0 + 30_000, { docId: "d1" }));
    tracker.record(event("first-edit", "u1", T0 + 60_000, { docId: "d1" }));
    expect(tracker.computeTimeToFirstEdit("u1")).toBe(30_000);
  });
});

describe("OnboardingFunnelTracker — D7 return", () => {
  it("returns true when session within 7 days of onboarding start", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("doc-materialized", "u1", T0 + 1000, { docId: "d1", path: "template" }));
    tracker.record(event("session-end", "u1", T0 + 3 * DAY, { sessionId: "s1" }));
    expect(tracker.computeD7Return("u1")).toBe(true);
  });

  it("returns false when no subsequent session", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    expect(tracker.computeD7Return("u1")).toBe(false);
  });

  it("returns false when session is past 7 days", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("session-end", "u1", T0 + 8 * DAY, { sessionId: "s1" }));
    expect(tracker.computeD7Return("u1")).toBe(false);
  });

  it("returns false if onboarding never started", () => {
    const tracker = new OnboardingFunnelTracker();
    expect(tracker.computeD7Return("u1")).toBe(false);
  });
});

describe("D7 return by onboarding path", () => {
  it("computes rate per path (template vs empty-canvas)", () => {
    const tracker = new OnboardingFunnelTracker();
    // template user 1: returns
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("doc-materialized", "u1", T0 + 1, { docId: "d1", path: "template" }));
    tracker.record(event("session-end", "u1", T0 + 3 * DAY, { sessionId: "s1" }));
    // template user 2: doesn't return
    tracker.record(event("onboarding-started", "u2", T0));
    tracker.record(event("doc-materialized", "u2", T0 + 1, { docId: "d2", path: "template" }));
    // empty-canvas user 1: returns
    tracker.record(event("onboarding-started", "u3", T0));
    tracker.record(event("doc-materialized", "u3", T0 + 1, { docId: "d3", path: "empty-canvas" }));
    tracker.record(event("session-end", "u3", T0 + 5 * DAY, { sessionId: "s3" }));

    const byPath = tracker.computeD7ReturnByPath();
    expect(byPath.template.total).toBe(2);
    expect(byPath.template.returned).toBe(1);
    expect(byPath.template.rate).toBe(0.5);
    expect(byPath["empty-canvas"].total).toBe(1);
    expect(byPath["empty-canvas"].returned).toBe(1);
    expect(byPath["empty-canvas"].rate).toBe(1);
  });

  it("handles no users per path (rate=0, no div-by-zero)", () => {
    const tracker = new OnboardingFunnelTracker();
    const byPath = tracker.computeD7ReturnByPath();
    expect(byPath.template.total).toBe(0);
    expect(byPath.template.rate).toBe(0);
    expect(byPath["empty-canvas"].total).toBe(0);
    expect(byPath["empty-canvas"].rate).toBe(0);
  });
});

describe("coach dismissal rate", () => {
  it("computes per-trigger dismissal rate", () => {
    const tracker = new OnboardingFunnelTracker();
    // 3 users see first-text-selection, 1 dismisses
    tracker.record(event("coach-mark-shown", "u1", T0, { trigger: "first-text-selection", docId: "d1" }));
    tracker.record(event("coach-mark-shown", "u2", T0, { trigger: "first-text-selection", docId: "d2" }));
    tracker.record(event("coach-mark-shown", "u3", T0, { trigger: "first-text-selection", docId: "d3" }));
    tracker.record(event("coach-mark-dismissed", "u1", T0 + 1, { trigger: "first-text-selection", docId: "d1" }));

    const rates = tracker.computeCoachDismissalRate();
    expect(rates["first-text-selection"].shown).toBe(3);
    expect(rates["first-text-selection"].dismissed).toBe(1);
    expect(rates["first-text-selection"].rate).toBeCloseTo(1 / 3, 3);
  });

  it("returns empty object when no coach marks recorded", () => {
    const tracker = new OnboardingFunnelTracker();
    const rates = tracker.computeCoachDismissalRate();
    expect(Object.keys(rates)).toHaveLength(0);
  });
});

describe("assignCoachVariant — sticky A/B", () => {
  it("is deterministic per account+trigger", () => {
    const v1 = assignCoachVariant("u1", "first-text-selection");
    const v2 = assignCoachVariant("u1", "first-text-selection");
    expect(v1).toBe(v2);
  });

  it("varies across different accounts (probabilistically)", () => {
    // With FNV-1a, we expect roughly 50/50 split. Test that at least
    // one account gets A and at least one gets B in a sample of 20.
    const variants = new Set<string>();
    for (let i = 0; i < 20; i++) {
      variants.add(assignCoachVariant(`u${i}`, "first-text-selection"));
    }
    expect(variants.has("A")).toBe(true);
    expect(variants.has("B")).toBe(true);
  });

  it("varies across triggers for the same account", () => {
    const triggers = ["first-text-selection", "first-ai-use", "first-share", "first-extract-to-token", "first-template-update"] as const;
    const variants = new Set<string>();
    for (const t of triggers) {
      variants.add(assignCoachVariant("u1", t));
    }
    // We expect at least 2 distinct variants across 5 triggers.
    expect(variants.size).toBeGreaterThanOrEqual(2);
  });
});

describe("computeKpiSnapshot", () => {
  it("aggregates medians across accounts", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("first-edit", "u1", T0 + 30_000, { docId: "d1" }));
    tracker.record(event("onboarding-started", "u2", T0));
    tracker.record(event("first-edit", "u2", T0 + 60_000, { docId: "d2" }));

    const snapshot = computeKpiSnapshot(tracker);
    expect(snapshot.medianTimeToFirstEditMs).toBe(45_000); // median of 30k and 60k
  });

  it("returns null median when no first-edits", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    const snapshot = computeKpiSnapshot(tracker);
    expect(snapshot.medianTimeToFirstEditMs).toBeNull();
  });

  it("d7ReturnRate is the fraction of users who returned within 7d", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("session-end", "u1", T0 + 3 * DAY, { sessionId: "s1" }));
    tracker.record(event("onboarding-started", "u2", T0));
    tracker.record(event("onboarding-started", "u3", T0));
    tracker.record(event("session-end", "u3", T0 + 5 * DAY, { sessionId: "s3" }));

    const snapshot = computeKpiSnapshot(tracker);
    expect(snapshot.d7ReturnRate).toBeCloseTo(2 / 3, 3);
  });

  it("d7ReturnByPath reports per-path rates", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("onboarding-started", "u1", T0));
    tracker.record(event("doc-materialized", "u1", T0 + 1, { docId: "d1", path: "template" }));
    tracker.record(event("session-end", "u1", T0 + 3 * DAY, { sessionId: "s1" }));
    tracker.record(event("onboarding-started", "u2", T0));
    tracker.record(event("doc-materialized", "u2", T0 + 1, { docId: "d2", path: "empty-canvas" }));

    const snapshot = computeKpiSnapshot(tracker);
    expect(snapshot.d7ReturnByPath.template).toBe(1);
    expect(snapshot.d7ReturnByPath["empty-canvas"]).toBe(0);
  });

  it("coachDismissalRate includes all triggers that had any activity", () => {
    const tracker = new OnboardingFunnelTracker();
    tracker.record(event("coach-mark-shown", "u1", T0, { trigger: "first-text-selection", docId: "d1" }));
    tracker.record(event("coach-mark-dismissed", "u1", T0 + 1, { trigger: "first-text-selection", docId: "d1" }));

    const snapshot = computeKpiSnapshot(tracker);
    expect(snapshot.coachDismissalRate["first-text-selection"]).toBe(1);
  });
});
