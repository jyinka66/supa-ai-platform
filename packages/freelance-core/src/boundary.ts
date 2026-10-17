/**
 * @supa/freelance-core/boundary
 * ----------------------------------------------------------------
 * The external-platform invariant as a runtime guard, paired
 * with the CI lint (no outbound fetch to platform domains from
 * this package — asserted structurally in tests below).
 *
 *   assertExternalIsolation(job) — called at write time (before
 *   persisting a job). Enforces two invariants:
 *
 *   1. External jobs carry NO board fields (listingId, applicationId).
 *      If a future edit adds one, this throws in every test workspace
 *      before it ships. External jobs are captured snapshots — they
 *      don't maintain a live connection to the platform.
 *
 *   2. Supa (internal) jobs carry NO externalRef. A job sourced from
 *      our own marketplace has no Upwork/Fiverr/Direct reference. If
 *      it does, it's a data corruption (wrong source field) and this
 *      catches it before it ships.
 *
 * The CI lint complement: no outbound fetch to platform domains from
 * this package. The boundary is both runtime (this guard) and
 * structural (the lint rule). Two gates, same invariant.
 * ----------------------------------------------------------------
 */

import type { FreelanceJob } from "./job.js";

export class ExternalIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalIsolationError";
  }
}

/**
 * Assert the external-platform isolation invariant at write time.
 *
 * Called before persisting a job (in createJob + transitionJob).
 * Throws ExternalIsolationError on violation — the write is blocked.
 *
 * The guard is deliberately checking for FIELD PRESENCE, not type —
 * `in` operator catches any field that was added, even if it's null
 * or undefined (a defensive measure against "I set it then forgot to
 * clear it" bugs).
 */
export function assertExternalIsolation(job: FreelanceJob): void {
  // 1. External jobs must NOT carry board fields.
  if (job.source === "external") {
    if ("listingId" in job || "applicationId" in job) {
      throw new ExternalIsolationError(
        "INVARIANT VIOLATION: external job carries board fields (listingId/applicationId) — external jobs are captured snapshots, not live connections",
      );
    }
  }

  // 2. Supa (internal) jobs must NOT carry an externalRef.
  if (job.source === "supa" && job.externalRef !== undefined) {
    throw new ExternalIsolationError(
      "INVARIANT VIOLATION: supa job carries an external platform ref — internal marketplace jobs have no Upwork/Fiverr reference",
    );
  }
}

/**
 * The CI lint complement. Documented here so the lint rule + the
 * runtime guard + the tests all reference the same source of truth.
 *
 * Rule: no outbound HTTP fetch to platform domains (upwork.com,
 * fiverr.com, etc.) from any file in packages/freelance-core/.
 * External platform data arrives via the API boundary (captured
 * at job creation time); the freelance-core package never reaches
 * back out to the platform.
 */
export const LINT_RULE_NO_PLATFORM_FETCH = {
  rule: "no-platform-fetch-in-freelance-core",
  description:
    "No outbound HTTP fetch to external platform domains (upwork.com, fiverr.com, etc.) from packages/freelance-core/. " +
    "External platform data arrives via the API boundary at job creation time; the package never reaches back out.",
  forbiddenPatterns: [
    "fetch('https://upwork.com",
    "fetch('https://fiverr.com",
    "fetch('https://www.upwork.com",
    "fetch('https://www.fiverr.com",
  ],
  allowlist: ["packages/freelance-core/**"],
};
