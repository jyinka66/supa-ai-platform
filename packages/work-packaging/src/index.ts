/**
 * @supa/work-packaging — deliverables become portfolio pieces.
 *
 *   sample  — WorkSample derived from a PAID milestone's deliverables.
 *             Two tiers: verified (minted from paid milestone, carries
 *             contract ref) and self_added (manual upload, "self-reported"
 *             badge, capped count). Client confidentiality rules:
 *             consent-or-full-redaction, revocable (unpublish ≠ erase),
 *             disputed/cancelled contracts cannot mint.
 *   profile — Public profile as a materialized read model. Everything
 *             verified is a query over facts (contracts, reviews, ledger).
 *             The claimed section is freelancer-editable; the verified
 *             section is evidence-backed. Small samples don't get numbers
 *             (N≥5 before on-time rate / rating / response time appears).
 */

export * from "./sample.js";
export * from "./profile.js";
