// POST /api/supa-os/wasm/execute
//
// Executes a shell command in a disposable Docker sandbox and returns actual
// stdout/stderr, exit status, and duration. The host process never evaluates
// the submitted command directly.
//
// Body:
//   command: string (e.g. "npm run dev", "npm install", "drizzle-kit push")
//   cwd?: string (working directory inside the sandbox)
//   env?: Record<string, string> (env vars to pass to the process)
//   autoTriggered?: boolean (true if invoked by self-healing loop)
//
// Auth: admin (senior — arbitrary command execution in a sandbox is sensitive).

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { executeCommand, RUNTIME_ENVIRONMENTS } from "@/lib/supa-os/wasm-runtime-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  command: z.string().min(1).max(500),
  cwd: z.string().max(500).regex(/^\/workspace(?:\/[^\0]*)?$/).refine((value) => !value.split("/").includes(".."), "cwd must stay inside /workspace").optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096).refine((value) => !/[\r\n\0]/.test(value))).optional(),
  autoTriggered: z.boolean().optional(),
  language: z.enum(["nodejs", "python", "go", "rust", "deno", "bun", "postgres"]).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  files: z.array(z.object({ path: z.string().min(1).max(300), content: z.string().max(1_000_000) })).max(200).optional(),
}).superRefine((body, ctx) => {
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of (body.files ?? []).entries()) {
    if (file.path.startsWith("/") || file.path.includes("\0") || file.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", index, "path"], message: "File paths must be relative and cannot traverse directories" });
    }
    if (seen.has(file.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", index, "path"], message: "Duplicate file path" });
    seen.add(file.path);
    totalBytes += new TextEncoder().encode(file.content).byteLength;
  }
  if (totalBytes > 2 * 1024 * 1024) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "Workspace exceeds 2 MiB" });
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema, 3_000_000);
  const cmd = await executeCommand({
    command: body.command,
    cwd: body.cwd,
    env: body.env,
    autoTriggered: body.autoTriggered,
    language: body.language,
    timeoutMs: body.timeoutMs,
    files: body.files,
  });
  return okResponse({
    command: cmd,
    runtime: "isolated-docker-sandbox",
    success: cmd.status === "exited" && cmd.exitCode === 0,
    timeoutMs: body.timeoutMs ?? 30000,
    availableRuntimes: RUNTIME_ENVIRONMENTS.map((r) => r.language),
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
