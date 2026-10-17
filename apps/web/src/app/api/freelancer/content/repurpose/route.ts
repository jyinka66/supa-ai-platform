// POST /api/freelancer/content/repurpose
//
// Repurpose content across platforms — takes a blog post / transcript / article
// and generates Twitter thread, LinkedIn post, Instagram caption, email
// newsletter, show notes, meta description, or ad copy variants.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { repurposeContent, PLATFORM_LIMITS, type Platform } from "@/lib/freelancer/content-repurposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  sourceContent: z.string().min(50, "Content must be at least 50 characters").max(50000),
  sourceType: z.enum(["blog_post", "video_transcript", "podcast_transcript", "article", "product_description"]),
  platforms: z.array(z.enum([
    "twitter_thread", "linkedin_post", "instagram_caption",
    "email_newsletter", "show_notes", "meta_description", "ad_copy",
  ])).min(1),
  tone: z.enum(["professional", "casual", "bold", "educational", "playful"]).optional(),
  language: z.string().max(5).optional(),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const result = repurposeContent({
    sourceContent: body.sourceContent,
    sourceType: body.sourceType,
    platforms: body.platforms as Platform[],
    tone: body.tone,
    language: body.language ?? "en",
  });
  return okResponse({
    variants: result.variants,
    extractedKeyPoints: result.extractedKeyPoints,
    platformLimits: PLATFORM_LIMITS,
  });
});
