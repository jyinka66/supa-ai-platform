// Transparency — user-facing + auditor-facing decision log.
//
// The spec (Section 2): "Transparency for users. Users can see what actions were
// taken on their behalf, why, and how to stop them. Transparency for auditors.
// Regulators, partners, and enterprise customers can verify decisions without
// accessing user data."

import { db } from "@supa/db";
import { governanceTransparencyLog } from "@supa/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface TransparencyEntry {
  id: string;
  userId: string | null;
  wsId: string | null;
  actionType: string;
  targetType: string;
  targetId: string;
  decision: string;
  riskLevel: string;
  policyKey: string | null;
  reasoningSummary: string;
  userVisible: boolean;
  userMessage: string | null;
  auditorVisible: boolean;
  createdAt: Date;
}

// ───────────────────────────────────────────────
// logTransparency — record a transparency entry.
// ───────────────────────────────────────────────

export async function logTransparency(input: {
  userId?: string;
  wsId?: string;
  actionType: string;
  targetType: string;
  targetId: string;
  decision: string;
  riskLevel: string;
  policyKey?: string;
  reasoningSummary: string;
  userVisible?: boolean;
  userMessage?: string;
  auditorVisible?: boolean;
  auditorEvidence?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(governanceTransparencyLog).values({
      ...(input.userId ? { userId: input.userId as any } : {}),
      ...(input.wsId ? { workspaceId: input.wsId as any } : {}),
      actionType: input.actionType,
      targetType: input.targetType,
      targetId: input.targetId,
      decision: input.decision,
      riskLevel: input.riskLevel,
      ...(input.policyKey ? { policyKey: input.policyKey } : {}),
      reasoningSummary: input.reasoningSummary,
      userVisible: input.userVisible ?? true,
      ...(input.userMessage ? { userMessage: input.userMessage } : {}),
      auditorVisible: input.auditorVisible ?? false,
      auditorEvidence: input.auditorEvidence ?? {},
    });
  } catch {
    // Transparency logging must never fail the operation.
  }
}

// ───────────────────────────────────────────────
// getUserTransparency — what was done on the user's behalf.
// ───────────────────────────────────────────────

export async function getUserTransparency(userId: string, limit: number = 50): Promise<TransparencyEntry[]> {
  const rows = await db.execute(sql`
    select id, user_id, ws_id, action_type, target_type, target_id,
           decision, risk_level, policy_key, reasoning_summary,
           user_visible, user_message, created_at
    from governance_transparency_log
    where user_id = ${userId}::uuid and user_visible = true
    order by created_at desc
    limit ${limit}
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    wsId: (r.ws_id as string | null) ?? null,
    actionType: r.action_type as string,
    targetType: r.target_type as string,
    targetId: r.target_id as string,
    decision: r.decision as string,
    riskLevel: r.risk_level as string,
    policyKey: (r.policy_key as string | null) ?? null,
    reasoningSummary: r.reasoning_summary as string,
    userVisible: r.user_visible as boolean,
    userMessage: (r.user_message as string | null) ?? null,
    auditorVisible: false,
    createdAt: r.created_at as Date,
  }));
}

// ───────────────────────────────────────────────
// getWorkspaceTransparency — what was done in a workspace.
// ───────────────────────────────────────────────

export async function getWorkspaceTransparency(wsId: string, limit: number = 50): Promise<TransparencyEntry[]> {
  const rows = await db.execute(sql`
    select id, user_id, ws_id, action_type, target_type, target_id,
           decision, risk_level, policy_key, reasoning_summary,
           user_visible, user_message, created_at
    from governance_transparency_log
    where ws_id = ${wsId}::uuid and user_visible = true
    order by created_at desc
    limit ${limit}
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    wsId: (r.ws_id as string | null) ?? null,
    actionType: r.action_type as string,
    targetType: r.target_type as string,
    targetId: r.target_id as string,
    decision: r.decision as string,
    riskLevel: r.risk_level as string,
    policyKey: (r.policy_key as string | null) ?? null,
    reasoningSummary: r.reasoning_summary as string,
    userVisible: r.user_visible as boolean,
    userMessage: (r.user_message as string | null) ?? null,
    auditorVisible: false,
    createdAt: r.created_at as Date,
  }));
}

// ───────────────────────────────────────────────
// getAuditorEvidence — verify decisions without accessing user data.
// ───────────────────────────────────────────────

export async function getAuditorEvidence(opts: {
  framework?: string;
  riskLevel?: string;
  limit?: number;
} = {}): Promise<Array<{
  id: string;
  actionType: string;
  targetType: string;
  decision: string;
  riskLevel: string;
  policyKey: string | null;
  reasoningSummary: string;
  auditorEvidence: Record<string, unknown>;
  createdAt: Date;
}>> {
  const conditions: string[] = ["auditor_visible = true"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.riskLevel) {
    conditions.push(`risk_level = $${paramIdx++}`);
    params.push(opts.riskLevel);
  }

  const limit = opts.limit ?? 100;
  const query = `
    select id, action_type, target_type, decision, risk_level, policy_key,
           reasoning_summary, auditor_evidence, created_at
    from governance_transparency_log
    where ${conditions.join(" and ")}
    order by created_at desc
    limit $${paramIdx}
  `;
  params.push(limit);

  const rows = await db.execute(sql.raw(query));

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    actionType: r.action_type as string,
    targetType: r.target_type as string,
    decision: r.decision as string,
    riskLevel: r.risk_level as string,
    policyKey: (r.policy_key as string | null) ?? null,
    reasoningSummary: r.reasoning_summary as string,
    auditorEvidence: (r.auditor_evidence as Record<string, unknown>) ?? {},
    createdAt: r.created_at as Date,
  }));
}
