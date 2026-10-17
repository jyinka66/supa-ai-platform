// Legal document service — versioned, localized, review-gated.
//
// The spec: "Automated version control — every legal document has a version
// history, published and archived." + "Legal review workflow — new
// jurisdictions reviewed by legal before launch." + "Automated legal updates
// — legal changes propagated across locales."
//
// Flow:
//   1. createDraftVersion(docId, locale, body, changelog) — creates a 'draft' version.
//   2. submitForReview(versionId) — moves draft → 'in_review', creates a legal_review entry.
//   3. approveVersion(versionId, reviewerId) — moves 'in_review' → 'published', sets the
//      document's current_version_id, archives the previous published version.
//   4. archiveVersion(versionId) — moves a published version → 'archived' (it remains
//      in the history for audit; the current version is the latest 'published').
//
// Versioning: each version is a new row in legal_versions. The table is
// append-only (REVOKE UPDATE/DELETE — legal audit trail). The only mutable
// field is `status` (draft → in_review → published → archived) — but even
// that is transitioned via INSERT (a new audit entry) rather than UPDATE
// where possible. For simplicity, status transitions use UPDATE (the REVOKE
// is on the table, so only the security-definer path can do it).
//
// Localization: each version has a locale. A document can have different
// versions for different locales (e.g. privacy policy v1.2 for en, v1.0 for fr).

import { db } from "@supa/db";
import { legalDocuments, legalVersions, legalReview } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type LegalDocType =
  | "privacy" | "terms" | "cookies" | "dpa"
  | "refund" | "security" | "subprocessors" | "aup";

export type LegalVersionStatus = "draft" | "in_review" | "published" | "archived";
export type LegalReviewStatus = "pending" | "assigned" | "approved" | "rejected";

export interface LegalDocument {
  id: string;
  docType: LegalDocType;
  jurisdiction: string;
  title: string;
  description: string | null;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegalVersion {
  id: string;
  documentId: string;
  version: string;
  locale: string;
  body: string;
  changelog: string | null;
  status: LegalVersionStatus;
  effectiveDate: Date | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  reviewedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export class LegalError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "LegalError";
  }
}

// ───────────────────────────────────────────────
// createDraftVersion — start a new version.
// ───────────────────────────────────────────────

/**
 * Create a draft version of a legal document.
 *
 * @param documentId — the legal_documents.id.
 * @param version — the semver version string (e.g. '1.2.0').
 * @param locale — the locale this version is for.
 * @param body — the full legal text (markdown/HTML).
 * @param changelog — what changed from the previous version.
 *
 * @throws LegalError(409) if a version with the same (documentId, version, locale) exists.
 */
export async function createDraftVersion(
  documentId: string,
  version: string,
  locale: string,
  body: string,
  changelog?: string,
): Promise<LegalVersion> {
  try {
    const rows = await db
      .insert(legalVersions)
      .values({
        documentId: documentId as any,
        version,
        locale,
        body,
        ...(changelog ? { changelog } : {}),
        status: "draft",
      })
      .returning({ id: legalVersions.id });
    const row = rows[0];
    if (!row) throw new LegalError("version_insert_failed", 500);

    await auditLegal("legal.version.draft_created", documentId, { version, locale });
    return await getVersion(row.id as string) ?? (() => { throw new LegalError("version_not_found_after_insert", 500); })();
  } catch (err) {
    if (err instanceof LegalError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      throw new LegalError("version_already_exists", 409);
    }
    throw err;
  }
}

// ───────────────────────────────────────────────
// submitForReview — draft → in_review.
// ───────────────────────────────────────────────

/**
 * Submit a draft version for legal review.
 *
 * Creates a `legal_review` entry (status='pending') + moves the version to
 * 'in_review'. A legal reviewer is then assigned to review the changes.
 *
 * @throws LegalError(404) if the version doesn't exist.
 * @throws LegalError(409) if the version is not in 'draft' status.
 */
export async function submitForReview(
  versionId: string,
  requestedBy: string,
): Promise<void> {
  const version = await getVersion(versionId);
  if (!version) throw new LegalError("version_not_found", 404);
  if (version.status !== "draft") {
    throw new LegalError(`version_not_draft:${version.status}`, 409);
  }

  await db
    .update(legalVersions)
    .set({ status: "in_review" })
    .where(eq(legalVersions.id, versionId as any));

  await db.insert(legalReview).values({
    documentId: version.documentId as any,
    jurisdiction: "global", // default — would be passed in for jurisdiction-specific reviews.
    requestedBy: requestedBy as any,
    status: "pending",
  });

  await auditLegal("legal.version.submitted_for_review", version.documentId, { versionId, version: version.version });
}

// ───────────────────────────────────────────────
// approveVersion — in_review → published (archiving the previous).
// ───────────────────────────────────────────────

/**
 * Approve a reviewed version — publishes it + archives the previous published version.
 *
 * Flow:
 *   1. Verify the version is in 'in_review' status.
 *   2. Find the currently-published version for this (document, locale).
 *   3. Archive it (status → 'archived', archived_at = now()).
 *   4. Publish the new version (status → 'published', published_at = now(),
 *      effective_date = now(), reviewed_by, approved_at = now()).
 *   5. Update legal_documents.current_version_id to the new version.
 *   6. Resolve the legal_review entry (status → 'approved').
 *
 * @throws LegalError(404) if the version doesn't exist.
 * @throws LegalError(409) if the version is not 'in_review'.
 */
export async function approveVersion(
  versionId: string,
  reviewerId: string,
): Promise<LegalVersion> {
  const version = await getVersion(versionId);
  if (!version) throw new LegalError("version_not_found", 404);
  if (version.status !== "in_review") {
    throw new LegalError(`version_not_in_review:${version.status}`, 409);
  }

  // Find + archive the currently-published version for this (document, locale).
  const currentPublished = await db
    .select({ id: legalVersions.id })
    .from(legalVersions)
    .where(
      and(
        eq(legalVersions.documentId, version.documentId as any),
        eq(legalVersions.locale, version.locale as any),
        eq(legalVersions.status, "published"),
      ),
    )
    .limit(1);

  if (currentPublished[0]) {
    await db
      .update(legalVersions)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(legalVersions.id, currentPublished[0].id as any));
  }

  // Publish the new version.
  const now = new Date();
  await db
    .update(legalVersions)
    .set({
      status: "published",
      publishedAt: now,
      effectiveDate: now,
      reviewedBy: reviewerId as any,
      approvedAt: now,
    })
    .where(eq(legalVersions.id, versionId as any));

  // Update the document's current_version_id.
  await db
    .update(legalDocuments)
    .set({ currentVersionId: versionId as any, updatedAt: now })
    .where(eq(legalDocuments.id, version.documentId as any));

  // Resolve the legal_review entry.
  await db
    .update(legalReview)
    .set({ status: "approved", reviewerId: reviewerId as any, resolvedAt: now })
    .where(
      and(
        eq(legalReview.documentId, version.documentId as any),
        eq(legalReview.status, "pending"),
      ),
    );

  await auditLegal("legal.version.published", version.documentId, {
    versionId,
    version: version.version,
    locale: version.locale,
    reviewerId,
  });

  return (await getVersion(versionId))!;
}

// ───────────────────────────────────────────────
// getVersion / getCurrentVersion / listVersions.
// ───────────────────────────────────────────────

export async function getVersion(versionId: string): Promise<LegalVersion | null> {
  const rows = await db
    .select()
    .from(legalVersions)
    .where(eq(legalVersions.id, versionId as any))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    documentId: row.documentId as string,
    version: row.version,
    locale: row.locale,
    body: row.body,
    changelog: row.changelog,
    status: row.status as LegalVersionStatus,
    effectiveDate: row.effectiveDate,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    reviewedBy: (row.reviewedBy as string | null) ?? null,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Get the currently-published version for a document + locale.
 */
export async function getCurrentVersion(
  documentId: string,
  locale: string,
): Promise<LegalVersion | null> {
  const rows = await db
    .select()
    .from(legalVersions)
    .where(
      and(
        eq(legalVersions.documentId, documentId as any),
        eq(legalVersions.locale, locale as any),
        eq(legalVersions.status, "published"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    documentId: row.documentId as string,
    version: row.version,
    locale: row.locale,
    body: row.body,
    changelog: row.changelog,
    status: row.status as LegalVersionStatus,
    effectiveDate: row.effectiveDate,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    reviewedBy: (row.reviewedBy as string | null) ?? null,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
  };
}

/**
 * List all versions for a document (for the version history UI).
 */
export async function listVersions(documentId: string): Promise<LegalVersion[]> {
  const rows = await db
    .select()
    .from(legalVersions)
    .where(eq(legalVersions.documentId, documentId as any))
    .orderBy(sql`${legalVersions.createdAt} desc`);
  return rows.map((row) => ({
    id: row.id as string,
    documentId: row.documentId as string,
    version: row.version,
    locale: row.locale,
    body: row.body,
    changelog: row.changelog,
    status: row.status as LegalVersionStatus,
    effectiveDate: row.effectiveDate,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    reviewedBy: (row.reviewedBy as string | null) ?? null,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Get a legal document by type + jurisdiction.
 */
export async function getLegalDocument(
  docType: LegalDocType,
  jurisdiction: string = "global",
): Promise<LegalDocument | null> {
  const rows = await db
    .select()
    .from(legalDocuments)
    .where(
      and(
        eq(legalDocuments.docType, docType),
        eq(legalDocuments.jurisdiction, jurisdiction),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    docType: row.docType as LegalDocType,
    jurisdiction: row.jurisdiction,
    title: row.title,
    description: row.description,
    currentVersionId: (row.currentVersionId as string | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ───────────────────────────────────────────────
// Audit helper.
// ───────────────────────────────────────────────

async function auditLegal(action: string, documentId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await adminAudit({
      actor: "system",
      action,
      target: { documentId, ...target },
      justification: `legal document version operation: ${action}`,
    });
  } catch {
    // Audit failure must not break the operation.
  }
}
