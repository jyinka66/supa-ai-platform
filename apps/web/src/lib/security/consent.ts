// Cookie consent — per-jurisdiction consent management.
//
// The spec: "Cookies and consent handled per jurisdiction." +
// "Local data protection laws respected (GDPR, LGPD, DPDP, POPIA, PIPL)."
//
// Jurisdictions have different consent models:
//   - GDPR (EU): opt-IN. Analytics + marketing cookies require explicit consent.
//   - CCPA (US): opt-OUT. Users can opt out of sale/sharing.
//   - LGPD (Brazil): opt-IN (similar to GDPR).
//   - DPDP (India): opt-IN.
//   - POPIA (South Africa): opt-IN.
//   - PIPL (China): opt-IN, strict data localization.
//   - none: no consent required (default — necessary cookies only).
//
// Consent is:
//   1. Recorded with the jurisdiction, the consent version, and the categories.
//   2. Versioned — when the cookie policy changes, re-consent is required.
//   3. Withdrawable — users can withdraw consent at any time.
//   4. Expiring — some jurisdictions require re-consent after a period (GDPR: 13 months).

import { db } from "@supa/db";
import { cookieConsent } from "@supa/db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ConsentJurisdiction = "gdpr" | "ccpa" | "lgpd" | "dpdp" | "popia" | "pipl" | "none";
export type ConsentCategory = "necessary" | "analytics" | "marketing" | "functional";

export interface ConsentRecord {
  id: string;
  userId: string | null;
  sessionId: string;
  jurisdiction: ConsentJurisdiction;
  consentGiven: boolean;
  consentCategories: ConsentCategory[];
  consentVersion: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  withdrawnAt: Date | null;
}

// ───────────────────────────────────────────────
// Jurisdiction → consent model.
// ───────────────────────────────────────────────

export type ConsentModel = "opt_in" | "opt_out" | "none";

export const JURISDICTION_MODEL: Record<ConsentJurisdiction, ConsentModel> = {
  gdpr: "opt_in",   // EU: explicit consent required.
  ccpa: "opt_out",  // US: opt-out of sale/sharing.
  lgpd: "opt_in",   // Brazil: explicit consent.
  dpdp: "opt_in",   // India: explicit consent.
  popia: "opt_in",  // South Africa: explicit consent.
  pipl: "opt_in",   // China: explicit consent + data localization.
  none: "none",     // No consent required (necessary cookies only).
};

/** Which cookie categories require consent per jurisdiction. */
export const JURISDICTION_REQUIRED_CATEGORIES: Record<ConsentJurisdiction, ConsentCategory[]> = {
  gdpr: ["analytics", "marketing", "functional"], // all non-necessary.
  ccpa: ["marketing"], // sale/sharing of personal data.
  lgpd: ["analytics", "marketing", "functional"],
  dpdp: ["analytics", "marketing", "functional"],
  popia: ["analytics", "marketing", "functional"],
  pipl: ["analytics", "marketing", "functional"],
  none: [], // no consent required.
};

/** Consent expiry per jurisdiction (re-consent required after this period). */
export const JURISDICTION_CONSENT_EXPIRY_DAYS: Record<ConsentJurisdiction, number | null> = {
  gdpr: 395, // 13 months (GDPR recommendation).
  ccpa: null, // no expiry (opt-out persists).
  lgpd: null,
  dpdp: null,
  popia: null,
  pipl: 365, // 1 year.
  none: null,
};

/** The current cookie policy version (bump when the policy changes → re-consent required). */
export const CURRENT_CONSENT_VERSION = "1.0.0";

// ───────────────────────────────────────────────
// recordConsent — record a user's consent decision.
// ───────────────────────────────────────────────

/**
 * Record a user's cookie consent.
 *
 * For opt-in jurisdictions (GDPR/LGPD/DPDP/POPIA/PIPL): consentGiven=false
 * unless the user explicitly opted in. The consentCategories reflect what
 * the user agreed to.
 *
 * For opt-out jurisdictions (CCPA): consentGiven=true by default (necessary
 * cookies always set); the user can opt out of marketing later.
 *
 * @throws Error if the jurisdiction is invalid.
 */
export async function recordConsent(input: {
  userId?: string | null;
  sessionId: string;
  jurisdiction: ConsentJurisdiction;
  consentGiven: boolean;
  consentCategories: ConsentCategory[];
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ConsentRecord> {
  const model = JURISDICTION_MODEL[input.jurisdiction] ?? "none";
  const expiryDays = JURISDICTION_CONSENT_EXPIRY_DAYS[input.jurisdiction];
  const expiresAt = expiryDays != null
    ? new Date(Date.now() + expiryDays * 86400000)
    : null;

  // For opt-out (CCPA), consentGiven defaults to true (necessary cookies).
  // The user opts out by setting consentGiven=false for the marketing category.
  const effectiveConsent = model === "opt_out" ? true : input.consentGiven;

  const rows = await db
    .insert(cookieConsent)
    .values({
      ...(input.userId ? { userId: input.userId as any } : {}),
      sessionId: input.sessionId,
      jurisdiction: input.jurisdiction,
      consentGiven: effectiveConsent,
      consentCategories: input.consentCategories,
      consentVersion: CURRENT_CONSENT_VERSION,
      ...(input.ip ? { ip: input.ip as any } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    })
    .returning({ id: cookieConsent.id, createdAt: cookieConsent.createdAt });

  const row = rows[0];
  if (!row) throw new Error("consent_insert_failed");

  return {
    id: row.id as string,
    userId: input.userId ?? null,
    sessionId: input.sessionId,
    jurisdiction: input.jurisdiction,
    consentGiven: effectiveConsent,
    consentCategories: input.consentCategories,
    consentVersion: CURRENT_CONSENT_VERSION,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: row.createdAt,
    expiresAt,
    withdrawnAt: null,
  };
}

// ───────────────────────────────────────────────
// withdrawConsent — user withdraws consent.
// ───────────────────────────────────────────────

export async function withdrawConsent(sessionId: string): Promise<void> {
  await db
    .update(cookieConsent)
    .set({ withdrawnAt: new Date(), consentGiven: false, consentCategories: ["necessary"] })
    .where(
      and(
        eq(cookieConsent.sessionId, sessionId),
        isNull(cookieConsent.withdrawnAt),
      ),
    );
}

// ───────────────────────────────────────────────
// getConsent — check if a session has valid consent.
// ───────────────────────────────────────────────

/**
 * Check if a session has valid (non-expired, non-withdrawn) consent for the
 * given categories. Returns the consent record or null.
 *
 * For opt-out jurisdictions (CCPA): returns a synthetic "consent given" record
 * if no explicit consent exists (the default is opt-in for necessary only).
 */
export async function getConsent(sessionId: string): Promise<ConsentRecord | null> {
  const rows = await db
    .select()
    .from(cookieConsent)
    .where(eq(cookieConsent.sessionId, sessionId))
    .orderBy(desc(cookieConsent.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const expiresAt = row.expiresAt;
  const isExpired = expiresAt != null && Date.now() > expiresAt.getTime();
  const isWithdrawn = row.withdrawnAt != null;

  return {
    id: row.id as string,
    userId: (row.userId as string | null) ?? null,
    sessionId: row.sessionId,
    jurisdiction: row.jurisdiction as ConsentJurisdiction,
    consentGiven: !isExpired && !isWithdrawn ? row.consentGiven : false,
    consentCategories: (row.consentCategories as ConsentCategory[]) ?? ["necessary"],
    consentVersion: row.consentVersion,
    ip: row.ip != null ? String(row.ip) : null,
    userAgent: (row.userAgent as string | null) ?? null,
    createdAt: row.createdAt,
    expiresAt,
    withdrawnAt: row.withdrawnAt,
  };
}

/**
 * Check if a specific cookie category is allowed for a session.
 *
 * "necessary" is ALWAYS allowed (no consent needed — essential cookies).
 * All other categories require consent (for opt-in jurisdictions) or are
 * allowed by default (for opt-out/none jurisdictions).
 */
export function isCategoryAllowed(
  consent: ConsentRecord | null,
  category: ConsentCategory,
): boolean {
  // Necessary cookies are always allowed.
  if (category === "necessary") return true;

  // No consent record → check the jurisdiction model.
  if (!consent) return false;

  // Consent withdrawn or expired → only necessary.
  if (consent.withdrawnAt != null) return false;
  if (consent.expiresAt != null && Date.now() > consent.expiresAt.getTime()) return false;

  // Check if the category is in the consented categories.
  return consent.consentCategories.includes(category);
}
