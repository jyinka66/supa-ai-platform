import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { searchWorkItems, type SearchParams } from "@/lib/work/search";
import { db } from "@supa/db";
import { savedSearches, searchHistory } from "@supa/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { pino } from "@/lib/observability/logger";

const log = pino.child({ route: "work/items" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  // Search query (optional — empty = filter-only)
  q: z.string().max(500).optional().default(""),

  // Filters
  type: z.string().optional(),
  folder: z.string().uuid().nullable().optional(),
  tags: z.string().optional(), // comma-separated tag IDs
  favorite: z.boolean().optional(),
  shared: z.enum(["workspace", "link", "private"]).optional(),
  ownerId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),

  // Sort
  sort: z.enum([
    "relevance",
    "updated",
    "created",
    "title",
    "recently_viewed",
  ]).default("updated"),

  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  // View mode (UI hint — doesn't affect query, but stored for analytics)
  view: z.enum(["grid", "list", "kanban"]).optional(),

  // Save to history (default: true)
  saveHistory: z.boolean().default(true),
});

/**
 * GET /api/work/items
 *
 * Unified search + filter endpoint for work items.
 *
 * Query params:
 *   q=invoice              — search query (optional; empty = filter-only)
 *   type=invoice            — filter by item type
 *   folder=<uuid>           — filter by folder (null = root, omit = all)
 *   tags=urgent,q4         — comma-separated tag IDs
 *   favorite=true           — only favorites
 *   shared=workspace        — visibility filter
 *   ownerId=<uuid>          — filter by owner
 *   dateFrom=2024-01-01T00:00:00Z — updated_at >= dateFrom
 *   dateTo=...              — updated_at <= dateTo
 *   sort=relevance          — relevance|updated|created|title|recently_viewed
 *   page=1                  — 1-indexed page
 *   limit=20                — page size (max 100)
 *   view=grid               — UI view mode (grid|list|kanban)
 *   saveHistory=true        — save to search_history (default: true)
 *
 * The route delegates to `searchWorkItems()` which classifies the query
 * into FTS / trigram / filter tiers.
 *
 * Rate-limited at the `default` tier (100/min).
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  // Parse + validate query params.
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    type: url.searchParams.get("type") ?? undefined,
    folder: url.searchParams.get("folder") === "null" ? null : url.searchParams.get("folder"),
    tags: url.searchParams.get("tags") ?? undefined,
    favorite: url.searchParams.get("favorite") === "true" ? true : undefined,
    shared: url.searchParams.get("shared") ?? undefined,
    ownerId: url.searchParams.get("ownerId") ?? undefined,
    dateFrom: url.searchParams.get("dateFrom") ?? undefined,
    dateTo: url.searchParams.get("dateTo") ?? undefined,
    sort: url.searchParams.get("sort") ?? "updated",
    page: url.searchParams.get("page") ?? 1,
    limit: url.searchParams.get("limit") ?? 20,
    view: url.searchParams.get("view") ?? undefined,
    saveHistory: url.searchParams.get("saveHistory") !== "false",
  });

  if (!parsed.success) {
    return problem(400, "invalid_params", parsed.error.issues[0]?.message);
  }
  const p = parsed.data;

  // Parse comma-separated tag IDs.
  const tagIds = p.tags
    ? p.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  // Build the search params.
  const searchParams: SearchParams = {
    query: p.q,
    workspaceId: "", // will be set below — we need the user's current workspace
    userId: user.id,
    type: p.type,
    folderId: p.folder,
    tagIds,
    favorite: p.favorite,
    ownerId: p.ownerId,
    includeTrash: false,
    offset: (p.page - 1) * p.limit,
    limit: p.limit,
    sort: p.sort === "recently_viewed" ? "updated" : p.sort, // recently_viewed → updated for now
  };

  // Resolve the user's current workspace from the `ws` cookie.
  // TODO: if no cookie, use the user's personal workspace.
  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) {
    return problem(400, "no_workspace_selected", "Set the `ws` cookie to your workspace ID");
  }
  searchParams.workspaceId = wsCookie;

  // Execute the search.
  const result = await searchWorkItems(searchParams);

  // Save to search history (fire-and-forget — don't block the response).
  if (p.saveHistory && p.q) {
    void db.insert(searchHistory).values({
      userId: user.id,
      workspaceId: wsCookie,
      query: p.q,
      filters: {
        type: p.type ?? null,
        folderId: p.folder ?? null,
        tagIds: tagIds ?? null,
        favorite: p.favorite ?? null,
        shared: p.shared ?? null,
        ownerId: p.ownerId ?? null,
        dateFrom: p.dateFrom ?? null,
        dateTo: p.dateTo ?? null,
      },
      resultCount: result.total,
      tier: result.tier,
    }).catch((err) => {
      log.warn({ event: "search_history_save_failed", error: String(err) });
    });
  }

  return ok({
    items: result.items,
    total: result.total,
    tier: result.tier,
    ftsCount: result.ftsCount,
    page: p.page,
    limit: p.limit,
    totalPages: Math.ceil(result.total / p.limit),
    view: p.view,
  });
}

/**
 * POST /api/work/items
 *
 * Creates a new work item via the capture pipeline.
 * Delegates to `captureWorkItem()` which handles auto-tagging + post-processing.
 */
const CreateBody = z.object({
  type: z.enum([
    "chat_reply", "tool_output", "design", "invoice",
    "proposal", "plan", "translation", "code",
    "image", "document", "agent_output", "upload",
  ]),
  title: z.string().max(200).optional(),
  content: z.string().max(1_000_000).optional(),
  contentFormat: z.enum(["markdown", "html", "json", "code", "none"]).default("markdown"),
  fileUrl: z.string().optional(),
  fileSize: z.number().int().min(0).optional(),
  fileMime: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  folderId: z.string().uuid().optional(),
  sourceType: z.enum([
    "conversation", "agent_run", "invoice_run",
    "upload", "design_editor", "manual",
  ]).optional(),
  sourceId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  // Resolve workspace from cookie.
  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) {
    return problem(400, "no_workspace_selected");
  }

  const { captureWorkItem } = await import("@/lib/work/capture");
  const item = await captureWorkItem({
    workspaceId: wsCookie,
    userId: user.id,
    type: parsed.data.type,
    title: parsed.data.title,
    content: parsed.data.content,
    contentFormat: parsed.data.contentFormat,
    fileUrl: parsed.data.fileUrl,
    fileSize: parsed.data.fileSize,
    fileMime: parsed.data.fileMime,
    thumbnailUrl: parsed.data.thumbnailUrl,
    metadata: parsed.data.metadata,
    folderId: parsed.data.folderId,
    sourceType: parsed.data.sourceType ?? null,
    sourceId: parsed.data.sourceId,
  });

  return ok(item, 201);
}

/**
 * GET /api/work/items/saved
 *
 * Returns the user's saved searches for the current workspace.
 * (Implemented as a sub-route via query param for simplicity.)
 */
async function getSavedSearches(req: NextRequest, userId: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(savedSearches)
    .where(
      and(
        eq(savedSearches.ownerId, userId),
        eq(savedSearches.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(savedSearches.pinned), desc(savedSearches.updatedAt))
    .limit(50);

  return ok({ savedSearches: rows });
}

// Handle sub-routes via query param: /api/work/items?saved=true
async function handleSubRoute(req: NextRequest, userId: string): Promise<Response | null> {
  const url = new URL(req.url);
  const isSaved = url.searchParams.get("saved") === "true";

  if (isSaved) {
    const wsCookie = req.cookies.get("ws")?.value;
    if (!wsCookie) return problem(400, "no_workspace_selected");
    return await getSavedSearches(req, userId, wsCookie);
  }

  return null;
}
