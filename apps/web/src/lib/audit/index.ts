/**
 * Audit log — append-only record of privileged and destructive actions.
 *
 * Canonical source: ./actions.ts (closed taxonomy + write helper)
 * Convenience helpers: ./index.ts (auditUserAction, auditSystemAction)
 *
 * Import from the barrel:
 *   import { audit, auditUserAction, AUDIT_ACTIONS } from "@/lib/audit";
 */

export { audit, AUDIT_ACTIONS, type AuditAction, type ActorKind, type TargetType, type AuditEntry } from "./actions";

import type { User } from "@supabase/supabase-js";
import { audit as writeAudit, type AuditAction, type TargetType } from "./actions";

/**
 * Convenience: audit a user-initiated action.
 */
export async function auditUserAction(
  user: User,
  action: AuditAction,
  targetType: TargetType,
  targetId: string,
  opts?: {
    workspaceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  },
): Promise<void> {
  await writeAudit({
    actorId: user.id,
    actorKind: "user",
    action,
    targetType,
    targetId,
    workspaceId: opts?.workspaceId ?? null,
    metadata: opts?.metadata,
    ip: opts?.ip ?? null,
  });
}

/**
 * Convenience: audit a system/cron action.
 * `actorId` is null for system actions.
 */
export async function auditSystemAction(
  action: AuditAction,
  targetType: TargetType,
  targetId: string,
  opts?: {
    workspaceId?: string;
    metadata?: Record<string, unknown>;
    actorKind?: "system" | "cron";
  },
): Promise<void> {
  await writeAudit({
    actorId: null,
    actorKind: opts?.actorKind ?? "system",
    action,
    targetType,
    targetId,
    workspaceId: opts?.workspaceId ?? null,
    metadata: opts?.metadata,
  });
}
