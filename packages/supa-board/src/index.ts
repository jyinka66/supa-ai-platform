/**
 * @supa/supa-board — the public job board.
 *
 *   listing     — the public face of a supa-source job. One job,
 *                 one listing, draft → published → closed. Publish
 *                 is a FACT, not a flag.
 *   application — the propose-and-confirm surface. AI drafts,
 *                 freelancer authors, everything editable before
 *                 submit. Two-side tenancy: freelancer owns drafts,
 *                 client sees a masked view.
 */

export {
  ListingStatus,
  Listing,
  publishListing,
  closeListing,
  shouldAutoClose,
  canTransition as canTransitionListing,
} from "./listing.js";

export type { ListingStatus as ListingStatusType, Listing as ListingType } from "./listing.js";

export {
  Application,
  maskForClient,
  canTransition as canTransitionApplication,
  withdraw,
  requestClientInfo,
} from "./application.js";

export type { ApplicationStatus, Application as ApplicationType, ApplicationView } from "./application.js";

export {
  matchScore,
} from "./match.js";

export type { ListingJob, Profile, MatchFactor, MatchResult } from "./match.js";

export {
  canTransitionMilestone,
  assertTransition,
  canTransitionContract,
  assertCanCancel,
  assertOneActiveMilestone,
  assertMilestoneSum,
  submitMilestone,
  progress,
} from "./contract.js";

export type { MilestoneStatus, ContractStatus, Milestone, Contract } from "./contract.js";

export {
  submitReview,
  revealStatus,
  filterRevealedReviews,
} from "./review.js";

export type { ReviewDirection, Review, RevealStatus } from "./review.js";
