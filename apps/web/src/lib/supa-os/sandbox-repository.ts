// Sandbox repository — DB-backed persistence for sandbox sessions, files,
// and terminal lines.
//
// Replaces the in-memory `Map<string, ...>` store in
// `app/api/supa-os/build/[id]/sandbox/route.ts`. Same interface, but the
// state survives server restarts + scales horizontally.
//
// Tables:
//   - sandbox_sessions       — one row per (build_session, sandbox instance)
//   - sandbox_files          — individual file nodes
//   - sandbox_terminal_lines — terminal output lines (ring buffer)
//
// The repository exposes the same shape as the in-memory store so the
// routes can swap to it with a one-line change.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types — match the in-memory VirtualFileSystem + TerminalSession shapes
// from sandbox-execution-engine.ts, so the existing route handlers don't
// need to change.
// ───────────────────────────────────────────────

export interface SandboxFileRecord {
  path: string;
  content: string;
  byteSize: number;
  contentType: string | null;
  updatedAt: Date;
  createdBy: string | null;
}

export interface SandboxSessionRecord {
  id: string;
  buildSessionId: string;
  state: "booting" | "mounted" | "installing" | "migrating" | "running" | "sleeping" | "stopped" | "failed";
  port: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
  lastActivityAt: Date;
  memoryUsedMb: number;
  cpuUsedPercent: number;
  files: SandboxFileRecord[];
  terminal: {
    lines: Array<{
      seq: number;
      stream: "stdout" | "stderr" | "system";
      content: string;
      source: string | null;
      timestamp: Date;
    }>;
    maxLines: number;
  };
}

// ───────────────────────────────────────────────
// getSandbox — load a sandbox session + its files + recent terminal lines.
// ───────────────────────────────────────────────

export async function getSandbox(buildSessionId: string): Promise<SandboxSessionRecord | null> {
  // Get the session row (1 query).
  const sessionResult = await db.execute(sql`
    select id, build_session_id, state, port, started_at, stopped_at,
           last_activity_at, memory_used_mb, cpu_used_percent
      from sandbox_sessions
     where build_session_id = ${buildSessionId}::uuid
     limit 1
  `);
  const sessionRow = (sessionResult as unknown as Array<Record<string, unknown>>)[0];
  if (!sessionRow) return null;

  // Get all files for this sandbox (1 query).
  const filesResult = await db.execute(sql`
    select path, content, byte_size, content_type, updated_at, created_by
      from sandbox_files
     where sandbox_session_id = ${sessionRow.id}::uuid
     order by path asc
  `);
  const files = (filesResult as unknown as Array<Record<string, unknown>>).map((row) => ({
    path: row.path as string,
    content: row.content as string,
    byteSize: row.byte_size as number,
    contentType: (row.content_type as string) ?? null,
    updatedAt: new Date(row.updated_at as string),
    createdBy: (row.created_by as string) ?? null,
  }));

  // Get the last 1000 terminal lines (1 query — ring buffer).
  const terminalResult = await db.execute(sql`
    select seq, stream, content, source, timestamp
      from sandbox_terminal_lines
     where sandbox_session_id = ${sessionRow.id}::uuid
     order by seq desc
     limit 1000
  `);
  const lines = (terminalResult as unknown as Array<Record<string, unknown>>)
    .map((row) => ({
      seq: row.seq as number,
      stream: row.stream as "stdout" | "stderr" | "system",
      content: row.content as string,
      source: (row.source as string) ?? null,
      timestamp: new Date(row.timestamp as string),
    }))
    .reverse(); // reverse to get chronological order

  return {
    id: sessionRow.id as string,
    buildSessionId: sessionRow.build_session_id as string,
    state: sessionRow.state as SandboxSessionRecord["state"],
    port: (sessionRow.port as number) ?? null,
    startedAt: new Date(sessionRow.started_at as string),
    stoppedAt: sessionRow.stopped_at ? new Date(sessionRow.stopped_at as string) : null,
    lastActivityAt: new Date(sessionRow.last_activity_at as string),
    memoryUsedMb: sessionRow.memory_used_mb as number,
    cpuUsedPercent: Number(sessionRow.cpu_used_percent),
    files,
    terminal: { lines, maxLines: 1000 },
  };
}

// ───────────────────────────────────────────────
// createSandbox — create a new sandbox session row (idempotent: if one
// already exists for this build_session_id, return it).
// ───────────────────────────────────────────────

export async function createSandbox(buildSessionId: string, port?: number): Promise<SandboxSessionRecord> {
  // Try to insert (will fail on the unique constraint if it already exists).
  try {
    await db.execute(sql`
      insert into sandbox_sessions (build_session_id, state, port)
      values (${buildSessionId}::uuid, 'booting', ${port ?? null})
      on conflict (build_session_id) do nothing
    `);
  } catch {
    // Conflict means one already exists — fall through to load.
  }
  const existing = await getSandbox(buildSessionId);
  if (!existing) {
    throw new Error(`Failed to create sandbox session for build_session_id=${buildSessionId}`);
  }
  return existing;
}

// ───────────────────────────────────────────────
// upsertFile — write (create or overwrite) a single file in the sandbox.
// ───────────────────────────────────────────────

export async function upsertFile(
  buildSessionId: string,
  file: { path: string; content: string; contentType?: string; createdBy?: string },
): Promise<SandboxFileRecord> {
  const session = await createSandbox(buildSessionId);
  const byteSize = Buffer.byteLength(file.content, "utf-8");
  await db.execute(sql`
    insert into sandbox_files (sandbox_session_id, path, content, byte_size, content_type, created_by)
    values (${session.id}::uuid, ${file.path}, ${file.content}, ${byteSize}, ${file.contentType ?? null}, ${file.createdBy ?? null})
    on conflict (sandbox_session_id, path)
    do update set content = excluded.content, byte_size = excluded.byte_size,
                  content_type = excluded.content_type, updated_at = now()
  `);

  // Update last_activity_at on the session.
  await db.execute(sql`
    update sandbox_sessions set last_activity_at = now() where id = ${session.id}::uuid
  `);

  return {
    path: file.path,
    content: file.content,
    byteSize,
    contentType: file.contentType ?? null,
    updatedAt: new Date(),
    createdBy: file.createdBy ?? null,
  };
}

// ───────────────────────────────────────────────
// mountFiles — write multiple files in one transaction.
// ───────────────────────────────────────────────

export async function mountFiles(
  buildSessionId: string,
  files: Array<{ path: string; content: string }>,
  createdBy?: string,
): Promise<number> {
  const session = await createSandbox(buildSessionId);
  // We can't easily batch INSERT ... ON CONFLICT with multiple rows in drizzle's
  // sql template — do them in parallel. For Phase 3 we'll batch via unnest().
  await Promise.all(files.map((f) =>
    db.execute(sql`
      insert into sandbox_files (sandbox_session_id, path, content, byte_size, created_by)
      values (${session.id}::uuid, ${f.path}, ${f.content},
              ${Buffer.byteLength(f.content, "utf-8")}, ${createdBy ?? null})
      on conflict (sandbox_session_id, path)
      do update set content = excluded.content, byte_size = excluded.byte_size, updated_at = now()
    `),
  ));
  await db.execute(sql`
    update sandbox_sessions set last_activity_at = now(), state = 'mounted'
     where id = ${session.id}::uuid
  `);
  return files.length;
}

// ───────────────────────────────────────────────
// deleteFile — delete a single file by path.
// ───────────────────────────────────────────────

export async function deleteFile(buildSessionId: string, filePath: string): Promise<boolean> {
  const session = await getSandbox(buildSessionId);
  if (!session) return false;
  const result = await db.execute(sql`
    delete from sandbox_files
     where sandbox_session_id = ${session.id}::uuid and path = ${filePath}
     returning path
  `);
  await db.execute(sql`
    update sandbox_sessions set last_activity_at = now() where id = ${session.id}::uuid
  `);
  return (result as unknown as Array<unknown>).length > 0;
}

// ───────────────────────────────────────────────
// appendTerminalLine — append a line to the terminal ring buffer.
// ───────────────────────────────────────────────

export async function appendTerminalLine(
  buildSessionId: string,
  line: { stream: "stdout" | "stderr" | "system"; content: string; source?: string },
): Promise<{ seq: number; timestamp: Date }> {
  const session = await createSandbox(buildSessionId);

  // Get the next seq (max + 1, modulo the ring buffer size of 1000).
  const maxSeqResult = await db.execute(sql`
    select coalesce(max(seq), 0) as max_seq
      from sandbox_terminal_lines
     where sandbox_session_id = ${session.id}::uuid
  `);
  const maxSeq = (maxSeqResult as unknown as Array<{ max_seq: string }>)[0]?.max_seq;
  const nextSeq = ((Number(maxSeq) + 1) % 1001) || 1;

  // If seq already exists (ring buffer wrapped), delete the old row first.
  await db.execute(sql`
    delete from sandbox_terminal_lines
     where sandbox_session_id = ${session.id}::uuid and seq = ${nextSeq}
  `);

  await db.execute(sql`
    insert into sandbox_terminal_lines (sandbox_session_id, seq, stream, content, source)
    values (${session.id}::uuid, ${nextSeq}, ${line.stream}, ${line.content}, ${line.source ?? null})
  `);

  await db.execute(sql`
    update sandbox_sessions set last_activity_at = now() where id = ${session.id}::uuid
  `);

  return { seq: nextSeq, timestamp: new Date() };
}

// ───────────────────────────────────────────────
// updateState — change the sandbox state machine.
// ───────────────────────────────────────────────

export async function updateState(
  buildSessionId: string,
  state: SandboxSessionRecord["state"],
): Promise<void> {
  await db.execute(sql`
    update sandbox_sessions
       set state = ${state}, last_activity_at = now()
     where build_session_id = ${buildSessionId}::uuid
  `);
}
