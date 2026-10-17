/**
 * @supa/design-onboarding/metrics
 * ----------------------------------------------------------------
 * Metrics with owners (the operability discipline applied to product):
 *
 *   - time-to-first-edit
 *   - time-to-first-share
 *   - D7 return by onboarding path
 *
 * Coach steps A/B'd like everything else; the session channel is
 * the denominator. Coach dismissal = implicit signal for the
 * ai-quality channel of onboarding itself.
 * ----------------------------------------------------------------
 */

import type { CoachTrigger, OnboardingPath } from "./onboarding.js";

// ───────────────────────────────────────────────
// Funnel events
// ───────────────────────────────────────────────

export type OnboardingFunnelEvent =
  | { kind: "onboarding-started"; ts: number; accountId: string }
  | { kind: "seed-intent-picked"; ts: number; accountId: string; docType: string; archetype: string }
  | { kind: "doc-materialized"; ts: number; accountId: string; docId: string; path: OnboardingPath }
  | { kind: "first-edit"; ts: number; accountId: string; docId: string }
  | { kind: "first-share"; ts: number; accountId: string; docId: string }
  | { kind: "coach-mark-shown"; ts: number; accountId: string; trigger: CoachTrigger; docId: string }
  | { kind: "coach-mark-dismissed"; ts: number; accountId: string; trigger: CoachTrigger; docId: string }
  | { kind: "session-end"; ts: number; accountId: string; sessionId: string };

// ───────────────────────────────────────────────
// Funnel tracker — per-account
// ───────────────────────────────────────────────

export interface AccountFunnelState {
  accountId: string;
  /** Onboarding start ts (ms). */
  startedAt?: number;
  /** Doc materialize ts (ms). */
  materializedAt?: number;
  /** First edit ts (ms). */
  firstEditAt?: number;
  /** First share ts (ms). */
  firstShareAt?: number;
  /** Onboarding path taken. */
  path?: OnboardingPath;
  /** Coach marks shown (per trigger). */
  coachMarksShown: { trigger: CoachTrigger; ts: number }[];
  /** Coach marks dismissed (per trigger). */
  coachMarksDismissed: { trigger: CoachTrigger; ts: number }[];
  /** Sessions after onboarding (for D7 return). */
  subsequentSessions: { sessionId: string; ts: number }[];
}

export class OnboardingFunnelTracker {
  private readonly states = new Map<string, AccountFunnelState>();

  private getState(accountId: string): AccountFunnelState {
    let s = this.states.get(accountId);
    if (!s) {
      s = {
        accountId,
        coachMarksShown: [],
        coachMarksDismissed: [],
        subsequentSessions: [],
      };
      this.states.set(accountId, s);
    }
    return s;
  }

  record(event: OnboardingFunnelEvent): void {
    const s = this.getState(event.accountId);
    switch (event.kind) {
      case "onboarding-started":
        s.startedAt = event.ts;
        break;
      case "seed-intent-picked":
        // Recorded as part of the funnel; no separate state needed.
        break;
      case "doc-materialized":
        s.materializedAt = event.ts;
        s.path = event.path;
        break;
      case "first-edit":
        if (!s.firstEditAt) s.firstEditAt = event.ts;
        break;
      case "first-share":
        if (!s.firstShareAt) s.firstShareAt = event.ts;
        break;
      case "coach-mark-shown":
        s.coachMarksShown.push({ trigger: event.trigger, ts: event.ts });
        break;
      case "coach-mark-dismissed":
        s.coachMarksDismissed.push({ trigger: event.trigger, ts: event.ts });
        break;
      case "session-end":
        s.subsequentSessions.push({ sessionId: event.sessionId, ts: event.ts });
        break;
    }
  }

  // ─────────── metric computation ───────────

  /** Time-to-first-edit (ms) — from onboarding start to first edit. */
  computeTimeToFirstEdit(accountId: string): number | null {
    const s = this.states.get(accountId);
    if (!s?.startedAt || !s.firstEditAt) return null;
    return s.firstEditAt - s.startedAt;
  }

  /** Time-to-first-share (ms) — from onboarding start to first share. */
  computeTimeToFirstShare(accountId: string): number | null {
    const s = this.states.get(accountId);
    if (!s?.startedAt || !s.firstShareAt) return null;
    return s.firstShareAt - s.startedAt;
  }

  /**
   * D7 return: did the user return within 7 days of onboarding?
   * Returns true iff at least one subsequent session occurred within
   * 7 days of the onboarding start.
   */
  computeD7Return(accountId: string): boolean {
    const s = this.states.get(accountId);
    if (!s?.startedAt) return false;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return s.subsequentSessions.some(
      (sess) => sess.ts >= s.startedAt! && sess.ts <= s.startedAt! + sevenDaysMs,
    );
  }

  /**
   * D7 return by onboarding path — for comparing template vs
   * empty-canvas onboarding.
   */
  computeD7ReturnByPath(): Record<OnboardingPath, { returned: number; total: number; rate: number }> {
    const byPath: Record<OnboardingPath, { returned: number; total: number; rate: number }> = {
      template: { returned: 0, total: 0, rate: 0 },
      "empty-canvas": { returned: 0, total: 0, rate: 0 },
    };
    for (const s of this.states.values()) {
      if (!s.path) continue;
      byPath[s.path].total++;
      if (this.computeD7Return(s.accountId)) {
        byPath[s.path].returned++;
      }
    }
    for (const path of Object.keys(byPath) as OnboardingPath[]) {
      const p = byPath[path];
      p.rate = p.total === 0 ? 0 : Math.round((p.returned / p.total) * 1000) / 1000;
    }
    return byPath;
  }

  // ─────────── coach mark metrics ───────────

  /**
   * Coach dismissal rate per trigger — implicit signal for the
   * ai-quality channel of onboarding itself. High dismissal on a
   * specific trigger = the coach mark isn't landing.
   */
  computeCoachDismissalRate(): Record<CoachTrigger, { shown: number; dismissed: number; rate: number }> {
    const byTrigger = new Map<CoachTrigger, { shown: number; dismissed: number }>();
    for (const s of this.states.values()) {
      for (const { trigger } of s.coachMarksShown) {
        const t = byTrigger.get(trigger) ?? { shown: 0, dismissed: 0 };
        t.shown++;
        byTrigger.set(trigger, t);
      }
      for (const { trigger } of s.coachMarksDismissed) {
        const t = byTrigger.get(trigger) ?? { shown: 0, dismissed: 0 };
        t.dismissed++;
        byTrigger.set(trigger, t);
      }
    }
    const out = {} as Record<CoachTrigger, { shown: number; dismissed: number; rate: number }>;
    for (const [trigger, counts] of byTrigger) {
      out[trigger] = {
        shown: counts.shown,
        dismissed: counts.dismissed,
        rate: counts.shown === 0 ? 0 : Math.round((counts.dismissed / counts.shown) * 1000) / 1000,
      };
    }
    return out;
  }
}

// ───────────────────────────────────────────────
// A/B test assignment for coach steps
// ───────────────────────────────────────────────

/**
 * Coach steps A/B'd like everything else. The assignment is sticky
 * per account (same variant across sessions) so we measure the
 * variant's effect, not noise.
 */
export type CoachVariant = "A" | "B";

export interface CoachAbAssignment {
  /** Coach trigger being A/B tested. */
  trigger: CoachTrigger;
  /** Variant assigned to this account. */
  variant: CoachVariant;
  /** Stable assignment (sticky across sessions). */
  accountId: string;
}

/**
 * Sticky A/B assignment via FNV-1a hash of accountId + trigger.
 * Same account + trigger → same variant, across sessions.
 */
export function assignCoachVariant(accountId: string, trigger: CoachTrigger): CoachVariant {
  const h = stableHash(`${accountId}:${trigger}`);
  return h % 2 === 0 ? "A" : "B";
}

function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ───────────────────────────────────────────────
// Telemetry bridge — feeds @supa/observability
// ───────────────────────────────────────────────

/**
 * The session channel is the denominator. Every onboarding metric
 * is reported as a rate against session count, not a raw count —
 * so a small cohort's metrics aren't drowned out by a large one.
 */
export interface OnboardingKpiSnapshot {
  /** Median time-to-first-edit (ms), across all onboarding-completed accounts. */
  medianTimeToFirstEditMs: number | null;
  /** Median time-to-first-share (ms). */
  medianTimeToFirstShareMs: number | null;
  /** D7 return rate (0..1). */
  d7ReturnRate: number;
  /** D7 return rate by onboarding path. */
  d7ReturnByPath: Record<OnboardingPath, number>;
  /** Coach dismissal rate per trigger. */
  coachDismissalRate: Partial<Record<CoachTrigger, number>>;
}

export function computeKpiSnapshot(tracker: OnboardingFunnelTracker): OnboardingKpiSnapshot {
  const ttfes: number[] = [];
  const ttfs: number[] = [];
  let d7Returned = 0;
  let d7Total = 0;
  for (const state of (tracker as unknown as { states: Map<string, AccountFunnelState> }).states.values()) {
    const ttfe = tracker.computeTimeToFirstEdit(state.accountId);
    if (ttfe !== null) ttfes.push(ttfe);
    const ttfsVal = tracker.computeTimeToFirstShare(state.accountId);
    if (ttfsVal !== null) ttfs.push(ttfsVal);
    d7Total++;
    if (tracker.computeD7Return(state.accountId)) d7Returned++;
  }
  const byPath = tracker.computeD7ReturnByPath();
  const dismissalRates = tracker.computeCoachDismissalRate();
  const coachRates: Partial<Record<CoachTrigger, number>> = {};
  for (const [trigger, counts] of Object.entries(dismissalRates)) {
    coachRates[trigger as CoachTrigger] = counts.rate;
  }
  return {
    medianTimeToFirstEditMs: median(ttfes),
    medianTimeToFirstShareMs: median(ttfs),
    d7ReturnRate: d7Total === 0 ? 0 : Math.round((d7Returned / d7Total) * 1000) / 1000,
    d7ReturnByPath: {
      template: byPath.template.rate,
      "empty-canvas": byPath["empty-canvas"].rate,
    },
    coachDismissalRate: coachRates,
  };
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : Math.round(sorted[mid]!);
}
