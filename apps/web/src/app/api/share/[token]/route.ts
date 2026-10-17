import { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import { problem, ok } from "@/lib/api/problem";
import {
  findShareLinkByToken,
  incrementShareViewCount,
  getSharedMessages,
  shareLinkInvalidReason,
} from "@/lib/share/queries";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * NOTE: Node.js runtime — Drizzle's postgres-js driver needs Node APIs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SharePayload {
  title: string | null;
  mode: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: Date;
  }>;
  sharedUntil: Date;
}

/**
 * GET /api/share/[token]
 *
 * Public route — returns the messages from a shared conversation.
 * No auth required (anyone with the token can read).
 *
 * The token is a long random string (not a UUID). We validate its format
 * before hitting the DB to prevent injection attacks.
 *
 * Flow:
 *   1. Validate token format (alphanumeric + dash/underscore, 43 chars = base64url SHA-256)
 *   2. Hash the token (sha256) — DB stores hash, not raw token
 *   3. Check Redis cache (5-min TTL) — hot public path
 *   4. If not cached, query DB for the share link + conversation
 *   5. Validate: not revoked, not expired, not exhausted
 *   6. Atomically increment view_count (race-condition safe)
 *   7. Fetch messages (PII-stripped: no user_id, no workspace_id)
 *   8. Cache the response in Redis
 *
 * The cache is invalidated on revoke via DELETE /api/share/[token]
 * which calls `redis.del(\`share:${tokenHash}\`)`.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Validate token format — must be base64url-encoded SHA-256 (43 chars).
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    return problem(400, "invalid_token");
  }

  // Hash the token for cache key — the DELETE route uses the same hash
  // to invalidate, so they must match.
  const { sha256 } = await import("@/lib/auth/tokens");
  const tokenHash = await sha256(token);

  // Check Redis cache first.
  const cacheKey = `share:${tokenHash}`;
  const cached = await redis.get<SharePayload>(cacheKey);
  if (cached) {
    return ok(cached);
  }

  // Look up the share link + conversation.
  const link = await findShareLinkByToken(token);
  if (!link) {
    return problem(404, "not_found");
  }

  // Validate the link is still active.
  const reason = shareLinkInvalidReason(link);
  if (reason) {
    // Map reason to HTTP status.
    const status = reason === "revoked" || reason === "expired" || reason === "view_limit" ? 410 : 404;
    return problem(status, reason);
  }

  // Atomically increment the view count.
  // This uses a conditional UPDATE — if the link was revoked/expired
  // between our check and the increment, the increment is a no-op.
  await incrementShareViewCount(link.tokenHash);

  // Fetch messages — PII-stripped (no user_id, no workspace_id).
  const msgs = await getSharedMessages(link.conversationId, 200);

  const payload: SharePayload = {
    title: link.conversation.title,
    mode: link.conversation.mode,
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    sharedUntil: link.expiresAt,
  };

  // Cache for 5 minutes. The DELETE route invalidates this on revoke.
  await redis.set(cacheKey, payload, { ex: CACHE_TTL_SECONDS });

  return ok(payload);
}

/**
 * DELETE /api/share/[token]
 *
 * Revokes a share link. Only the conversation owner can revoke.
 *
 * Auth: caller must be signed in AND be the owner of the conversation
 * that the share link belongs to.
 *
 * After revoking, the Redis cache is invalidated so the public GET
 * route returns 410 immediately (instead of serving cached content
 * for up to 5 minutes).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Validate token format.
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    return problem(400, "invalid_token");
  }

  // Auth — requireUser throws if unauthenticated.
  const { requireUser } = await import("@/lib/auth/session");
  const user = await requireUser();

  // Revoke the link — revokeShareLink checks ownership.
  const { revokeShareLink } = await import("@/lib/share/queries");
  const linkId = await revokeShareLink(token, user.id);
  if (!linkId) {
    return problem(404, "not_found");
  }

  // Invalidate the cache so the public GET returns 410 immediately.
  const { sha256: hashToken } = await import("@/lib/auth/tokens");
  const tokenHash = await hashToken(token);
  await redis.del(`share:${tokenHash}`);

  // Audit the revocation — append-only record of who revoked what.
  // We store the token hash PREFIX (first 8 chars) in metadata, never the
  // raw token — the raw token is a bearer credential and must never be
  // logged. The prefix is enough to correlate with the share_links row
  // (which stores the full hash) without leaking the credential.
  const { audit } = await import("@/lib/audit");
  const { ip } = await import("@/lib/utils/ip");
  const NextRequest = (await import("next/server")).NextRequest;
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "share_link.revoke",
    targetType: "share_link",
    targetId: linkId,
    metadata: { tokenHashPrefix: tokenHash.slice(0, 8) },
    ip: req instanceof NextRequest ? ip(req) : null,
  });

  return ok({ revoked: true });
}
