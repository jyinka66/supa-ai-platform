import { NextRequest } from "next/server";
import { db } from "@supa/db";
import {
  profiles,
  workspaces,
  workspaceMembers,
  conversations,
  messages,
  messageMeta,
  messageFeedback,
  userSessions,
  deletionRequests,
} from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { audit } from "@/lib/audit";
import { problem } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExportPayload {
  exportedAt: string;
  user: {
    id: string;
    email: string | null;
    fullName: string | null;
    avatarPath: string | null;
    country: string | null;
    timezone: string;
    language: string;
    roleType: string;
    bio: string | null;
    company: string | null;
    isVerified: boolean;
    onboardingStep: number;
    onboardingComplete: boolean;
    createdAt: string;
    updatedAt: string;
  };
  workspaces: Array<Record<string, unknown>>;
  workspaceMemberships: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  messageMeta: Array<Record<string, unknown>>;
  feedback: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  deletionRequests: Array<Record<string, unknown>>;
}

/**
 * GET /api/user/export
 *
 * GDPR data export — returns a JSON file containing all of the user's
 * personal data. The response is a downloadable attachment.
 *
 * Excludes:
 *   - Password hashes (live in auth.users, not exposed via Drizzle)
 *   - MFA secrets (same)
 *   - Other users' data (scoped to the caller)
 *   - Internal-only fields (e.g. ip_hash on sessions is included but masked)
 *
 * Rate-limited at the `default` tier (100/min) to prevent abuse.
 * Audited as `user.data_export` so we can track who exported what.
 */
export async function GET(req: NextRequest) {
  // Rate-limit first.
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  // Fetch all user data in parallel.
  const [
    profileRows,
    workspaceMemRows,
    conversationRows,
    messageRows,
    metaRows,
    feedbackRows,
    sessionRows,
    deletionRows,
  ] = await Promise.all([
    // Profile
    db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1),

    // Workspace memberships (with workspace details)
    db
      .select({
        membership: workspaceMembers,
        workspace: workspaces,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id)),

    // Conversations
    db.select().from(conversations).where(eq(conversations.userId, user.id)),

    // Messages (join through conversations to scope by user)
    db
      .select({ message: messages, conversationId: conversations.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.userId, user.id)),

    // Message metadata (cost, latency, routing)
    db
      .select({ meta: messageMeta, conversationId: conversations.id })
      .from(messageMeta)
      .innerJoin(messages, eq(messages.id, messageMeta.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.userId, user.id)),

    // Feedback (thumbs up/down)
    db
      .select({ feedback: messageFeedback, messageId: messages.id })
      .from(messageFeedback)
      .innerJoin(messages, eq(messages.id, messageFeedback.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.userId, user.id)),

    // Sessions (mask IP hash — don't expose raw hash to the user)
    db.select().from(userSessions).where(eq(userSessions.userId, user.id)),

    // Deletion requests
    db.select().from(deletionRequests).where(eq(deletionRequests.userId, user.id)),
  ]);

  // Build the safe user object (no secrets).
  const profile = profileRows[0];
  const userSafe = profile
    ? {
        id: profile.id,
        email: user.email ?? null,
        fullName: profile.fullName,
        avatarPath: profile.avatarPath,
        country: profile.country,
        timezone: profile.timezone,
        language: profile.language,
        roleType: profile.roleType,
        bio: profile.bio,
        company: profile.company,
        isVerified: profile.isVerified,
        onboardingStep: profile.onboardingStep,
        onboardingComplete: profile.onboardingComplete,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      }
    : {
        id: user.id,
        email: user.email ?? null,
        fullName: null,
        avatarPath: null,
        country: null,
        timezone: "UTC",
        language: "en",
        roleType: "individual",
        bio: null,
        company: null,
        isVerified: false,
        onboardingStep: 0,
        onboardingComplete: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  const payload: ExportPayload = {
    exportedAt: new Date().toISOString(),
    user: userSafe,
    workspaces: workspaceMemRows.map((r) => ({
      ...serializeRow(r.workspace),
      membership: {
        role: r.membership.role,
        invitedBy: r.membership.invitedBy,
        createdAt: r.membership.createdAt.toISOString(),
      },
    })),
    workspaceMemberships: [], // included above
    conversations: conversationRows.map(serializeRow),
    messages: messageRows.map((r) => ({
      ...serializeRow(r.message),
      conversationId: r.conversationId,
    })),
    messageMeta: metaRows.map((r) => ({
      ...serializeRow(r.meta),
      conversationId: r.conversationId,
    })),
    feedback: feedbackRows.map((r) => ({
      ...serializeRow(r.feedback),
      messageId: r.messageId,
    })),
    sessions: sessionRows.map((s) => ({
      ...serializeRow(s),
      // Mask the IP hash — it's already hashed, but we mask it further
      // to avoid leaking the internal format.
      ip: s.ip ? "••••" : null,
    })),
    deletionRequests: deletionRows.map(serializeRow),
  };

  // Audit the export.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "user.data_export",
    targetType: "user",
    targetId: user.id,
    ip: null, // could pass req IP if needed
  });

  // Return as a downloadable JSON file.
  const json = JSON.stringify(payload, null, 2);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="export-${user.id.slice(0, 8)}.json"`,
      "Content-Length": String(Buffer.byteLength(json, "utf8")),
      "Cache-Control": "no-store", // GDPR export must not be cached
    },
  });
}

/**
 * Serializes a Drizzle row, converting Date objects to ISO strings
 * and BigInt to string (Postgres bigint columns).
 */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === "bigint") {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}
