// Developer sandbox — free tier, self-provisioning, SDKs, community.
//
// The spec (14.2.5): "Free developer tier — no credit card, generous limits,
// isolated from production. Self-provisioning — developers create sandbox
// workspaces, API keys, and test data themselves."

import { db } from "@supa/db";
import { sandboxWorkspaces } from "@supa/db/schema";
import { eq, and, sql, lte } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface Sandbox {
  id: string;
  developerOrgId: string;
  workspaceId: string | null;
  name: string;
  apiKey: string;          // returned only on creation.
  rateLimitPerMin: number;
  monthlyBudgetUsd: number;
  maxTools: number;
  maxAgents: number;
  status: "active" | "expired" | "converted" | "terminated";
  expiresAt: Date;
  totalApiCalls: number;
  totalCostUsd: number;
  createdAt: Date;
}

export interface ConversionPrompt {
  shouldPrompt: boolean;
  reason: string;
  usagePct: number;  // % of limits used.
}

// ───────────────────────────────────────────────
// Limits (generous free tier).
// ───────────────────────────────────────────────

export const SANDBOX_LIMITS = {
  rateLimitPerMin: 100,
  monthlyBudgetUsd: 10,
  maxTools: 50,
  maxAgents: 10,
  ttlHours: 168, // 7 days (renewable).
};

// ───────────────────────────────────────────────
// provisionSandbox — self-provisioning.
// ───────────────────────────────────────────────

export async function provisionSandbox(input: {
  developerOrgId: string;
  name: string;
  workspaceId?: string;
}): Promise<Sandbox> {
  const apiKey = `sb_${randomBytes(32).toString("base64url")}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const expiresAt = new Date(Date.now() + SANDBOX_LIMITS.ttlHours * 3600000);

  const rows = await db
    .insert(sandboxWorkspaces)
    .values({
      developerOrgId: input.developerOrgId as any,
      ...(input.workspaceId ? { workspaceId: input.workspaceId as any } : {}),
      name: input.name,
      apiKeyHash,
      rateLimitPerMin: SANDBOX_LIMITS.rateLimitPerMin,
      monthlyBudgetUsd: SANDBOX_LIMITS.monthlyBudgetUsd.toString(),
      maxTools: SANDBOX_LIMITS.maxTools,
      maxAgents: SANDBOX_LIMITS.maxAgents,
      status: "active",
      expiresAt,
    })
    .returning({ id: sandboxWorkspaces.id });

  const id = rows[0]?.id as string;
  if (!id) throw new Error("sandbox_insert_failed");

  return {
    id,
    developerOrgId: input.developerOrgId,
    workspaceId: input.workspaceId ?? null,
    name: input.name,
    apiKey, // returned only on creation.
    rateLimitPerMin: SANDBOX_LIMITS.rateLimitPerMin,
    monthlyBudgetUsd: SANDBOX_LIMITS.monthlyBudgetUsd,
    maxTools: SANDBOX_LIMITS.maxTools,
    maxAgents: SANDBOX_LIMITS.maxAgents,
    status: "active",
    expiresAt,
    totalApiCalls: 0,
    totalCostUsd: 0,
    createdAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// renewSandbox — extend the TTL.
// ───────────────────────────────────────────────

export async function renewSandbox(sandboxId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SANDBOX_LIMITS.ttlHours * 3600000);
  await db
    .update(sandboxWorkspaces)
    .set({ expiresAt, status: "active", updatedAt: new Date() })
    .where(and(eq(sandboxWorkspaces.id, sandboxId as any), eq(sandboxWorkspaces.status, "active")));
}

// ───────────────────────────────────────────────
// checkConversionPrompt — automated upgrade prompts based on usage.
// ───────────────────────────────────────────────

export async function checkConversionPrompt(sandboxId: string): Promise<ConversionPrompt> {
  const rows = await db
    .select()
    .from(sandboxWorkspaces)
    .where(eq(sandboxWorkspaces.id, sandboxId as any))
    .limit(1);
  const sandbox = rows[0];
  if (!sandbox || sandbox.status !== "active") {
    return { shouldPrompt: false, reason: "not_active", usagePct: 0 };
  }

  const budgetUsed = Number(sandbox.totalCostUsd);
  const budgetPct = (budgetUsed / Number(sandbox.monthlyBudgetUsd)) * 100;
  const callPct = (sandbox.totalApiCalls / 10000) * 100; // 10k calls = 100%.
  const usagePct = Math.max(budgetPct, callPct);

  if (usagePct >= 80) {
    return { shouldPrompt: true, reason: "approaching_limits", usagePct };
  }
  if (sandbox.totalApiCalls > 5000) {
    return { shouldPrompt: true, reason: "high_usage", usagePct };
  }
  return { shouldPrompt: false, reason: "within_limits", usagePct };
}

// ───────────────────────────────────────────────
// convertToPaid — upgrade a sandbox to a paid workspace.
// ───────────────────────────────────────────────

export async function convertToPaid(sandboxId: string): Promise<void> {
  await db
    .update(sandboxWorkspaces)
    .set({ status: "converted", convertedToPaidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sandboxWorkspaces.id, sandboxId as any), eq(sandboxWorkspaces.status, "active")));
}

// ───────────────────────────────────────────────
// expireSandboxes — cron to expire past-TTL sandboxes.
// ───────────────────────────────────────────────

export async function expireSandboxes(): Promise<number> {
  const result = await db
    .update(sandboxWorkspaces)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(sandboxWorkspaces.status, "active"), lte(sandboxWorkspaces.expiresAt, new Date())))
    .returning({ id: sandboxWorkspaces.id });

  return result.length;
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getSandbox(id: string): Promise<Sandbox | null> {
  const rows = await db.select().from(sandboxWorkspaces).where(eq(sandboxWorkspaces.id, id as any)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    developerOrgId: row.developerOrgId as string,
    workspaceId: (row.workspaceId as string | null) ?? null,
    name: row.name,
    apiKey: "[redacted]", // never expose the API key after creation.
    rateLimitPerMin: row.rateLimitPerMin,
    monthlyBudgetUsd: Number(row.monthlyBudgetUsd),
    maxTools: row.maxTools,
    maxAgents: row.maxAgents,
    status: row.status as "active" | "expired" | "converted" | "terminated",
    expiresAt: row.expiresAt,
    totalApiCalls: row.totalApiCalls,
    totalCostUsd: Number(row.totalCostUsd),
    createdAt: row.createdAt,
  };
}

export async function listSandboxes(developerOrgId: string): Promise<Sandbox[]> {
  const rows = await db
    .select()
    .from(sandboxWorkspaces)
    .where(eq(sandboxWorkspaces.developerOrgId, developerOrgId as any))
    .orderBy(sandboxWorkspaces.createdAt);

  return rows.map((row) => ({
    id: row.id as string,
    developerOrgId: row.developerOrgId as string,
    workspaceId: (row.workspaceId as string | null) ?? null,
    name: row.name,
    apiKey: "[redacted]",
    rateLimitPerMin: row.rateLimitPerMin,
    monthlyBudgetUsd: Number(row.monthlyBudgetUsd),
    maxTools: row.maxTools,
    maxAgents: row.maxAgents,
    status: row.status as "active" | "expired" | "converted" | "terminated",
    expiresAt: row.expiresAt,
    totalApiCalls: row.totalApiCalls,
    totalCostUsd: Number(row.totalCostUsd),
    createdAt: row.createdAt,
  }));
}
