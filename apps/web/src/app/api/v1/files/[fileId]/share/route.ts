import { NextRequest, NextResponse } from "next/server";
import {
  authenticate,
  requestId,
  billingGate,
  errorResponse,
  corsHeaders,
} from "@/lib/http/middleware";
import { createShareLink, listShareLinks, type SharePerm } from "@/lib/shares/create";
import { ApiError as AuthzError } from "@/lib/authz/permissions";
import { db } from "@supa/db";
import { files } from "@supa/db/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/v1/files/:fileId/share
 *
 * Create a share link for a file.
 *
 * Auth: session JWT (Bearer). The caller must have 'file:share' permission
 * on the file's workspace (checked by createShareLink via assertPermission).
 *
 * Body:
 *   {
 *     "perm":        "view" | "download" | "edit",   // required
 *     "password"?:   string,                          // optional, argon2id-hashed
 *     "expiresAt"?:  ISO 8601 string,                 // optional, must be future
 *     "maxViews"?:   integer >= 1,                    // optional
 *     "allowedEmail"?: string                          // optional, email-gated
 *   }
 *
 * Response 200:
 *   {
 *     "shareId": "...",
 *     "token":   "...",   // raw URL token — returned ONCE, never stored
 *     "url":     "/api/shares/<token>"   // the public resolution path
 *   }
 *
 * The raw token is returned ONCE. If lost, revoke + re-create (no recovery —
 * only SHA-256(token) is stored, so the raw token can't be recovered).
 *
 * The `url` field uses a relative path — the client prepends its origin. This
 * avoids hardcoding the public base URL (deployment-specific) in the API.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateShareBody {
  perm?: string;
  password?: string;
  expiresAt?: string;
  maxViews?: number;
  allowedEmail?: string;
}

/**
 * Resolve the workspace ID for a file. Used by the route to:
 *   1. Run billingGate (locked workspaces can't create share links — write op).
 *   2. The permission check (assertPermission needs wsId).
 *
 * Returns null if the file doesn't exist (→ 404).
 */
async function resolveWsForFile(fileId: string): Promise<string | null> {
  const rows = await db
    .select({ wsId: files.workspaceId })
    .from(files)
    .where(eq(files.id, fileId as any))
    .limit(1);
  return (rows[0]?.wsId as string | undefined) ?? null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const rid = requestId(req);
  const { fileId } = await params;
  try {
    const uid = await authenticate(req);

    // Resolve the workspace from the file row (for billing gate + permission).
    const wsId = await resolveWsForFile(fileId);
    if (!wsId) return errorResponse(new AuthzError("file_not_found", 404), `/v1/files/${fileId}/share`);

    // Locked/purged workspaces can't create share links (write op).
    await billingGate(wsId, "POST");

    // Parse the body.
    let body: CreateShareBody = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as CreateShareBody;
    } catch {
      return errorResponse(new AuthzError("invalid_json", 400), `/v1/files/${fileId}/share`);
    }

    // Validate required fields.
    if (!body.perm || !["view", "download", "edit"].includes(body.perm)) {
      return errorResponse(
        new AuthzError(`invalid_perm:${body.perm ?? "missing"}`, 400),
        `/v1/files/${fileId}/share`,
      );
    }

    // Parse expiresAt (ISO 8601 string → Date).
    let expiresAt: Date | null | undefined = undefined;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        expiresAt = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (isNaN(parsed.getTime())) {
          return errorResponse(
            new AuthzError(`invalid_expires_at:${body.expiresAt}`, 400),
            `/v1/files/${fileId}/share`,
          );
        }
        expiresAt = parsed;
      }
    }

    // Parse maxViews (null allowed; otherwise integer >= 1).
    let maxViews: number | null | undefined = undefined;
    if (body.maxViews !== undefined) {
      if (body.maxViews === null) {
        maxViews = null;
      } else {
        if (!Number.isInteger(body.maxViews) || body.maxViews < 1) {
          return errorResponse(
            new AuthzError(`invalid_max_views:${body.maxViews}`, 400),
            `/v1/files/${fileId}/share`,
          );
        }
        maxViews = body.maxViews;
      }
    }

    // Create the share link (asserts 'file:share' permission internally).
    const result = await createShareLink(uid, wsId, fileId, {
      perm: body.perm as SharePerm,
      ...(body.password ? { password: body.password } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(maxViews !== undefined ? { maxViews } : {}),
      ...(body.allowedEmail !== undefined
        ? { allowedEmail: body.allowedEmail || null }
        : {}),
    });

    const res = NextResponse.json(
      {
        shareId: result.shareId,
        token: result.token,
        url: `/api/shares/${result.token}`,
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/v1/files/${fileId}/share`);
  }
}

/**
 * GET /api/v1/files/:fileId/share
 *
 * List share links for a file. Requires 'file:share' permission.
 *
 * Response 200: { items: ShareLinkSummary[] }
 * Returns all links (active + revoked) — the client filters.
 * Does NOT return token_hash (useless — raw token is gone after creation).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const rid = requestId(req);
  const { fileId } = await params;
  try {
    const uid = await authenticate(req);

    const wsId = await resolveWsForFile(fileId);
    if (!wsId) return errorResponse(new AuthzError("file_not_found", 404), `/v1/files/${fileId}/share`);

    // Read op — allowed on locked workspaces (user can view their shares).
    await billingGate(wsId, "GET");

    const items = await listShareLinks(uid, wsId, fileId);

    const res = NextResponse.json({ items }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/v1/files/${fileId}/share`);
  }
}
