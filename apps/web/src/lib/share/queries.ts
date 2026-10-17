import { db } from "@supa/db";
import { shareLinks, conversations, messages } from "@supa/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { sha256 } from "@/lib/auth/tokens";

export interface ShareLinkRow {
  id: string;
  conversationId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  maxViews: number | null;
  viewCount: number;
  createdAt: Date;
}

export interface ShareLinkWithConversation extends ShareLinkRow {
  conversation: {
    id: string;
    title: string | null;
    mode: string;
  };
}

/**
 * Finds a share link by its raw token (hashes it first).
 * Returns null if no match.
 */
export async function findShareLinkByToken(
  rawToken: string,
): Promise<ShareLinkWithConversation | null> {
  const hash = await sha256(rawToken);
  const rows = await db
    .select({
      id: shareLinks.id,
      conversationId: shareLinks.conversationId,
      tokenHash: shareLinks.tokenHash,
      expiresAt: shareLinks.expiresAt,
      revokedAt: shareLinks.revokedAt,
      maxViews: shareLinks.maxViews,
      viewCount: shareLinks.viewCount,
      createdAt: shareLinks.createdAt,
      conversation: {
        id: conversations.id,
        title: conversations.title,
        mode: conversations.mode,
      },
    })
    .from(shareLinks)
    .innerJoin(conversations, eq(conversations.id, shareLinks.conversationId))
    .where(eq(shareLinks.tokenHash, hash))
    .limit(1);
  return (rows[0] as ShareLinkWithConversation | undefined) ?? null;
}

/**
 * Atomically increments the view count for a share link.
 * Uses a conditional UPDATE to prevent race conditions where two
 * concurrent requests could both read view_count=N and both write N+1.
 *
 * The WHERE clause ensures we only increment if the link is still valid
 * (not revoked, not expired, not exhausted). If the link is no longer
 * valid, the increment is a no-op.
 */
export async function incrementShareViewCount(tokenHash: string): Promise<void> {
  await db.execute(sql`
    update share_links
    set view_count = view_count + 1
    where token_hash = ${tokenHash}
      and revoked_at is null
      and expires_at > now()
      and (max_views is null or view_count < max_views)
  `);
}

/**
 * Revokes a share link. Only the conversation owner can revoke.
 * Returns the link id if a row was updated, or null if no matching link was found
 * (either doesn't exist, already revoked, or caller isn't the owner).
 */
export async function revokeShareLink(
  rawToken: string,
  userId: string,
): Promise<string | null> {
  const tokenHash = await sha256(rawToken);
  const rows = await db.execute(sql`
    update share_links s
    set revoked_at = now()
    from conversations c
    where s.conversation_id = c.id
      and s.token_hash = ${tokenHash}
      and c.user_id = ${userId}
      and s.revoked_at is null
    returning s.id
  `);
  if (Array.isArray(rows) && rows.length > 0) {
    return (rows[0] as { id: string }).id;
  }
  return null;
}

/**
 * Returns the public messages for a shared conversation.
 * Strips all PII (user_id, workspace_id) — only role + content + timestamp.
 * Filters at the SQL layer to only return completed messages (no streaming/aborted/error).
 */
export async function getSharedMessages(conversationId: string, limit = 200) {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      status: messages.status,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.status, "completed"),
      ),
    )
    .orderBy(messages.createdAt)
    .limit(limit);
  // Strip the status field from the response (it's not needed by the client).
  return rows.map(({ status: _status, ...rest }) => rest);
}

/**
 * Returns true if the share link is currently valid:
 *   - not revoked
 *   - not expired
 *   - not exhausted (view_count < max_views if max_views is set)
 */
export function isShareLinkValid(link: ShareLinkRow, now = new Date()): boolean {
  if (link.revokedAt) return false;
  if (new Date(link.expiresAt) <= now) return false;
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return false;
  return true;
}

/**
 * Returns the reason a share link is invalid (for HTTP status code mapping).
 */
export function shareLinkInvalidReason(link: ShareLinkRow, now = new Date()): string | null {
  if (link.revokedAt) return "revoked";
  if (new Date(link.expiresAt) <= now) return "expired";
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return "view_limit";
  return null;
}
