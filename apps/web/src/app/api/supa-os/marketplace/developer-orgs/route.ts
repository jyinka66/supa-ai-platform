// POST /api/supa-os/marketplace/developer-orgs — self-serve developer registration.
import { z } from "zod";
import { userOnly, okResponse, parseJsonBody, withRateLimit } from "@/lib/api/route-helpers";
import { ApiError } from "@/lib/http/middleware";
import { createDeveloperOrg } from "@/lib/platform/developer-ecosystem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  slug: z.string().trim().toLowerCase().min(3).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens"),
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(500).optional(),
});

export const POST = userOnly(async (req, ctx) => {
  const userId = ctx.user!.userId;
  const rateLimit = await withRateLimit(req, userId);
  if (rateLimit) return rateLimit;
  const body = await parseJsonBody(req, BodySchema);
  try {
    const organization = await createDeveloperOrg({ ...body, ownerUserId: userId });
    return okResponse({ organization }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "slug_already_exists") {
      throw new ApiError("developer_org_slug_taken", 409, { slug: body.slug });
    }
    throw error;
  }
});
