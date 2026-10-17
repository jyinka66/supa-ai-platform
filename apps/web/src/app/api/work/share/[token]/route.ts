import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workShareLinks, workItems, workFolders } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { problem, ok } from "@/lib/api/problem";
import { ip } from "@/lib/utils/ip";
import { createHash, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PasswordBody = z.object({
  password: z.string().min(1).max(1000),
}).strict();

interface ShareResolution {
  linkId: string;
  itemId: string | null;
  folderId: string | null;
  role: string;
  requiresPassword: boolean;
  item: {
    title: string | null;
    type: string | null;
    content: string | null;
    contentFormat: string | null;
    metadata: Record<string, unknown> | null;
    thumbnailUrl: string | null;
    fileUrl: string | null;
  } | null;
  folder: {
    id: string;
    name: string;
  } | null;
  shareInfo: {
    expiresAt: Date | null;
    maxViews: number | null;
    viewCount: number;
    role: string;
  };
}

/**
 * GET /api/work/share/:token
 *
 * Public route — resolves a share link by token.
 *
 * Flow:
 *   1. Look up the share link by token (must be active, not revoked, not expired, not exhausted)
 *   2. If password-protected, return requiresPassword: true (don't reveal content)
 *   3. Client sends POST with password → verify → return content
 *   4. If no password, record the view + return content
 *
 * No auth required — anyone with the token can view (if not password-protected).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Validate token format (22-char url-safe base64 = 128 bits).
  if (!/^[a-zA-Z0-9_-]{22}$/.test(token)) {
    return problem(400, "invalid_token");
  }

  // Resolve the share link + joined item/folder data.
  const rows = await db
    .select({
      link: workShareLinks,
      itemTitle: workItems.title,
      itemType: workItems.type,
      itemContent: workItems.content,
      itemContentFormat: workItems.contentFormat,
      itemMetadata: workItems.metadata,
      itemThumbnailUrl: workItems.thumbnailUrl,
      itemFileUrl: workItems.fileUrl,
      folderName: workFolders.name,
    })
    .from(workShareLinks)
    .leftJoin(workItems, eq(workItems.id, workShareLinks.itemId))
    .leftJoin(workFolders, eq(workFolders.id, workShareLinks.folderId))
    .where(
      and(
        eq(workShareLinks.token, token),
        isNull(workShareLinks.revokedAt),
        // Not expired
        or(
          isNull(workShareLinks.expiresAt),
          sql`${workShareLinks.expiresAt} > now()`,
        ),
        // Not exhausted
        or(
          isNull(workShareLinks.maxViews),
          sql`${workShareLinks.viewCount} < ${workShareLinks.maxViews}`,
        ),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return problem(410, "link_invalid", "This share link is invalid, expired, or has been revoked.");
  }

  const link = row.link;

  // If password-protected, don't reveal content yet.
  if (link.passwordHash) {
    const response: ShareResolution = {
      linkId: link.id,
      itemId: link.itemId,
      folderId: link.folderId,
      role: link.role,
      requiresPassword: true,
      item: null,
      folder: null,
      shareInfo: {
        expiresAt: link.expiresAt,
        maxViews: link.maxViews,
        viewCount: link.viewCount,
        role: link.role,
      },
    };
    return ok(response);
  }

  // No password — record the view + return content.
  await recordView(req, token);

  const response: ShareResolution = {
    linkId: link.id,
    itemId: link.itemId,
    folderId: link.folderId,
    role: link.role,
    requiresPassword: false,
    item: link.itemId
      ? {
          title: row.itemTitle,
          type: row.itemType,
          content: row.itemContent,
          contentFormat: row.itemContentFormat,
          metadata: row.itemMetadata as Record<string, unknown> | null,
          thumbnailUrl: row.itemThumbnailUrl,
          fileUrl: row.itemFileUrl,
        }
      : null,
    folder: link.folderId
      ? {
          id: link.folderId,
          name: row.folderName ?? "Shared folder",
        }
      : null,
    shareInfo: {
      expiresAt: link.expiresAt,
      maxViews: link.maxViews,
      viewCount: link.viewCount,
      role: link.role,
    },
  };

  return ok(response);
}

/**
 * POST /api/work/share/:token
 *
 * Verifies a password for a password-protected share link.
 * On success, records the view + returns the content.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!/^[a-zA-Z0-9_-]{22}$/.test(token)) {
    return problem(400, "invalid_token");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = PasswordBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  // Fetch the link.
  const rows = await db
    .select()
    .from(workShareLinks)
    .where(
      and(
        eq(workShareLinks.token, token),
        isNull(workShareLinks.revokedAt),
        or(
          isNull(workShareLinks.expiresAt),
          sql`${workShareLinks.expiresAt} > now()`,
        ),
        or(
          isNull(workShareLinks.maxViews),
          sql`${workShareLinks.viewCount} < ${workShareLinks.maxViews}`,
        ),
      ),
    )
    .limit(1);

  const link = rows[0];
  if (!link) {
    return problem(410, "link_invalid");
  }

  if (!link.passwordHash) {
    // No password required — redirect to GET behavior.
    return GET(req, { params });
  }

  // Verify password (argon2id — constant-time, memory-hard).
  const passwordOk = await verifySharePassword(parsed.data.password, link.passwordHash);
  if (!passwordOk) {
    return problem(403, "wrong_password");
  }

  // Password correct — record the view + return content.
  await recordView(req, token);

  // Fetch the full content.
  const itemRows = await db
    .select()
    .from(workItems)
    .where(eq(workItems.id, link.itemId!))
    .limit(1);

  const item = itemRows[0];

  const response: ShareResolution = {
    linkId: link.id,
    itemId: link.itemId,
    folderId: link.folderId,
    role: link.role,
    requiresPassword: false,
    item: item
      ? {
          title: item.title,
          type: item.type,
          content: item.content,
          contentFormat: item.contentFormat,
          metadata: item.metadata as Record<string, unknown> | null,
          thumbnailUrl: item.thumbnailUrl,
          fileUrl: item.fileUrl,
        }
      : null,
    folder: null,
    shareInfo: {
      expiresAt: link.expiresAt,
      maxViews: link.maxViews,
      viewCount: link.viewCount,
      role: link.role,
    },
  };

  return ok(response);
}

/**
 * Records a share view via the SECURITY DEFINER function.
 * Extracts IP (hashed), user agent, and referrer from the request.
 */
async function recordView(req: NextRequest, token: string): Promise<void> {
  const clientIp = ip(req);
  const ipHash = clientIp ? hashIp(clientIp) : null;
  const userAgent = req.headers.get("user-agent") ?? null;
  const referrer = req.headers.get("referer") ?? null;

  try {
    await (db as any).rpc("record_work_share_view", {
      p_token: token,
      p_ip_hash: ipHash,
      p_country: null, // TODO: GeoIP lookup
      p_user_agent: userAgent,
      p_referrer: referrer,
    });
  } catch {
    // Best-effort — view recording failure shouldn't block the content.
  }
}

// Password hashing for share links — now uses argon2id (OWASP 2024 baseline).
// The old unsalted SHA-256 was a CRITICAL finding (C11) in the security audit.
// argon2id is slow + memory-hard → rainbow table + GPU brute-force resistant.
// The hash is stored as a string (includes salt + params); verification uses
// argon2's `verify` (constant-time compare internally).
import { hashPassword as argonHash, verifyPassword as argonVerify } from "@/lib/auth/passwords";

async function hashSharePassword(password: string): Promise<string> {
  return argonHash(password);
}

async function verifySharePassword(password: string, storedHash: string): Promise<boolean> {
  // Handle legacy SHA-256 hashes (created before the argon2 migration).
  // SHA-256 hashes are 64 hex chars; argon2 hashes start with "$argon2".
  if (storedHash.length === 64 && /^[a-f0-9]{64}$/.test(storedHash)) {
    // Legacy: unsalted SHA-256. Compare + flag for rehash.
    const sha256Hash = createHash("sha256").update(password).digest("hex");
    // Use timingSafeEqual for the legacy path (the old safeEqual was NOT constant-time).
    try {
      return timingSafeEqual(Buffer.from(sha256Hash, "hex"), Buffer.from(storedHash, "hex"));
    } catch {
      return false;
    }
  }
  // Current: argon2id.
  return argonVerify(password, storedHash);
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function safeEqual(a: string, b: string): boolean {
  // Constant-time comparison (the old Buffer.equals was NOT constant-time — C12).
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// Need these imports for the OR conditions.
import { or, isNull } from "drizzle-orm";
