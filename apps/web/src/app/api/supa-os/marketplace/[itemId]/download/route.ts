// POST /api/supa-os/marketplace/[itemId]/download — count a download and return the installable manifest.
import { userOnly, okResponse, withRateLimit } from "@/lib/api/route-helpers";
import { ApiError } from "@/lib/http/middleware";
import { incrementDownload } from "@/lib/supa-os/marketplace-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = userOnly(async (req, ctx) => {
  const rl = await withRateLimit(req, ctx.user!.userId);
  if (rl) return rl;
  const match = req.nextUrl.pathname.match(/\/marketplace\/([^/]+)\/download\/?$/);
  const itemId = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!itemId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new ApiError("not_found", 404, { param: "itemId" });
  }
  const item = await incrementDownload(itemId);
  if (!item) throw new ApiError("not_found", 404, { itemId });
  return okResponse({ item, downloadedAt: new Date().toISOString() });
});
