// GET /api/supa-os/catalog/cloud-targets
//
// Returns the cloud deploy target catalog (Vercel, Netlify, Cloudflare Pages,
// AWS, GCP, Azure, Render, Fly.io, Railway, Supabase) — the destinations the
// user can pick from for one-click deploy.
//
// Auth: admin session (read_only).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { CLOUD_DEPLOY_TARGETS } from "@/lib/supa-os/multi-cloud-deploy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    targets: CLOUD_DEPLOY_TARGETS,
    total: CLOUD_DEPLOY_TARGETS.length,
  });
});
