import { NextRequest, NextResponse } from "next/server";
import {
  authenticate,
  requestId,
  billingGate,
  errorResponse,
  corsHeaders,
} from "@/lib/http/middleware";
import { revokeShareLink } from "@/lib/shares/create";
import { ApiError as AuthzError } from "@/lib/authz/permissions";
import { db } from "@supa/db";
import { shareLinksV2 as shareLinks, files } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * DELETE /api/v1/files/:fileId/share/:shareId
 *
 * Revoke a share link. Sets `revoked_at = now()` (idempotent — already-
 * revoked is a no-op, returns 204).
 *
 * Auth: session JWT (Bearer). The caller must have 'file:share' permission
 * on the file's workspace. Any admin/owner with file:share can revoke any
 * link in the workspace (not just the creator — prevents a departed admin's
 * links from being un-revocable).
 *
 * Response: 204 No Content (on success or already-revoked).
 * 404 if the share link doesn't exist or belongs to another ws/file (no oracle).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve the ws_id for a (fileId, shareId) pair. Verifies the share link
 * belongs to the given file + the file exists. Returns null if not found.
 *
 * We scope by (shareId, fileId) — the shareId alone could match a link for a
 * different file (the path param says this file). Defense-in-depth: the
 * revokeShareLink service also checks ws_id.
 */
async function resolveWsForShare(fileId: string, shareId: string): Promise<string | null> {
  const rows = await db
    .select({ wsId: files.workspaceId })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .where(and(eq(shareLinks.id, shareId as any), eq(shareLinks.fileId, fileId as any)))
    .limit(1);
  return (rows[0]?.wsId as string | undefined) ?? null;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string; shareId: string }> },
) {
  const rid = requestId(req);
  const { fileId, shareId } = await params;
  try {
    const uid = await authenticate(req);

    const wsId = await resolveWsForShare(fileId, shareId);
    if (!wsId) {
      return errorResponse(
        new AuthzError("share_link_not_found", 404),
        `/v1/files/${fileId}/share/${shareId}`,
      );
    }

    // Revoking is a write op (sets revoked_at) — locked workspaces can't.
    await billingGate(wsId, "DELETE");

    await revokeShareLink(uid, wsId, shareId);

    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/v1/files/${fileId}/share/${shareId}`);
  }
}
