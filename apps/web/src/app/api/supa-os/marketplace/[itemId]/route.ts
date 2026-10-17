// GET /api/supa-os/marketplace/[itemId] — fetch a published item's full manifest.
import { withHandler, okResponse, withRateLimit } from "@/lib/api/route-helpers";
import { ApiError } from "@/lib/http/middleware";
import { getItem } from "@/lib/supa-os/marketplace-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHandler(async (req) => {
  const clientId = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anonymous";
  const rl = await withRateLimit(req, `marketplace-detail:${clientId}`);
  if (rl) return rl;
  const match = req.nextUrl.pathname.match(/\/marketplace\/([^/]+)\/?$/);
  const itemId = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!itemId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new ApiError("not_found", 404, { param: "itemId" });
  }
  const item = await getItem(itemId);
  if (!item || item.status !== "published") throw new ApiError("not_found", 404, { itemId });
  const { manifest: _manifest, ...publicItem } = item;
  return okResponse({ item: publicItem });
});
