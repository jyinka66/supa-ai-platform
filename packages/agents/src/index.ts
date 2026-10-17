/**
 * @supa/agents — agent infrastructure: schema, permissions, budget,
 * platform primitives, memory, approvals, tool registry, run executor, kill switch.
 *
 *   schema           — BudgetSpec, ToolClass, ApprovalPolicy.
 *   permissions      — PermissionSet, ToolDef, policyFloor, effectivePolicy,
 *                      canInvoke (the privilege rule: grants ∩ grantor's LIVE
 *                      permissions, transitive for a2a chains).
 *   budget/ledger    — holdBudget (atomic check-and-hold via advisory lock),
 *                      captureBudget (actuals + refund delta), computeAgentSpend
 *                      (derived, never stored — the no-drift rule).
 *   platform         — hashJson (stable SHA-256 of canonical JSON), facts
 *                      (append-only activity-fact emitter), notify (sprint-4
 *                      notification matrix stub), redactPII (sprint-5 PII
 *                      redactor — regex-based; sprint 5 swaps to a model).
 *   memory/store     — MemoryStore (fact / episode / procedure / preference;
 *                      DB-unique dedup at (agent_id, kind, content); PII
 *                      redaction at every write; TTL via ttlHours).
 *   approvals/inbox   — createApproval (immutable context snapshot; twoGate flag
 *                      for financial floor), expireStale (cron sweeper; expiry
 *                      NEVER approves), decide (approve/reject/modify; race-safe
 *                      conditional update; two-gate same-human-twice rejected).
 *   tools/registry    — boot-time tool registry (process-wide singleton).
 *   runs/executor     — the run loop with loop guards (max_steps, wall_deadline,
 *                      tool_rate, loop_detect, idempotency, approval_gate,
 *                      permission_intersection, drafts_rule, a2a_depth,
 *                      cancel_observation).
 *   killswitch        — workspace kill switch (60s wall-clock SLO; atomic
 *                      agents→killed + runs→cancelled; cancel-flag observed
 *                      per-step by the executor loop; idempotency guard;
 *                      SLO-violation alert fact).
 */

export * from "./schema.js";
export * from "./permissions.js";
export * from "./budget/ledger.js";
export * from "./platform.js";
export * from "./memory/store.js";
export * from "./approvals/inbox.js";
export * from "./tools/registry.js";
export * from "./runs/executor.js";
export * from "./killswitch.js";
export * from "./agents/templates.js";
export * from "./agents/team.js";
export * from "./triggers/dispatcher.js";
export * from "./observability/queries.js";
export * from "./i18n.js";
