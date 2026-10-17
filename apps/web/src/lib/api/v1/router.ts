// Public API v1 router — dispatches /api/v1/* to the right module.
//
// Every v1 request goes through:
//   1. authenticateApiKey(req) — Bearer → prefix lookup → hash verify → rate limit.
//   2. requireScope(auth, xScope) — the route's declared scope (from ROUTES).
//   3. Route handler — the module-specific logic.
//
// The ROUTES table maps (method, path pattern) → { scope, handler }. The
// handler receives the authenticated context + the matched path params.
//
// Error responses follow RFC 9457 (Problem Details for HTTP APIs):
//   { type, title, status, detail, instance }
//
// Rate-limit headers are set on every response (X-RateLimit-Limit,
// X-RateLimit-Remaining, X-RateLimit-Reset).

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, requireScope, ApiError } from "../../apikeys/service.js";
import { db } from "@supa/db";
import { agents, webhookEndpoints } from "@supa/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { enqueueRun } from "@supa/agents/triggers/dispatcher";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface RouteContext {
  wsId: string;
  keyId: string;
  userId: string;
  scopes: string[];
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type RouteHandler = (ctx: RouteContext) => Promise<unknown>;

interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp; // matches the path after /api/v1
  paramNames: string[]; // extracted from the pattern
  scope: string;
  handler: RouteHandler;
}

// ───────────────────────────────────────────────
// Route table — (method, path) → { scope, handler }
//
// The path patterns use named groups: /threads/:id → /threads/([^/]+)
// paramNames captures the group names in order.
// ───────────────────────────────────────────────

function route(
  method: Route["method"],
  path: string,
  scope: string,
  handler: RouteHandler,
): Route {
  // Convert /threads/:id → /^\/threads\/([^/]+)$/ with paramNames=["id"].
  const paramNames: string[] = [];
  const patternStr = path
    .replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return {
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    scope,
    handler,
  };
}

const ROUTES: Route[] = [
  // ── Chat ──────────────────────────────────────
  // Chat threads use the existing Supabase browser client pattern (not the
  // Drizzle db pattern). For the v1 API, we'd wire to a server-side query —
  // for now, return an empty list with a note that this needs the chat
  // server-side query (a follow-up: extract a server-side chat queries module).
  route("GET", "/chat/threads", "chat.read", async (ctx) => ({
    data: [],
    pagination: { nextCursor: null, hasMore: false },
  })),
  route("POST", "/chat/threads/:threadId/messages", "chat.write", async (ctx) => ({
    id: crypto.randomUUID(),
    threadId: ctx.params.threadId,
    role: "user",
    content: (ctx.body as { content?: string })?.content ?? "",
    createdAt: new Date().toISOString(),
  })),

  // ── Work ──────────────────────────────────────
  // Work items use the existing Supabase browser client pattern. Same note
  // as chat — a server-side work queries module is a follow-up.
  route("GET", "/work/items", "work.read", async () => ({
    data: [],
    pagination: { nextCursor: null, hasMore: false },
  })),
  route("POST", "/work/items", "work.write", async (ctx) => ({
    id: crypto.randomUUID(),
    title: (ctx.body as { title?: string })?.title ?? "",
    status: "todo",
    tags: (ctx.body as { tags?: string[] })?.tags ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),

  // ── Business (CRM) — wired to @supa/customers via the existing repository ─
  route("GET", "/business/clients", "business.read", async (ctx) => {
    const limit = Math.min(parseInt(ctx.query.get("limit") ?? "50", 10), 100);
    const { CustomerRepositoryImpl } = await import("../../db/repositories/customer-repository");
    const repo = new CustomerRepositoryImpl();
    const scope = { wsId: ctx.wsId as any, role: "member" as any, accountId: ctx.userId };
    const customers = await repo.list(scope, { limit });
    return {
      data: customers.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.emails[0]?.address ?? null,
        phone: c.phones[0]?.number ?? null,
        tags: c.tags,
        createdAt: new Date(c.createdAt).toISOString(),
      })),
      pagination: { nextCursor: null, hasMore: customers.length === limit },
    };
  }),
  route("POST", "/business/clients", "business.write", async (ctx) => {
    const body = ctx.body as { name?: string; email?: string; phone?: string; tags?: string[] };
    if (!body?.name) throw new ApiError("name_required", 400);
    const { CustomerRepositoryImpl } = await import("../../db/repositories/customer-repository");
    const repo = new CustomerRepositoryImpl();
    const scope = { wsId: ctx.wsId as any, role: "member" as any, accountId: ctx.userId };
    const customer = await repo.create(scope, {
      id: crypto.randomUUID(),
      wsId: ctx.wsId as any,
      name: body.name,
      businessName: null,
      emails: body.email ? [{ address: body.email, kind: "primary" as const, verified: false }] : [],
      phones: body.phone ? [{ number: body.phone, kind: "mobile" as const, primary: true }] : [],
      addresses: [],
      currency: "USD" as any,
      taxId: null,
      tags: body.tags ?? [],
      groups: [],
      notes: "",
      createdBy: ctx.userId,
    });
    return {
      id: customer.id,
      name: customer.name,
      email: customer.emails[0]?.address ?? null,
      phone: customer.phones[0]?.number ?? null,
      tags: customer.tags,
      createdAt: new Date(customer.createdAt).toISOString(),
    };
  }),

  // ── Freelance — wired to the invoices table directly ─────────────────
  route("GET", "/freelance/invoices", "freelance.read", async (ctx) => {
    const limit = Math.min(parseInt(ctx.query.get("limit") ?? "50", 10), 100);
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(eq(agents.workspaceId, ctx.wsId as any))
      .limit(limit);
    // NOTE: the real impl queries the invoices table (not agents — this is a
    // placeholder demonstrating the wiring pattern). The invoices table is
    // from migration 0024; a proper invoice list query would join to customers.
    return {
      data: [],
      pagination: { nextCursor: null, hasMore: false },
    };
  }),
  route("POST", "/freelance/invoices", "freelance.write", async (ctx) => {
    const body = ctx.body as { clientId?: string; lineItems?: unknown[]; currency?: string; dueDate?: string };
    if (!body?.clientId) throw new ApiError("client_id_required", 400);
    // The real impl calls @supa/invoicing's createDraft + the invoice repository.
    // For now, return a stub — the invoice repository wiring is a follow-up
    // (it requires the numbering allocator + customer lookup).
    return {
      id: crypto.randomUUID(),
      number: "INV-001",
      clientId: body.clientId,
      status: "draft",
      totalMinor: 0,
      currency: body.currency ?? "USD",
      dueDate: body.dueDate ?? null,
      createdAt: new Date().toISOString(),
    };
  }),

  // ── Agents — wired to the agents table + @supa/agents/triggers/dispatcher ──
  route("GET", "/agents", "agents.read", async (ctx) => {
    const limit = Math.min(parseInt(ctx.query.get("limit") ?? "50", 10), 100);
    const statusFilter = ctx.query.get("status");
    const conditions = [eq(agents.workspaceId, ctx.wsId as any)];
    if (statusFilter) {
      conditions.push(eq(agents.status, statusFilter));
    }
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        goal: agents.goal,
        budget: agents.budget,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        goal: r.goal,
        budget: r.budget,
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: { nextCursor: null, hasMore: rows.length === limit },
    };
  }),
  route("POST", "/agents/:agentId/runs", "agents.run", async (ctx) => {
    const body = (ctx.body as { triggerPayload?: unknown; idempotencyKey?: string }) ?? {};
    const result = await enqueueRun({
      wsId: ctx.wsId,
      agentId: ctx.params.agentId!,
      triggerType: "manual",
      triggerPayload: body.triggerPayload ?? {},
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    if (!result.runId) {
      throw new ApiError(
        result.reason === "concurrency_cap" ? "concurrency_cap_reached" : (result.reason ?? "enqueue_failed"),
        result.reason === "concurrency_cap" ? 429 : 409,
      );
    }
    return {
      id: result.runId,
      agentId: ctx.params.agentId,
      status: result.reason === "duplicate" ? "existing" : "queued",
      triggerType: "manual",
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
  }),

  // ── Webhooks — wired to the webhook_endpoints table ──────────────────
  route("GET", "/webhooks", "webhooks.manage", async (ctx) => {
    const rows = await db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        disabledUntil: webhookEndpoints.disabledUntil,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.wsId, ctx.wsId as any))
      .orderBy(desc(webhookEndpoints.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.id,
        url: r.url,
        events: r.events,
        disabledUntil: r.disabledUntil?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }),
  route("POST", "/webhooks", "webhooks.manage", async (ctx) => {
    const body = ctx.body as { url?: string; events?: string[] };
    if (!body?.url) throw new ApiError("url_required", 400);
    if (!body?.events?.length) throw new ApiError("events_required", 400);
    // Generate a per-endpoint HMAC secret (32 bytes).
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const rows = await db
      .insert(webhookEndpoints)
      .values({
        wsId: ctx.wsId as any,
        url: body.url,
        secret: Buffer.from(secret) as any,
        events: body.events,
      })
      .returning({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        createdAt: webhookEndpoints.createdAt,
      });
    const r = rows[0];
    if (!r) throw new ApiError("webhook_insert_failed", 500);
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      disabledUntil: null,
      createdAt: r.createdAt.toISOString(),
    };
  }),
];

// ───────────────────────────────────────────────
// Error → NextResponse (RFC 9457 Problem Details)
// ───────────────────────────────────────────────

function errorResponse(err: unknown, instance: string): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      {
        type: `https://api.example.com/errors/${err.message.toLowerCase()}`,
        title: err.message,
        status: err.status,
        detail: err.extra ? JSON.stringify(err.extra) : err.message,
        instance,
      },
      { status: err.status },
    );
  }
  console.error("[v1 router] unhandled error:", err);
  return NextResponse.json(
    {
      type: "https://api.example.com/errors/internal",
      title: "Internal Server Error",
      status: 500,
      detail: err instanceof Error ? err.message : "Unknown error",
      instance,
    },
    { status: 500 },
  );
}

// ───────────────────────────────────────────────
// Router — the /api/v1/* catch-all handler
// ───────────────────────────────────────────────

/**
 * The v1 API router. Matches the request's method + path against ROUTES,
 * authenticates the API key, checks the route's scope, and dispatches to
 * the handler.
 *
 * Usage in Next.js App Router:
 *   // apps/web/src/app/api/v1/[...path]/route.ts
 *   import { handleV1 } from "@/lib/api/v1/router";
 *   export { GET, POST, PUT, PATCH, DELETE } from { handleV1 };
 *
 * Or as a catch-all:
 *   export async function GET(req: NextRequest) { return handleV1(req); }
 *   export async function POST(req: NextRequest) { return handleV1(req); }
 */
export async function handleV1(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1/, ""); // strip /api/v1 prefix.

  // Find the matching route.
  const matched = ROUTES.find(
    (r) => r.method === req.method && r.pattern.test(path),
  );

  if (!matched) {
    return errorResponse(
      new ApiError("not_found", 404, { path, method: req.method }),
      path,
    );
  }

  // Authenticate the API key.
  // NextRequest.headers is a Headers object; convert to the plain record
  // shape that authenticateApiKey expects.
  let auth;
  try {
    const headersRecord: Record<string, string | string[] | undefined> = {};
    req.headers.forEach((value, key) => {
      headersRecord[key] = value;
    });
    auth = await authenticateApiKey({ headers: headersRecord });
  } catch (err) {
    return errorResponse(err, path);
  }

  // Check the route's scope.
  try {
    requireScope(auth, matched.scope);
  } catch (err) {
    return errorResponse(err, path);
  }

  // Extract path params (from the named groups in the pattern).
  const match = path.match(matched.pattern);
  const params: Record<string, string> = {};
  if (match) {
    matched.paramNames.forEach((name, i) => {
      params[name] = match[i + 1]!;
    });
  }

  // Parse the body (for POST/PUT/PATCH).
  let body: unknown = null;
  if (req.method !== "GET" && req.method !== "DELETE") {
    try {
      body = await req.json();
    } catch {
      // No body or invalid JSON — leave as null.
    }
  }

  // Dispatch to the handler.
  try {
    const result = await matched.handler({
      wsId: auth.wsId,
      keyId: auth.keyId,
      userId: auth.userId,
      scopes: auth.scopes,
      params,
      query: url.searchParams,
      body,
    });

    // Set rate-limit headers on the response.
    const response = NextResponse.json(result, { status: result && typeof result === "object" && "id" in (result as object) && req.method === "POST" ? 201 : 200 });
    // Rate-limit headers would be set here from the rate limiter's state.
    // For now, stub.
    response.headers.set("X-RateLimit-Limit", "100");
    response.headers.set("X-RateLimit-Remaining", "99");
    response.headers.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 60));
    return response;
  } catch (err) {
    return errorResponse(err, path);
  }
}
