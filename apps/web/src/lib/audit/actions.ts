import { db } from "@supa/db";
import { auditLog } from "@supa/db/schema";
import { z } from "zod";
import { pino } from "@/lib/observability/logger";

const log = pino.child({ module: "audit" });

/**
 * Closed action taxonomy — every audit entry's `action` field must be one
 * of these values. Validated via Zod at write time so typos are caught
 * (e.g. 'share_link.craete' would throw instead of silently creating a
 * new action category).
 *
 * When adding a new action, ALSO add it to the migration's taxonomy comment
 * so the DB-level documentation stays in sync.
 */
export const AUDIT_ACTIONS = [
  // Share links
  "share_link.create",
  "share_link.revoke",
  "share_link.view_exhausted",

  // Prompt A/B testing
  "prompt_version.promote",

  // Conversations
  "conversation.create",
  "conversation.delete",
  "conversation.share",
  "conversation.message_aborted",

  // User data lifecycle (GDPR)
  "user.data_export",
  "user.data_delete",
  "user.deletion_request",
  "user.deletion_cancel",
  "user.purged",

  // Budgets
  "budget.update",
  "budget.exceeded",
  "budget.alert",

  // Workspaces
  "workspace.create",
  "workspace.update",
  "workspace.delete",
  "workspace_member.invite",
  "workspace_member.add",
  "workspace_member.remove",
  "workspace_member.role_change",

  // Sessions
  "session.revoke",
  "session.revoke_all",

  // Auth
  "auth.login",
  "auth.login_failed",
  "auth.signup",
  "auth.mfa_enroll",
  "auth.rate_limited",

  // Feedback
  "user.feedback_positive",
  "user.feedback_negative",

  // Dev harness (test-only)
  "mock_failure.set",
] as const;

const actionSchema = z.enum(AUDIT_ACTIONS);

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type ActorKind = "user" | "system" | "cron";
export type TargetType =
  | "conversation"
  | "workspace"
  | "workspace_member"
  | "share_link"
  | "session"
  | "account"
  | "prompt_version"
  | "budget"
  | "message"
  | "user";

export interface AuditEntry {
  actorId: string | null;
  actorKind?: ActorKind;
  action: AuditAction | string;
  targetType: TargetType | string;
  targetId: string;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Writes an audit log entry.
 *
 * NEVER throws — if the DB write fails after retries, the audit gap is
 * logged loudly so it's visible in observability dashboards. This is
 * intentional: we don't want a failed audit log to block a user-initiated
 * action (e.g. deleting a conversation should succeed even if the audit
 * log is temporarily down).
 *
 * The `action` field is validated against the closed taxonomy — typos
 * throw at write time, preventing silent action-category proliferation.
 *
 * Uses the service-role client (bypasses RLS) so system/cron actions work
 * even when there's no authenticated user in the request context.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  // Validate the action against the closed taxonomy.
  // Throws on invalid action — this is intentional (catch the bug in dev,
  // not in prod where the audit gap would be silent).
  const action = actionSchema.parse(entry.action);

  const write = async (): Promise<void> => {
    await db.insert(auditLog).values({
      actorId: entry.actorId, // null for system/cron — NOT a random UUID
      actorKind: entry.actorKind ?? "user",
      action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      workspaceId: entry.workspaceId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ip ?? null,
    } as never);
  };

  try {
    await withRetry(write, 3);
  } catch (err) {
    // Audit write failed after retries — log loudly so the gap is visible.
    log.error({
      event: "AUDIT_WRITE_FAILURE",
      action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      actor_id: entry.actorId,
      error: String(err),
    });
  }
}

/**
 * Retries an async operation with exponential backoff.
 * 3 attempts: immediate, 100ms, 200ms.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(100 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
