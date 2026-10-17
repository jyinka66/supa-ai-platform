import { NextRequest } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { db } from "@supa/db";
import { workShareLinks, workItems, workFolders } from "@supa/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  itemId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  role: z.enum(["view", "comment", "edit"]).default("view"),
  password: z.string().min(1).max(1000).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  maxViews: z.number().int().min(1).max(1_000_000).optional(),
}).refine((d) => d.itemId || d.folderId, {
  message: "Either itemId or folderId must be provided",
});

/**
 * POST /api/work/share
 *
 * Creates a new share link for a work item or folder.
 *
 * Generates a 22-char url-safe random token (128 bits of entropy).
 * If a password is provided, it's SHA-256 hashed before storage.
 *
 * Auth: caller must own the item/folder being shared.
 * Rate-limited at `default` tier.
 */
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

  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) return problem(400, "no_workspace_selected");

  // Verify ownership of the item/folder.
  if (parsed.data.itemId) {
    const itemRows = await db
      .select({ ownerId: workItems.ownerId })
      .from(workItems)
      .where(eq(workItems.id, parsed.data.itemId))
      .limit(1);
    if (!itemRows[0]) return problem(404, "item_not_found");
    if (itemRows[0].ownerId !== user.id) return problem(403, "forbidden");
  }
  if (parsed.data.folderId) {
    const folderRows = await db
      .select({ createdBy: workFolders.createdBy })
      .from(workFolders)
      .where(eq(workFolders.id, parsed.data.folderId))
      .limit(1);
    if (!folderRows[0]) return problem(404, "folder_not_found");
    if (folderRows[0].createdBy !== user.id) return problem(403, "forbidden");
  }

  // Generate token (22-char url-safe = 128 bits).
  const token = randomBytes(16).toString("base64url").slice(0, 22);

  // Hash password if provided.
  const passwordHash = parsed.data.password
    ? createHash("sha256").update(parsed.data.password).digest("hex")
    : null;

  // Compute expiry.
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [created] = await db
    .insert(workShareLinks)
    .values({
      workspaceId: wsCookie,
      itemId: parsed.data.itemId ?? null,
      folderId: parsed.data.folderId ?? null,
      token,
      createdBy: user.id,
      role: parsed.data.role,
      passwordHash,
      expiresAt,
      maxViews: parsed.data.maxViews ?? null,
      viewCount: 0,
    })
    .returning();

  if (!created) return problem(500, "create_failed");

  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "share_link.create",
    targetType: "share_link",
    targetId: created.id,
    metadata: {
      itemId: parsed.data.itemId ?? null,
      folderId: parsed.data.folderId ?? null,
      role: parsed.data.role,
      hasPassword: !!parsed.data.password,
      expiresInDays: parsed.data.expiresInDays ?? null,
      maxViews: parsed.data.maxViews ?? null,
    },
    ip: ip(req),
  });

  return ok({
    id: created.id,
    token: created.token,
    url: `/s/${token}`,
    role: created.role,
    expiresAt: created.expiresAt,
    maxViews: created.maxViews,
    hasPassword: !!created.passwordHash,
  }, 201);
}

/**
 * GET /api/work/share?itemId=... or ?folderId=...
 *
 * Returns all share links for a specific item or folder (management panel).
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  const url = new URL(req.url);
  const itemId = url.searchParams.get("itemId");
  const folderId = url.searchParams.get("folderId");

  if (!itemId && !folderId) {
    return problem(400, "missing_param", "Provide itemId or folderId");
  }

  // Build the query.
  const conditions = [eq(workShareLinks.createdBy, user.id)];
  if (itemId) conditions.push(eq(workShareLinks.itemId, itemId));
  if (folderId) conditions.push(eq(workShareLinks.folderId, folderId));

  const links = await db
    .select({
      id: workShareLinks.id,
      token: workShareLinks.token,
      itemId: workShareLinks.itemId,
      folderId: workShareLinks.folderId,
      role: workShareLinks.role,
      hasPassword: workShareLinks.passwordHash,
      expiresAt: workShareLinks.expiresAt,
      maxViews: workShareLinks.maxViews,
      viewCount: workShareLinks.viewCount,
      revokedAt: workShareLinks.revokedAt,
      createdAt: workShareLinks.createdAt,
    })
    .from(workShareLinks)
    .where(and(...conditions))
    .orderBy(desc(workShareLinks.createdAt));

  return ok({
    links: links.map((l) => ({
      ...l,
      hasPassword: !!l.hasPassword,
      url: `/s/${l.token}`,
      isRevoked: !!l.revokedAt,
      isExpired: l.expiresAt ? new Date(l.expiresAt) < new Date() : false,
    })),
  });
}
