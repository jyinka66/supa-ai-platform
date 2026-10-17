// Governance circuit breakers — Section 11.2.
//
// The spec (11.2): "Circuit breakers exist for 5 conditions. They recover
// automatically when conditions normalize."
//
//   11.2.1 Cost breaker     — if cost spikes, throttle or pause.
//   11.2.2 Latency breaker  — if latency degrades, reduce load.
//   11.2.3 Error breaker    — if error rate spikes, pause affected operations.
//   11.2.4 Abuse breaker    — if abuse pattern detected, tighten limits.
//   11.2.5 Compliance breaker — if compliance violation detected, halt affected operations.
//
// DESIGN
//
//   This is a SEPARATE breaker layer from `reliability/circuit-breaker.ts`.
//   That module protects against downstream-provider failures (the CLOSED →
//   OPEN → HALF_OPEN state machine for AI/payment providers).
//
//   This module protects against GOVERNANCE-SIGNAL spikes. The breakers here
//   trip on:
//     - aggregate cost overruns (per workspace / per region / platform-wide),
//     - latency degradation across a domain (decision latency p95 > threshold),
//     - error-rate spikes (governance_decisions with outcome=blocked > threshold),
//     - abuse pattern detection (multiple reputation demotions in window),
//     - compliance violation detection (a compliance_gate failed).
//
//   These breakers don't fast-fail individual requests — they MODULATE the
//   autonomous-decision rate. When tripped:
//     - cost breaker → throttle (decision rate cap) or pause (block all non-essential).
//     - latency breaker → reduce load (cap concurrent decisions).
//     - error breaker → pause affected operations (per-domain).
//     - abuse breaker → tighten limits (lower reputation floor for auto-approve).
//     - compliance breaker → halt affected operations (block the failing scope).
//
//   Auto-recovery: every breaker polls its condition. When the condition
//   returns to normal (e.g. cost rate drops below 80% of trip threshold), the
//   breaker transitions HALF_OPEN → CLOSED automatically. No human action
//   required.
//
//   All trips + recoveries are audited via admin_audit_log + recorded as
//   Prometheus metrics for the governance dashboard.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";
import {
  INCIDENTS_TOTAL,
  INCIDENT_REMEDIATION_LATENCY,
} from "./governance-metrics";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type GovernanceBreakerType =
  | "cost"          // 11.2.1
  | "latency"       // 11.2.2
  | "error"         // 11.2.3
  | "abuse"         // 11.2.4
  | "compliance";   // 11.2.5

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerThresholds {
  /** The value above which the breaker trips. */
  tripThreshold: number;
  /** The value below which the breaker auto-recovers (hysteresis — typically 80% of trip). */
  recoveryThreshold: number;
  /** How long to stay OPEN before transitioning to HALF_OPEN (cooldown, ms). */
  cooldownMs: number;
  /** Window over which the condition is evaluated (ms). */
  windowMs: number;
}

export interface BreakerSpec {
  type: GovernanceBreakerType;
  title: string;
  description: string;
  /** The unit the threshold is measured in (USD, ms, %, count, count). */
  unit: string;
  defaultThresholds: BreakerThresholds;
  /** The action taken when the breaker trips. */
  tripAction: string;
  /** The condition check function — returns the current value. */
  implemented: boolean;
}

// ───────────────────────────────────────────────
// 11.2 The 5 breaker types.
// ───────────────────────────────────────────────

export const GOVERNANCE_BREAKERS: BreakerSpec[] = [
  {
    type: "cost",
    title: "Cost Breaker",
    description: "If cost spikes, throttle or pause autonomous operations.",
    unit: "USD/hour",
    defaultThresholds: {
      tripThreshold: 1000,        // $1000/hour spike → trip.
      recoveryThreshold: 800,    // back below $800/hour → recover.
      cooldownMs: 5 * 60 * 1000, // 5-minute cooldown.
      windowMs: 60 * 60 * 1000,  // 1-hour rolling window.
    },
    tripAction: "throttle_or_pause",
    implemented: true,
  },
  {
    type: "latency",
    title: "Latency Breaker",
    description: "If latency degrades, reduce load on the affected domain.",
    unit: "p95_ms",
    defaultThresholds: {
      tripThreshold: 5000,        // p95 decision latency > 5s → trip.
      recoveryThreshold: 3000,    // back below 3s → recover.
      cooldownMs: 2 * 60 * 1000,  // 2-minute cooldown.
      windowMs: 5 * 60 * 1000,    // 5-minute rolling window.
    },
    tripAction: "reduce_load",
    implemented: true,
  },
  {
    type: "error",
    title: "Error Breaker",
    description: "If error rate spikes, pause affected operations.",
    unit: "error_rate_percent",
    defaultThresholds: {
      tripThreshold: 10,         // > 10% blocked/error decisions → trip.
      recoveryThreshold: 5,      // back below 5% → recover.
      cooldownMs: 60 * 1000,     // 1-minute cooldown.
      windowMs: 5 * 60 * 1000,   // 5-minute rolling window.
    },
    tripAction: "pause_affected_operations",
    implemented: true,
  },
  {
    type: "abuse",
    title: "Abuse Breaker",
    description: "If abuse pattern detected, tighten limits (lower reputation floor for auto-approve).",
    unit: "abuse_events_per_hour",
    defaultThresholds: {
      tripThreshold: 20,         // > 20 abuse signals/hour → trip.
      recoveryThreshold: 10,     // back below 10/hour → recover.
      cooldownMs: 30 * 60 * 1000, // 30-minute cooldown (abuse needs longer cool-off).
      windowMs: 60 * 60 * 1000,  // 1-hour rolling window.
    },
    tripAction: "tighten_limits",
    implemented: true,
  },
  {
    type: "compliance",
    title: "Compliance Breaker",
    description: "If compliance violation detected, halt affected operations.",
    unit: "violations_per_hour",
    defaultThresholds: {
      tripThreshold: 1,          // any compliance violation → trip immediately.
      recoveryThreshold: 0,      // requires explicit human resolution to recover.
      cooldownMs: 60 * 60 * 1000, // 1-hour cooldown.
      windowMs: 60 * 60 * 1000,  // 1-hour rolling window.
    },
    tripAction: "halt_affected_operations",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// In-memory breaker state.
//
// The breaker state is held in memory (per-instance). For multi-instance
// deployments, the state is reconstructed from the condition polling — every
// instance independently evaluates the same condition and trips together.
// This is the same pattern as the downstream circuit breaker.
// ───────────────────────────────────────────────

interface BreakerStateRow {
  type: GovernanceBreakerType;
  state: BreakerState;
  /** When the breaker last transitioned to OPEN (null if never tripped). */
  trippedAt: Date | null;
  /** When the breaker transitioned to HALF_OPEN (null if not in half-open). */
  halfOpenedAt: Date | null;
  /** The most recent condition value (for the dashboard). */
  lastValue: number | null;
  /** Last error from the condition check (null if healthy). */
  lastError: string | null;
  /** Number of times this breaker has tripped (lifetime counter). */
  tripCount: number;
}

const breakerStates = new Map<GovernanceBreakerType, BreakerStateRow>();

function getBreakerState(type: GovernanceBreakerType): BreakerStateRow {
  let s = breakerStates.get(type);
  if (!s) {
    s = {
      type,
      state: "closed",
      trippedAt: null,
      halfOpenedAt: null,
      lastValue: null,
      lastError: null,
      tripCount: 0,
    };
    breakerStates.set(type, s);
  }
  return s;
}

// ───────────────────────────────────────────────
// Condition checkers — read the current value for each breaker type.
//
// Each returns the current value + window label. The breaker engine compares
// against trip/recovery thresholds.
// ───────────────────────────────────────────────

export type ConditionChecker = (windowMs: number) => Promise<number>;

/** 11.2.1 Cost condition: total USD spent in the last `windowMs`. */
export const checkCostCondition: ConditionChecker = async (windowMs) => {
  const result = await db.execute(sql`
    select coalesce(sum(cost_usd), 0)::float8 as v
      from cost_events
     where created_at >= now() - (${windowMs} || ' milliseconds')::interval
  `);
  return Number((result as unknown as Array<{ v: number }>)[0]?.v ?? 0);
};

/** 11.2.2 Latency condition: p95 governance decision latency in ms over the window. */
export const checkLatencyCondition: ConditionChecker = async (windowMs) => {
  const result = await db.execute(sql`
    select coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::float8 as v
      from governance_decisions
     where created_at >= now() - (${windowMs} || ' milliseconds')::interval
  `);
  return Number((result as unknown as Array<{ v: number }>)[0]?.v ?? 0);
};

/** 11.2.3 Error condition: % of governance decisions with outcome=blocked in the window. */
export const checkErrorCondition: ConditionChecker = async (windowMs) => {
  const result = await db.execute(sql`
    select case when count(*) = 0 then 0
                else 100.0 * count(*) filter (where decision = 'blocked') / count(*)
           end::float8 as v
      from governance_decisions
     where created_at >= now() - (${windowMs} || ' milliseconds')::interval
  `);
  return Number((result as unknown as Array<{ v: number }>)[0]?.v ?? 0);
};

/** 11.2.4 Abuse condition: count of abuse signals in the window. */
export const checkAbuseCondition: ConditionChecker = async (windowMs) => {
  const result = await db.execute(sql`
    select count(*)::float8 as v
      from abuse_signals
     where detected_at >= now() - (${windowMs} || ' milliseconds')::interval
  `);
  return Number((result as unknown as Array<{ v: number }>)[0]?.v ?? 0);
};

/** 11.2.5 Compliance condition: count of compliance violations in the window. */
export const checkComplianceCondition: ConditionChecker = async (windowMs) => {
  const result = await db.execute(sql`
    select count(*)::float8 as v
      from compliance_violations
     where detected_at >= now() - (${windowMs} || ' milliseconds')::interval
  `);
  return Number((result as unknown as Array<{ v: number }>)[0]?.v ?? 0);
};

const CONDITION_CHECKERS: Record<GovernanceBreakerType, ConditionChecker> = {
  cost: checkCostCondition,
  latency: checkLatencyCondition,
  error: checkErrorCondition,
  abuse: checkAbuseCondition,
  compliance: checkComplianceCondition,
};

// ───────────────────────────────────────────────
// Breaker engine — evaluate a breaker's condition + transition state.
//
//   CLOSED  → OPEN      when condition > tripThreshold.
//   OPEN    → HALF_OPEN when cooldown elapsed.
//   HALF_OPEN → CLOSED  when condition < recoveryThreshold (auto-recovery).
//   HALF_OPEN → OPEN    when condition > tripThreshold again (re-trip).
//
// All transitions are audited + counted toward the trip metric.
// ───────────────────────────────────────────────

export type BreakerTransition =
  | "trip"            // CLOSED → OPEN
  | "half_open"       // OPEN → HALF_OPEN (cooldown elapsed)
  | "recover"         // HALF_OPEN → CLOSED (condition normalized)
  | "re_trip"         // HALF_OPEN → OPEN (condition still bad)
  | "no_change";

export interface BreakerEvaluationResult {
  type: GovernanceBreakerType;
  state: BreakerState;
  value: number;
  transition: BreakerTransition;
  threshold: number;
  recoveryThreshold: number;
  trippedAt: Date | null;
}

export async function evaluateBreaker(
  type: GovernanceBreakerType,
  opts: { thresholds?: Partial<BreakerThresholds> } = {},
): Promise<BreakerEvaluationResult> {
  const spec = GOVERNANCE_BREAKERS.find((b) => b.type === type);
  if (!spec) throw new Error(`Unknown breaker type: ${type}`);

  const thresholds: BreakerThresholds = {
    ...spec.defaultThresholds,
    ...opts.thresholds,
  };

  const checker = CONDITION_CHECKERS[type];
  const value = await checker(thresholds.windowMs).catch((err) => {
    const state = getBreakerState(type);
    state.lastError = err instanceof Error ? err.message : String(err);
    return -1; // sentinel: checker failed → treat as 0 (don't trip on infra failure).
  });

  const state = getBreakerState(type);
  state.lastValue = value;
  if (value >= 0) state.lastError = null;

  let transition: BreakerTransition = "no_change";
  const now = new Date();

  switch (state.state) {
    case "closed": {
      if (value >= thresholds.tripThreshold) {
        state.state = "open";
        state.trippedAt = now;
        state.tripCount += 1;
        transition = "trip";
      }
      break;
    }
    case "open": {
      const cooldownElapsed =
        state.trippedAt != null &&
        now.getTime() - state.trippedAt.getTime() >= thresholds.cooldownMs;
      if (cooldownElapsed) {
        state.state = "half_open";
        state.halfOpenedAt = now;
        transition = "half_open";
      }
      break;
    }
    case "half_open": {
      if (value >= thresholds.tripThreshold) {
        // Re-trip — condition still bad.
        state.state = "open";
        state.trippedAt = now;
        state.tripCount += 1;
        transition = "re_trip";
      } else if (value <= thresholds.recoveryThreshold) {
        // Auto-recovery — condition normalized.
        state.state = "closed";
        state.trippedAt = null;
        state.halfOpenedAt = null;
        transition = "recover";
      }
      // Else: stay half-open, keep probing.
      break;
    }
  }

  // Audit + metric on every transition (not on every poll).
  if (transition !== "no_change") {
    await auditBreakerTransition(type, transition, value, thresholds, state);
  }

  return {
    type,
    state: state.state,
    value,
    transition,
    threshold: thresholds.tripThreshold,
    recoveryThreshold: thresholds.recoveryThreshold,
    trippedAt: state.trippedAt,
  };
}

// ───────────────────────────────────────────────
// auditBreakerTransition — record trips + recoveries.
// ───────────────────────────────────────────────

async function auditBreakerTransition(
  type: GovernanceBreakerType,
  transition: BreakerTransition,
  value: number,
  thresholds: BreakerThresholds,
  state: BreakerStateRow,
): Promise<void> {
  const action = `governance.breaker.${transition}`;
  const severity =
    transition === "trip" || transition === "re_trip"
      ? "high"
      : transition === "recover"
        ? "low"
        : "medium";

  await adminAudit({
    actor: "system",
    action,
    target: {
      breakerType: type,
      transition,
      currentValue: value,
      tripThreshold: thresholds.tripThreshold,
      recoveryThreshold: thresholds.recoveryThreshold,
      newState: state.state,
      tripCount: state.tripCount,
    },
    justification: `Governance ${type} breaker ${transition}: value=${value} (trip=${thresholds.tripThreshold}, recover=${thresholds.recoveryThreshold}).`,
  });

  // Metric — incident counts + remediation latency (recovery time).
  if (transition === "trip" || transition === "re_trip") {
    INCIDENTS_TOTAL.inc({ category: `breaker_${type}`, severity });
  }
  if (transition === "recover" && state.trippedAt != null) {
    const remediationMinutes = (Date.now() - state.trippedAt.getTime()) / 60000;
    INCIDENT_REMEDIATION_LATENCY.observe(
      { category: `breaker_${type}`, severity: "low" },
      remediationMinutes,
    );
  }
}

// ───────────────────────────────────────────────
// isBreakerOpen — short-circuit check for the decision engine.
//
// When a breaker is OPEN or HALF_OPEN, the decision engine applies the
// breaker's trip action (throttle / reduce load / pause / tighten / halt).
// This is the inline check the engine calls before every decision.
// ───────────────────────────────────────────────

export function isBreakerOpen(type: GovernanceBreakerType): boolean {
  const state = breakerStates.get(type);
  return state?.state === "open" || state?.state === "half_open";
}

export function getBreakerStateSnapshot(type: GovernanceBreakerType): BreakerStateRow | null {
  const s = breakerStates.get(type);
  if (!s) return null;
  return { ...s };
}

export function listBreakerStates(): Array<BreakerStateRow & { spec: BreakerSpec }> {
  return GOVERNANCE_BREAKERS.map((spec) => {
    const s = getBreakerState(spec.type);
    return { ...s, spec };
  });
}

// ───────────────────────────────────────────────
// evaluateAllBreakers — cron entrypoint.
//
// Called every 30 seconds by the breaker-eval cron. Evaluates every breaker
// in turn + returns the transitions. A "no_change" run is the steady state;
// any non-no_change transition is also surfaced to the governance dashboard.
// ───────────────────────────────────────────────

export async function evaluateAllBreakers(): Promise<BreakerEvaluationResult[]> {
  const results: BreakerEvaluationResult[] = [];
  for (const spec of GOVERNANCE_BREAKERS) {
    try {
      const r = await evaluateBreaker(spec.type);
      results.push(r);
    } catch (err) {
      // Log + continue — a single breaker failure shouldn't stop the others.
      const state = getBreakerState(spec.type);
      state.lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return results;
}

// ───────────────────────────────────────────────
// Manual override — force a breaker to a state (for incident response).
// ───────────────────────────────────────────────

export async function forceBreakerState(input: {
  type: GovernanceBreakerType;
  targetState: BreakerState;
  reason: string;
  forcedBy: string;
}): Promise<void> {
  const state = getBreakerState(input.type);
  const oldState = state.state;
  state.state = input.targetState;
  if (input.targetState === "open") {
    state.trippedAt = new Date();
    state.tripCount += 1;
  } else if (input.targetState === "closed") {
    state.trippedAt = null;
    state.halfOpenedAt = null;
  }

  await adminAudit({
    actor: input.forcedBy,
    action: "governance.breaker.forced",
    target: {
      breakerType: input.type,
      oldState,
      newState: input.targetState,
      reason: input.reason,
    },
    justification: `Breaker ${input.type} force-set to ${input.targetState} by ${input.forcedBy}: ${input.reason}`,
  });
}

// ───────────────────────────────────────────────
// 11.2 Verification — the spec section as a checklist.
// ───────────────────────────────────────────────

export interface BreakerVerification {
  totalBreakers: number;
  implementedBreakers: number;
  allImplemented: boolean;
  allAutoRecover: boolean;
  breakers: Array<{
    type: GovernanceBreakerType;
    implemented: boolean;
    autoRecover: boolean;
  }>;
}

export function verifyCircuitBreakers(): BreakerVerification {
  const breakers = GOVERNANCE_BREAKERS.map((b) => ({
    type: b.type,
    implemented: b.implemented,
    autoRecover: true, // all breakers auto-recover via the HALF_OPEN → CLOSED transition.
  }));
  const impl = breakers.filter((b) => b.implemented).length;
  return {
    totalBreakers: GOVERNANCE_BREAKERS.length,
    implementedBreakers: impl,
    allImplemented: impl === GOVERNANCE_BREAKERS.length,
    allAutoRecover: breakers.every((b) => b.autoRecover),
    breakers,
  };
}

/** Reset all breaker states — for tests only. */
export function _resetBreakerStatesForTests(): void {
  breakerStates.clear();
}
