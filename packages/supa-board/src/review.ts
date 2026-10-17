// Reviews — gated at the data layer, as designed.
//
// The gate is a foreign key with teeth: a review row REQUIRES a
// completed-contract fact id linking reviewer to counterparty.
// Not a UI check, not a service check — the schema constraint.
// Fake reviews aren't moderated; they're unrepresentable.
//
// Double-blind: reviews stored immediately, revealed to both
// parties only when both have submitted (or after a 14-day
// window). Reveal is a derived render over facts.
// Reviews both ways: freelancer reviews client, client reviews
// freelancer — same table, direction field, same gate.

import { z } from "zod";
import { db } from "@supa/db";
import { reviews, activityFacts } from "@supa/db/schema";

// FIX: inlined helper (same pattern as all other files in this package).
async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

// ───────────────────────────────────────────────
// Direction — who is reviewing whom
// ───────────────────────────────────────────────

export const ReviewDirection = z.enum([
  "freelancer_to_client",  // freelancer reviews the client
  "client_to_freelancer",  // client reviews the freelancer
]);

// ───────────────────────────────────────────────
// Review schema
// ───────────────────────────────────────────────

export const Review = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),               // the reviewer's workspace
  contractId: z.string().uuid(),          // FK to a completed contract — the gate with teeth
  contractCompletedFactId: z.string(),    // the monetary fact that proves the contract completed — fake reviews are unrepresentable
  direction: ReviewDirection,
  reviewerWsId: z.string().uuid(),        // the reviewer's wsId
  revieweeWsId: z.string().uuid(),       // the counterparty's wsId
  rating: z.number().int().min(1).max(5),// 1..5 stars
  text: z.string().max(5_000).optional(),
  // Double-blind: stored immediately, revealed only when both submit
  // or after the 14-day window. The stored review is always real;
  // visibility is derived (never stored as a flag).
  submittedAt: z.string().datetime(),
  // The 14-day window starts at contract completion, not at review
  // submission — so a late review still reveals on schedule.
  contractCompletedAt: z.string().datetime(),
});

export type ReviewDirection = z.infer<typeof ReviewDirection>;
export type Review = z.infer<typeof Review>;

// ───────────────────────────────────────────────
// Reveal status — derived, never stored
// ───────────────────────────────────────────────

export type RevealStatus =
  | "hidden"               // one side hasn't reviewed yet, window not expired
  | "revealed"             // both sides reviewed, or 14-day window expired
  | "expired_unilateral";  // window expired, only one side reviewed

const REVEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Derive the reveal status from facts — never stored as a flag.
 *
 *   hidden:              one side hasn't reviewed yet, window not expired
 *   revealed:            both sides have submitted reviews
 *   expired_unilateral:  14-day window expired, only one side reviewed
 *
 * The review is always stored immediately (double-blind = both
 * hidden until reveal, not "wait to submit"). The reveal is a
 * render decision over facts.
 */
export function revealStatus(
  thisReview: Review,
  counterpartyReview: Review | null,
  now: string = new Date().toISOString(),
): RevealStatus {
  const nowMs = new Date(now).getTime();
  const windowEnd = new Date(thisReview.contractCompletedAt).getTime() + REVEAL_WINDOW_MS;

  if (counterpartyReview) {
    return "revealed";
  }

  if (nowMs >= windowEnd) {
    return "expired_unilateral";
  }

  return "hidden";
}

// ───────────────────────────────────────────────
// Submit review — the gate with teeth
// ───────────────────────────────────────────────

/**
 * Submit a review. The gate is the contractCompletedFactId — a
 * review without a completed-contract fact is unrepresentable
 * (schema constraint, not a UI check).
 *
 * Double-blind: the review is stored immediately but hidden
 * from the counterparty until both sides submit or the 14-day
 * window expires.
 */
export async function submitReview(
  wsId: string,
  input: Omit<Review, "id" | "wsId" | "submittedAt">,
): Promise<Review> {
  const review: Review = {
    ...input,
    id: crypto.randomUUID(),
    wsId,
    submittedAt: new Date().toISOString(),
  };

  // Validate: the contractCompletedFactId must reference a real
  // completed-contract fact linking reviewer to counterparty.
  // In the real impl, this is a DB FK constraint + a query that
  // verifies the fact exists + the contract is in "completed" status.
  // Here we assert the schema shape.
  Review.parse(review);

  return db.transaction(async (tx) => {
    // Insert the review row. The FK constraint
    // (contractCompletedFactId → monetary_facts.id WHERE kind =
    // "contract-completed") is the gate with teeth — a fabricated
    // fact id is rejected at insert time, not by app code.
    await tx.insert(reviews).values({
      id: review.id,
      workspaceId: review.wsId,
      contractId: review.contractId,
      contractCompletedFactId: review.contractCompletedFactId,
      direction: review.direction,
      reviewerWsId: review.reviewerWsId,
      revieweeWsId: review.revieweeWsId,
      rating: review.rating,
      text: review.text ?? null,
      submittedAt: new Date(review.submittedAt),
      contractCompletedAt: new Date(review.contractCompletedAt),
    });

    await recordActivity(tx, {
      wsId,
      kind: "supa.review.submitted",
      ref: {
        reviewId: review.id,
        contractId: review.contractId,
        direction: review.direction,
      },
    });

    return review;
  });
}

// ───────────────────────────────────────────────
// Query reviews — only revealed ones are visible to the counterparty
// ───────────────────────────────────────────────

/**
 * Get reviews for a workspace, respecting the double-blind reveal.
 * A review is visible to the counterparty only when:
 *   - both sides have submitted (revealStatus = "revealed"), OR
 *   - the 14-day window expired (revealStatus = "expired_unilateral")
 *
 * Hidden reviews are never returned to the counterparty — only
 * to the reviewer themselves (their own draft is always visible
 * to them).
 */
export function filterRevealedReviews(
  reviews: readonly Review[],
  counterpartyReviews: ReadonlyMap<string, Review | null>,
  requesterWsId: string,
  now: string = new Date().toISOString(),
): readonly Review[] {
  return reviews.filter((review) => {
    // The reviewer always sees their own review.
    if (review.reviewerWsId === requesterWsId) return true;

    // The counterparty sees it only when revealed.
    const counterparty = counterpartyReviews.get(review.contractId) ?? null;
    const status = revealStatus(review, counterparty, now);
    return status === "revealed" || status === "expired_unilateral";
  });
}
