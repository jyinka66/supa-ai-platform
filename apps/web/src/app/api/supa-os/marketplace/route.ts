// Marketplace API
//
//   GET    /api/supa-os/marketplace            — browse / discover items
//   POST   /api/supa-os/marketplace            — submit a new item for review
//   POST   /api/supa-os/marketplace/[itemId]/review — approve / reject (admin owner)
//
// The marketplace supports 5 item types: agent_skill, api_connector,
// ui_component, template, theme. Each submitted item goes through automated
// checks (schema, security, permissions, budget, plagiarism) and a manual
// review by an admin before publishing.

import { NextRequest } from "next/server";
import { z } from "zod";
import { userOnly, withHandler, okResponse, parseJsonBody, paginate, withRateLimit } from "@/lib/api/route-helpers";
import {
  MARKETPLACE_ITEM_TYPES,
  submitForReview,
  type MarketplaceItem,
  type MarketplaceItemType,
  type MonetizationModel,
} from "@/lib/supa-os/marketplace";
import { insertItem, listItems, countItems, hasDuplicateManifest, getDeveloperOrgForOwner } from "@/lib/supa-os/marketplace-repository";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/supa-os/marketplace
// Returns marketplace items + the type catalog. Supports the discovery query
// params (q, type, tags, monetization, sort, verifiedOnly).
export const GET = withHandler(async (req, ctx) => {
  const clientId = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anonymous";
  const rl = await withRateLimit(req, `marketplace-public:${clientId}`);
  if (rl) return rl;
  const url = new URL(req.url);
  const pagination = paginate(url, { pageSize: 24 });

  const query = {
    query: url.searchParams.get("q") ?? undefined,
    type: url.searchParams.get("type") as MarketplaceItemType | undefined,
    tags: url.searchParams.getAll("tag"),
    monetization: url.searchParams.get("monetization") as MonetizationModel | undefined,
    verifiedOnly: url.searchParams.get("verifiedOnly") === "true",
    sort: url.searchParams.get("sort") as "trending" | "newest" | "top_rated" | "most_downloaded" | "featured" | undefined,
  };

  const [pageItems, total] = await Promise.all([
    listItems({ q: query.query, type: query.type, tags: query.tags, monetization: query.monetization, verifiedOnly: query.verifiedOnly, sort: query.sort, limit: pagination.take, offset: pagination.skip }),
    countItems({ q: query.query, type: query.type, tags: query.tags, monetization: query.monetization, verifiedOnly: query.verifiedOnly }),
  ]);

  return okResponse({
    items: pageItems,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    types: MARKETPLACE_ITEM_TYPES,
  });
});

// POST /api/supa-os/marketplace
// Authenticated developer-org owners submit items for automated review.
const SubmitBodySchema = z.object({
  developerOrgId: z.string().uuid().optional(),
  name: z.string().trim().min(3).max(100),
  type: z.enum(["agent_skill", "api_connector", "ui_component", "template", "theme"]),
  description: z.string().trim().min(20).max(2000),
  monetization: z.enum(["free", "one_time", "subscription", "revenue_share"]),
  price: z.number().min(0).max(10_000),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver (1.2.3)"),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  manifest: z.record(z.string(), z.unknown()),
}).superRefine((body, ctx) => {
  const required: Record<typeof body.type, string[]> = {
    agent_skill: ["entrypoint", "permissions"],
    api_connector: ["entrypoint", "permissions"],
    ui_component: ["entrypoint", "permissions"],
    template: ["files", "permissions"],
    theme: ["tokens"],
  };
  for (const key of required[body.type]) {
    if (!(key in body.manifest)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", key], message: `manifest.${key} is required for ${body.type}` });
  }
  if (body.type !== "theme") {
    const hasSource = (typeof body.manifest.source === "string" && body.manifest.source.trim().length > 0) ||
      (typeof body.manifest.code === "string" && body.manifest.code.trim().length > 0) ||
      (Array.isArray(body.manifest.files) && body.manifest.files.some((file) => typeof file === "object" && file !== null && "content" in file && typeof (file as Record<string, unknown>).content === "string"));
    if (!hasSource) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifest", "source"], message: "Executable assets must include inspectable source code or file contents" });
  }
  if (body.monetization === "free" && body.price !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["price"], message: "Free items must have a price of zero" });
});

export const POST = userOnly(async (req, ctx) => {
  const body = await parseJsonBody(req, SubmitBodySchema);
  const userId = ctx.user!.userId;
  const rl = await withRateLimit(req, userId);
  if (rl) return rl;
  const developerOrg = await getDeveloperOrgForOwner(userId, body.developerOrgId);
  if (!developerOrg) throw new ApiError("developer_org_required", 403, { hint: "Create or select an active developer organization you own before submitting marketplace items." });

  const item: MarketplaceItem = {
    id: crypto.randomUUID(),
    name: body.name,
    type: body.type,
    description: body.description,
    creatorId: developerOrg.id,
    creatorName: developerOrg.name,
    status: "draft",
    monetization: body.monetization,
    price: body.price,
    version: body.version,
    tags: body.tags ?? [],
    manifest: body.manifest ?? {},
    downloadCount: 0,
    rating: 0,
    reviewCount: 0,
    featured: false,
    verified: false,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Run the automated review checks.
  const duplicateManifest = await hasDuplicateManifest(item);
  const { item: updatedItem, checks } = submitForReview(item, { duplicateManifest });
  await insertItem(updatedItem, checks);

  return okResponse({
    item: updatedItem,
    checks,
    submittedBy: userId,
    submittedAt: new Date().toISOString(),
  });
});
