// Preview repository — DB-backed persistence for live preview instances.
//
// Replaces the in-memory `Map<string, ...>` previewStore in
// `app/api/supa-os/build/[id]/preview/route.ts`.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";

export interface PreviewInstanceRecord {
  id: string;
  buildSessionId: string;
  port: number;
  url: string;
  status: "starting" | "running" | "sleeping" | "stopped" | "failed";
  startedAt: Date;
  stoppedAt: Date | null;
  lastHealthCheckAt: Date | null;
  healthStatus: "healthy" | "unhealthy" | "unknown";
}

// ───────────────────────────────────────────────
// startPreview — create or restart a preview for a build session.
// ───────────────────────────────────────────────

export async function startPreview(
  buildSessionId: string,
  port: number,
): Promise<PreviewInstanceRecord> {
  // Upsert: if a preview exists, restart it. Otherwise create new.
  const url = `https://preview-${buildSessionId}.supa-hosting.local:${port}`;
  await db.execute(sql`
    insert into preview_instances (build_session_id, port, url, status)
    values (${buildSessionId}::uuid, ${port}, ${url}, 'running')
    on conflict (build_session_id)
    do update set port = excluded.port, url = excluded.url, status = 'running',
                  started_at = now(), stopped_at = null
  `);
  return (await getPreview(buildSessionId))!;
}

// ───────────────────────────────────────────────
// stopPreview — stop a preview (status='stopped').
// ───────────────────────────────────────────────

export async function stopPreview(buildSessionId: string): Promise<boolean> {
  const result = await db.execute(sql`
    update preview_instances
       set status = 'stopped', stopped_at = now()
     where build_session_id = ${buildSessionId}::uuid and status <> 'stopped'
     returning id
  `);
  return (result as unknown as Array<unknown>).length > 0;
}

// ───────────────────────────────────────────────
// getPreview — load a preview by build session id.
// ───────────────────────────────────────────────

export async function getPreview(buildSessionId: string): Promise<PreviewInstanceRecord | null> {
  const result = await db.execute(sql`
    select id, build_session_id, port, url, status, started_at, stopped_at,
           last_health_check_at, health_status
      from preview_instances
     where build_session_id = ${buildSessionId}::uuid
     limit 1
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    id: row.id as string,
    buildSessionId: row.build_session_id as string,
    port: row.port as number,
    url: row.url as string,
    status: row.status as PreviewInstanceRecord["status"],
    startedAt: new Date(row.started_at as string),
    stoppedAt: row.stopped_at ? new Date(row.stopped_at as string) : null,
    lastHealthCheckAt: row.last_health_check_at ? new Date(row.last_health_check_at as string) : null,
    healthStatus: (row.health_status as PreviewInstanceRecord["healthStatus"]) ?? "unknown",
  };
}

// ───────────────────────────────────────────────
// performLifecycleAction — sleep | wake | restart.
// ───────────────────────────────────────────────

export async function performLifecycleAction(
  buildSessionId: string,
  action: "sleep" | "wake" | "restart",
): Promise<PreviewInstanceRecord | null> {
  const newStatus = action === "sleep" ? "sleeping" : "running";
  const startedAtExpr = action === "restart" ? sql`now()` : sql`started_at`;
  await db.execute(sql`
    update preview_instances
       set status = ${newStatus}, started_at = ${startedAtExpr}
     where build_session_id = ${buildSessionId}::uuid
  `);
  return getPreview(buildSessionId);
}

// ───────────────────────────────────────────────
// updateHealth — record a health check result.
// ───────────────────────────────────────────────

export async function updateHealth(
  buildSessionId: string,
  healthStatus: "healthy" | "unhealthy",
): Promise<void> {
  await db.execute(sql`
    update preview_instances
       set health_status = ${healthStatus}, last_health_check_at = now()
     where build_session_id = ${buildSessionId}::uuid
  `);
}
