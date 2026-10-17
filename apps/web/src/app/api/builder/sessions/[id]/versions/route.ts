// GET /api/builder/sessions/[id]/versions
//
// Lists the version history of a build session (each version is a snapshot
// of the 9 version dimensions: code, schema, config, env, tests, ui, deps,
// migrations, docs).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { VERSION_DIMENSIONS, verifyAppVersioning } from "@/lib/builder/app-versioning";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  return okResponse({
    sessionId: id,
    versions: [],  // Phase 2: load from DB (app_versions table).
    dimensions: VERSION_DIMENSIONS,
    verification: verifyAppVersioning(),
    currentVersion: session.buildArtifactHash ?? null,
  });
});
