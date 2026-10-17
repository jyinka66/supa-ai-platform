import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import {
  getLegalDocument,
  createDraftVersion,
  submitForReview,
  LegalError,
} from "@/lib/legal/service";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import type { LegalDocType } from "@/lib/legal/service";

/**
 * POST /api/admin/legal/:docType/version
 *
 * Create a new draft version of a legal document + submit it for review.
 *
 * The versioning flow:
 *   1. createDraftVersion(docId, version, locale, body, changelog) — creates a 'draft'.
 *   2. submitForReview(versionId, requestedBy) — moves draft → 'in_review',
 *      creates a legal_review entry.
 *
 * After this, a legal reviewer approves via POST /api/admin/legal/:docType/approve.
 *
 * Auth: admin session with minRole="owner".
 *
 * Body:
 *   {
 *     "version": "1.2.0",           // semver
 *     "locale": "en",               // the locale this version is for
 *     "body": "Privacy Policy...", // the full legal text
 *     "changelog": "Updated cookie section"  // what changed
 *   }
 *
 * Response 201: { "versionId": "...", "status": "in_review" }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VersionBody = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (e.g. 1.2.0)"),
  locale: z.string().min(2).max(10),
  body: z.string().min(1),
  changelog: z.string().max(2000).optional(),
});

const VALID_DOC_TYPES = new Set([
  "privacy", "terms", "cookies", "dpa",
  "refund", "security", "subprocessors", "aup",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docType: string }> },
) {
  const rid = requestId(req);
  const { docType } = await params;
  try {
    const ctx = await requireAdminSession(req, "owner");

    if (!VALID_DOC_TYPES.has(docType)) {
      return NextResponse.json({ error: "invalid_doc_type" }, { status: 400 });
    }

    const url = new URL(req.url);
    const jurisdiction = url.searchParams.get("jurisdiction") ?? "global";

    const doc = await getLegalDocument(docType as LegalDocType, jurisdiction);
    if (!doc) {
      return NextResponse.json({ error: "document_not_found" }, { status: 404 });
    }

    const body = await req.json();
    const parsed = VersionBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Create the draft version.
    const version = await createDraftVersion(
      doc.id,
      parsed.data.version,
      parsed.data.locale,
      parsed.data.body,
      parsed.data.changelog,
    );

    // Submit for review (draft → in_review + creates a legal_review entry).
    await submitForReview(version.id, ctx.adminId);

    const res = NextResponse.json(
      { versionId: version.id, status: "in_review" },
      { status: 201 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof LegalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/legal/${docType}/version`);
  }
}
