// POST /api/supa-os/marketplace/[itemId]/review
//
// Approves or rejects a marketplace item. Only an admin owner can call this.
//
// Body:
//   decision: "approve" | "reject"
//   notes: string (mandatory — recorded in audit trail)
//
// Auth: admin owner.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody, withRateLimit } from "@/lib/api/route-helpers";
import { completeReview, submitForReview, type ReviewCheck } from "@/lib/supa-os/marketplace";
import { getItem, persistReview, hasDuplicateManifest } from "@/lib/supa-os/marketplace-repository";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  notes: z.string().min(5, "Reviewer notes are required (min 5 chars)").max(2000),
});

export const POST = adminOnly("owner", async (req, ctx) => {
  // Rate limit: 3 marketplace reviews per admin per minute (supaOsPublish tier).
  // Approvals/rejections affect the public marketplace — keep tight.
  const rl = await withRateLimit(req, ctx.admin!.adminId);
  if (rl) return rl;

  // Route params are not properties of NextRequest in the App Router. Read the
  // dynamic segment from the canonical route path instead.
  const match = req.nextUrl.pathname.match(/\/marketplace\/([^/]+)\/review\/?$/);
  const itemId = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!itemId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new ApiError("not_found", 404, { param: "itemId" });
  }

  const body = await parseJsonBody(req, BodySchema);

  const item = await getItem(itemId);
  if (!item) throw new ApiError("not_found", 404, { itemId });
  if (item.status !== "in_review") throw new ApiError("marketplace_item_not_reviewable", 409, { itemId, status: item.status });

  // Re-run server-side automated checks; never trust check results submitted by
  // the browser. Human approval is permitted only if every automated check
  // passed. The quality check is completed by this owner review.
  const duplicateManifest = await hasDuplicateManifest(item);
  const automated = submitForReview(item, { duplicateManifest }).checks;
  const failed = automated.filter((check) => check.id !== "quality" && check.status !== "approved");
  if (body.decision === "approve" && failed.length) {
    throw new ApiError("marketplace_checks_failed", 409, { failedChecks: failed.map((check) => ({ id: check.id, status: check.status, notes: check.notes })) });
  }
  const checks: ReviewCheck[] = automated.map((check) => ({ ...check, reviewer: ctx.admin!.adminId }));
  const quality = checks.find((check) => check.id === "quality");
  if (quality) { quality.status = body.decision === "approve" ? "approved" : "rejected"; quality.notes = body.notes; }
  const updatedItem = completeReview({ item, checks, decision: body.decision, reviewerId: ctx.admin!.adminId, notes: body.notes });

  // Persist the decision and review history in a single transaction.
  await persistReview({ item: updatedItem, reviewerId: ctx.admin!.adminId, decision: body.decision, notes: body.notes, reviewChecks: checks });

  return okResponse({
    item: updatedItem,
    reviewedBy: ctx.admin!.adminId,
    reviewedAt: new Date().toISOString(),
  });
});
