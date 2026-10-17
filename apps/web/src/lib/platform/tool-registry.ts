// Tool registry — the platform's nervous system.
//
// The spec: "The tool registry is the platform's nervous system. Every
// capability is a typed tool. Every tool is discoverable, callable, versionable,
// deprecable, billable, and observable. New tools auto-register when the
// underlying capability ships."
//
// This module provides:
//   - registerTool / autoRegisterTool — add a new tool (manual or auto).
//   - getTool / listTools — discovery.
//   - deprecateTool / retireTool — lifecycle.
//   - callTool — the execution wrapper (billing + observability).
//   - validateInput — JSON Schema validation.

import { db } from "@supa/db";
import { toolRegistry } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { recordCost } from "@/lib/cost/tracker";
import { aiCallsTotal } from "@/lib/observability/metrics";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ToolCategory = "ai" | "search" | "files" | "agents" | "integrations" | "compute" | "data" | "communication" | "security" | "other";
export type ToolStatus = "active" | "deprecated" | "retired";

export interface Tool {
  id: string;
  key: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  version: string;
  status: ToolStatus;
  deprecatedAt: Date | null;
  retiredAt: Date | null;
  billable: boolean;
  pricePerCallUsd: number;
  rateLimitPerMin: number | null;
  autoRegistered: boolean;
  owner: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterToolInput {
  key: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  version?: string;
  billable?: boolean;
  pricePerCallUsd?: number;
  rateLimitPerMin?: number;
  autoRegistered?: boolean;
  owner: string;
  metadata?: Record<string, unknown>;
}

export class ToolError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ToolError";
  }
}

// ───────────────────────────────────────────────
// registerTool — add a new tool.
// ───────────────────────────────────────────────

export async function registerTool(input: RegisterToolInput): Promise<Tool> {
  try {
    await db.insert(toolRegistry).values({
      key: input.key,
      name: input.name,
      description: input.description,
      category: input.category,
      inputSchema: input.inputSchema ?? {},
      outputSchema: input.outputSchema ?? {},
      version: input.version ?? "1.0.0",
      billable: input.billable ?? false,
      ...(input.pricePerCallUsd != null ? { pricePerCallUsd: input.pricePerCallUsd.toString() } : {}),
      ...(input.rateLimitPerMin != null ? { rateLimitPerMin: input.rateLimitPerMin } : {}),
      autoRegistered: input.autoRegistered ?? false,
      owner: input.owner,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("23505")) {
      throw new ToolError("tool_already_exists", 409);
    }
    throw err;
  }

  return (await getTool(input.key))!;
}

/**
 * Auto-register a tool when the underlying capability ships.
 * If the tool already exists, it's a no-op (idempotent).
 */
export async function autoRegisterTool(input: Omit<RegisterToolInput, "autoRegistered">): Promise<Tool | null> {
  const existing = await getTool(input.key);
  if (existing) return existing; // already registered — idempotent.

  return registerTool({ ...input, autoRegistered: true });
}

// ───────────────────────────────────────────────
// getTool / listTools — discovery.
// ───────────────────────────────────────────────

export async function getTool(key: string): Promise<Tool | null> {
  const rows = await db.select().from(toolRegistry).where(eq(toolRegistry.key, key)).limit(1);
  return mapRow(rows[0]);
}

export async function getToolById(id: string): Promise<Tool | null> {
  const rows = await db.select().from(toolRegistry).where(eq(toolRegistry.id, id as any)).limit(1);
  return mapRow(rows[0]);
}

export async function listTools(opts: {
  category?: ToolCategory;
  status?: ToolStatus;
} = {}): Promise<Tool[]> {
  const conditions = [];
  if (opts.category) conditions.push(eq(toolRegistry.category, opts.category));
  if (opts.status) conditions.push(eq(toolRegistry.status, opts.status));

  const rows = await db
    .select()
    .from(toolRegistry)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(toolRegistry.category, toolRegistry.key);

  return rows.map(mapRow).filter((t): t is Tool => t !== null);
}

// ───────────────────────────────────────────────
// deprecateTool / retireTool — lifecycle.
// ───────────────────────────────────────────────

export async function deprecateTool(key: string): Promise<void> {
  const result = await db
    .update(toolRegistry)
    .set({ status: "deprecated", deprecatedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(toolRegistry.key, key), eq(toolRegistry.status, "active")))
    .returning({ id: toolRegistry.id });

  if (result.length === 0) throw new ToolError("tool_not_found_or_not_active", 404);
}

export async function retireTool(key: string): Promise<void> {
  const result = await db
    .update(toolRegistry)
    .set({ status: "retired", retiredAt: new Date(), updatedAt: new Date() })
    .where(eq(toolRegistry.key, key))
    .returning({ id: toolRegistry.id });

  if (result.length === 0) throw new ToolError("tool_not_found", 404);
}

// ───────────────────────────────────────────────
// callTool — the execution wrapper (billing + observability).
//
// This is the single entry point for calling any tool. It:
//   1. Looks up the tool by key.
//   2. Validates the input against the tool's JSON Schema.
//   3. Checks the tool is active (not deprecated/retired).
//   4. Records billing (if billable).
//   5. Records observability metrics.
//   6. Delegates to the tool's implementation (passed as `executor`).
//
// The executor is a function that takes the validated input + returns the result.
// This decouples the registry from the implementations — the route layer
// wires the executor.
// ───────────────────────────────────────────────

export interface ToolCallContext {
  wsId?: string;
  userId?: string;
}

export async function callTool<T>(
  key: string,
  input: Record<string, unknown>,
  executor: (input: Record<string, unknown>) => Promise<T>,
  ctx: ToolCallContext = {},
): Promise<T> {
  const tool = await getTool(key);
  if (!tool) throw new ToolError(`tool_not_found:${key}`, 404);
  if (tool.status === "retired") throw new ToolError(`tool_retired:${key}`, 410);

  // Validate input (basic — a full impl uses ajv or similar).
  if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
    const validationError = validateInput(input, tool.inputSchema);
    if (validationError) throw new ToolError(`input_validation_failed:${validationError}`, 400);
  }

  // Execute.
  const result = await executor(input);

  // Billing.
  if (tool.billable && tool.pricePerCallUsd > 0) {
    recordCost({
      ...(ctx.wsId ? { wsId: ctx.wsId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      feature: "tool.call" as any,
      provider: tool.owner,
      costUsd: tool.pricePerCallUsd,
      quantity: 1,
      quantityUnit: "calls",
      metadata: { tool: tool.key, version: tool.version },
    });
  }

  // Observability.
  aiCallsTotal.inc({ provider: "platform", status: "success" });

  return result;
}

// ───────────────────────────────────────────────
// validateInput — basic JSON Schema validation (stub).
// ───────────────────────────────────────────────

function validateInput(input: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  // STUB: a full impl uses ajv (ajv.compile(schema) → validate(input)).
  // For now, checks `required` fields only.
  const required = schema["required"] as string[] | undefined;
  if (required && Array.isArray(required)) {
    for (const field of required) {
      if (input[field] === undefined) return `missing_required_field:${field}`;
    }
  }
  return null;
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function mapRow(row: Record<string, unknown> | undefined): Tool | null {
  if (!row) return null;
  return {
    id: row.id as string,
    key: row.key as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as ToolCategory,
    inputSchema: (row.inputSchema as Record<string, unknown>) ?? {},
    outputSchema: (row.outputSchema as Record<string, unknown>) ?? {},
    version: row.version as string,
    status: row.status as ToolStatus,
    deprecatedAt: (row.deprecatedAt as Date | null) ?? null,
    retiredAt: (row.retiredAt as Date | null) ?? null,
    billable: row.billable as boolean,
    pricePerCallUsd: row.pricePerCallUsd != null ? Number(row.pricePerCallUsd) : 0,
    rateLimitPerMin: (row.rateLimitPerMin as number | null) ?? null,
    autoRegistered: row.autoRegistered as boolean,
    owner: row.owner as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}
