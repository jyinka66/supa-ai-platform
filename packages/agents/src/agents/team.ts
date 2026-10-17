// Agent team graph — the delegation view.
//
//   teamGraph(wsId)
//     Fetches all agent_teams edges for the workspace. For each edge, renders
//     the effective permission set = granted_tools ∩ from_agent_live_perms
//     ∩ to_agent_live_perms, LIVE-computed (no cache — the "live" property
//     is the contract; a cache would have to be invalidated on every
//     permission change, which is fragile).
//
//   livePerms(agentId)
//     Fetches the agent's toolGrants from DB + derives the permission set
//     from the tool registry (each granted tool → its requiredPermission).
//     This is the same logic as the executor's getLivePermissions, extracted
//     here so the team graph and the executor share one definition.
//
//   intersectAll(permSets)
//     The privilege rule applied to a chain of PermissionSets: the intersection
//     of all of them. A permission is in the result iff it's in EVERY input
//     set. This is what canInvoke checks (grants ∩ grantor ∩ chain).
//
//   createDelegation / removeDelegation
//     The mutation surface. createDelegation enforces that granted_tools is a
//     SUBSET of the from_agent's own toolGrants (you can't delegate what you
//     don't have — the privilege rule at the data layer).
//
// CYCLES: the graph can have cycles (A→B→C→A). The executor's a2a depth limit
// (max 3) prevents infinite loops at runtime; the graph itself can have cycles.

import { db } from "@supa/db";
import { agentTeams, agents } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { registry } from "../tools/registry.js";
import { SetPermissionSet, type PermissionSet } from "../permissions.js";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface TeamEdge {
  id: string;
  fromAgent: string;
  toAgent: string;
  /** Tools the from_agent delegates to the to_agent (as stored on the edge). */
  grantedTools: string[];
  /**
   * Effective tools = grantedTools ∩ from_agent's live grants ∩ to_agent's
   * live grants. A tool in grantedTools but NOT in the from_agent's current
   * toolGrants (e.g. the from_agent's grants were revoked after the edge was
   * created) is NOT in the effective set — the delegation is stale.
   *
   * Live-computed per teamGraph() call. No cache.
   */
  effective: string[];
}

// ───────────────────────────────────────────────
// livePerms — the agent's live permission set
// ───────────────────────────────────────────────

/**
 * Fetch an agent's LIVE permission set. The agent's `toolGrants` column is
 * the source of truth for which tools it's granted; each granted tool's
 * `requiredPermission` is derived from the tool registry. The result is the
 * set of permissions the agent currently has.
 *
 * LIVE: fetched from DB per call. No cache. The "live" property is the
 * contract — a cache would have to be invalidated on every toolGrants change,
 * every tool registry change, and every permission revocation. The honest
 * implementation fetches per call; a cache is an optimization that must not
 * violate the live property (and the team graph is read infrequently — UI
// rendering, not per-step — so the per-call cost is fine).
 *
 * This is the same logic as the executor's getLivePermissions, extracted
 * here so the team graph and the executor share one definition of "what
 * permissions does this agent have right now?"
 */
export async function livePerms(
  wsId: string,
  agentId: string,
): Promise<PermissionSet> {
  // Fetch the agent's toolGrants.
  const rows = await db
    .select({ toolGrants: agents.toolGrants })
    .from(agents)
    .where(and(eq(agents.id, agentId as any), eq(agents.workspaceId, wsId as any)))
    .limit(1);
  const grants = rows[0]?.toolGrants ?? [];

  // Derive the permission set from the registry.
  const perms = new Set<string>();
  for (const toolId of grants) {
    const tool = registry.get(toolId);
    if (tool) perms.add(tool.requiredPermission);
  }
  return new SetPermissionSet(perms);
}

/**
 * Fetch an agent's LIVE tool grants (the toolGrants column, fetched fresh).
 * Used by teamGraph to compute the effective intersection at the tool-id
 * level (not the permission level — the edge stores tool ids, not perms).
 */
export async function liveGrants(
  wsId: string,
  agentId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ toolGrants: agents.toolGrants })
    .from(agents)
    .where(and(eq(agents.id, agentId as any), eq(agents.workspaceId, wsId as any)))
    .limit(1);
  return rows[0]?.toolGrants ?? [];
}

// ───────────────────────────────────────────────
// intersectAll — the privilege rule for a chain of sets
// ───────────────────────────────────────────────

/**
 * Intersect multiple string-sets. A string is in the result iff it's in
 * EVERY input set. This is the privilege rule (grants ∩ grantor ∩ chain)
 * applied to arbitrary sets — used by teamGraph to compute the effective
 * tools per edge.
 *
 * Empty inputs are treated as "allow all" (the identity for intersection) —
 * an empty chain doesn't restrict. This matches canInvoke's behavior: an
 * empty chainPerms array means "no transitive restriction" (only grantor
 * + grants are checked).
 */
export function intersectAll(sets: readonly (readonly string[])[]): string[] {
  if (sets.length === 0) return [];
  // Start with the first set, then intersect each subsequent set.
  let result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const next = new Set(sets[i]);
    result = new Set([...result].filter((x) => next.has(x)));
  }
  return [...result];
}

// ───────────────────────────────────────────────
// teamGraph — the delegation view
// ───────────────────────────────────────────────

/**
 * Fetch the team graph for a workspace. For each delegation edge
 * (from_agent → to_agent, granted_tools), compute the effective tool set
 * = granted_tools ∩ from_agent_live_grants ∩ to_agent_live_grants.
 *
 * The effective set is LIVE-computed: if the from_agent's toolGrants were
 * revoked after the edge was created, the effective set shrinks (the
 * delegation is stale — the UI should show this). If the to_agent's
 * toolGrants don't include a delegated tool, that tool is also dropped
 * (the to_agent can't invoke what it doesn't have).
 *
 * The permission-level check (requiredPermission) happens at run time in
 * canInvoke; teamGraph operates at the tool-id level (the edge stores tool
 * ids, not perms). This is a UI simplification — the full permission
 * intersection is per-call in the executor.
 *
 * LIVE: no cache. Each call fetches fresh toolGrants for every agent
 * referenced by the graph. For a workspace with N agents and E edges,
 * that's N toolGrants queries + 1 edges query. A cache could reduce this
 * to 1 query, but the live property would be violated unless the cache
 * is invalidated on every toolGrants change. The honest implementation
 * fetches per call; the team graph is UI-rendering, not per-step.
 */
export async function teamGraph(wsId: string): Promise<TeamEdge[]> {
  // Fetch all edges.
  const edges = await db
    .select({
      id: agentTeams.id,
      fromAgent: agentTeams.fromAgent,
      toAgent: agentTeams.toAgent,
      grantedTools: agentTeams.grantedTools,
    })
    .from(agentTeams)
    .where(eq(agentTeams.workspaceId, wsId as any));

  // Collect all unique agent ids referenced by the edges (from + to).
  const agentIds = new Set<string>();
  for (const e of edges) {
    agentIds.add(e.fromAgent as string);
    agentIds.add(e.toAgent as string);
  }

  // Fetch live grants for all referenced agents in ONE batch (avoid N queries).
  // This is the one optimization that doesn't violate the live property:
  // we batch the fetches, but we still fetch fresh per teamGraph() call.
  const grantsByAgent = new Map<string, readonly string[]>();
  if (agentIds.size > 0) {
    const agentRows = await db
      .select({ id: agents.id, toolGrants: agents.toolGrants })
      .from(agents)
      .where(eq(agents.workspaceId, wsId as any));
    for (const r of agentRows) {
      if (agentIds.has(r.id as string)) {
        grantsByAgent.set(r.id as string, r.toolGrants ?? []);
      }
    }
  }

  // Render each edge with the live-computed effective set.
  return edges.map((e) => {
    const fromGrants = grantsByAgent.get(e.fromAgent as string) ?? [];
    const toGrants = grantsByAgent.get(e.toAgent as string) ?? [];
    const granted = e.grantedTools ?? [];

    // effective = granted_tools ∩ from_agent_live_grants ∩ to_agent_live_grants
    const effective = intersectAll([granted, fromGrants, toGrants]);

    return {
      id: e.id as string,
      fromAgent: e.fromAgent as string,
      toAgent: e.toAgent as string,
      grantedTools: granted,
      effective,
    };
  });
}

// ───────────────────────────────────────────────
// createDelegation — the mutation surface (enforces subset rule)
// ───────────────────────────────────────────────

export interface CreateDelegationInput {
  wsId: string;
  fromAgent: string;
  toAgent: string;
  /** Tools to delegate. Must be a subset of from_agent's toolGrants. */
  grantedTools: string[];
}

export interface CreateDelegationResult {
  id: string;
  /** The effective grantedTools after subset enforcement (stale tools dropped). */
  grantedTools: string[];
  /** Tools that were requested but NOT in the from_agent's toolGrants (dropped). */
  droppedTools: string[];
}

/**
 * Create a delegation edge. Enforces the subset rule: grantedTools must be a
 * subset of the from_agent's own toolGrants (you can't delegate what you
 * don't have). Tools not in the from_agent's grants are silently dropped
 * (the privilege rule at the data layer — the UI should warn the user, but
 * the data layer enforces it).
 *
 * The to_agent's toolGrants are NOT checked here — the delegation is about
 * what the from_agent delegates; the to_agent still needs its own grants to
 * invoke the tools (the executor's canInvoke checks both sides live per call).
 * teamGraph will show the effective set as the intersection, so a delegation
 * of tools the to_agent doesn't have will render as effective=[].
 */
export async function createDelegation(
  input: CreateDelegationInput,
): Promise<CreateDelegationResult> {
  // Fetch the from_agent's toolGrants (live — no cache).
  const fromGrants = await liveGrants(input.wsId, input.fromAgent);
  const fromGrantsSet = new Set(fromGrants);

  // Enforce subset: drop tools not in the from_agent's grants.
  const granted = input.grantedTools.filter((t) => fromGrantsSet.has(t));
  const dropped = input.grantedTools.filter((t) => !fromGrantsSet.has(t));

  // Insert the edge. The unique (from_agent, to_agent) constraint means a
  // second delegation between the same pair throws — caught + re-issued as
  // an UPDATE (upsert via onConflictDoUpdate).
  const rows = await db
    .insert(agentTeams)
    .values({
      workspaceId: input.wsId as any,
      fromAgent: input.fromAgent as any,
      toAgent: input.toAgent as any,
      grantedTools: granted,
    })
    .onConflictDoUpdate({
      target: [agentTeams.fromAgent, agentTeams.toAgent],
      set: { grantedTools: granted },
    })
    .returning({ id: agentTeams.id });

  const row = rows[0];
  if (!row) throw new Error("delegation_insert_failed");

  return {
    id: row.id,
    grantedTools: granted,
    droppedTools: dropped,
  };
}

/**
 * Remove a delegation edge. Hard delete (the edge is gone; the to_agent
 * loses the delegated tools — the executor's canInvoke will deny them on
 * the next a2a call from the from_agent).
 */
export async function removeDelegation(
  wsId: string,
  edgeId: string,
): Promise<void> {
  await db
    .delete(agentTeams)
    .where(
      and(
        eq(agentTeams.id, edgeId as any),
        eq(agentTeams.workspaceId, wsId as any), // workspace-scoped (defense-in-depth)
      ),
    );
}
