import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { exportJobs } from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/work/export/:id
 *
 * Returns the status of an export job.
 *
 * Response:
 *   { id, status, progress, resultUrl?, resultSize?, error?, expiresAt? }
 *
 * Statuses: queued → running → done | failed | expired
 *
 * When status='done', the client can GET /api/work/export/:id/download
 * to stream the result file.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  const rows = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id))
    .limit(1);

  const job = rows[0];
  if (!job) {
    return problem(404, "not_found");
  }

  // Verify ownership.
  if (job.userId !== user.id) {
    return problem(403, "forbidden");
  }

  // Check if the result has expired.
  let status = job.status;
  if (status === "done" && job.expiresAt && new Date(job.expiresAt) < new Date()) {
    status = "expired";
  }

  return ok({
    id: job.id,
    status,
    progress: job.progress,
    resultUrl: status === "done" ? job.resultUrl : null,
    resultSize: status === "done" ? job.resultSize : null,
    resultMime: status === "done" ? job.resultMime : null,
    error: status === "failed" ? job.error : null,
    expiresAt: job.expiresAt,
    createdAt: job.createdAt,
  });
}
