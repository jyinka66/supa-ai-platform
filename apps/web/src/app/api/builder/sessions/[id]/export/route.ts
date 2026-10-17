// POST /api/builder/sessions/[id]/export
//
// Exports the build session as a ZIP archive containing 6 directories:
//   /src        — source code
//   /tests      — test files
//   /docs       — README, architecture, API docs
//   /migrations — SQL migrations
//   /config     — env templates, deployment config
//   /scripts    — utility scripts
//
// Returns the artifact metadata (URL + hash + size).

import { NextRequest } from "next/server";
import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { exportAsZip, ARTIFACT_DIRECTORIES, verifyExportArtifact } from "@/lib/builder/export-artifact";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const result = await exportAsZip({
    sessionId: id,
    exportedBy: ctx.admin!.adminId,
  });

  return okResponse({
    sessionId: id,
    result,
    directories: ARTIFACT_DIRECTORIES,
    verification: verifyExportArtifact(),
    exportedBy: ctx.admin!.adminId,
    exportedAt: new Date().toISOString(),
  });
});
