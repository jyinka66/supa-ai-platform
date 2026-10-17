import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import {
  getLegalDocument,
  getVersion,
  approveVersion,
  LegalError,
} from "@/lib/legal/service";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import type { LegalDocType } from "@/lib/legal/service";

/**
 * POST /api/admin/legal/:docType/approve
 *
 * Approve a legal document version (in_review → published).
 *
 * The approval flow:
 *   1. approveVersion(versionId, reviewerId) — archives the previous published
 *      version, publishes the new version, updates current_version_id, resolves
 *      the legal_review entry.
 *
 * The reviewer must be a different owner than the requester (two-person rule —
 * same as the kill_switch confirmation). For now, the route just requires
 * owner — the two-person check would be added if legal changes are classified
 * as high-risk (like kill_switches).
 *
 * Auth: admin session with minRole="owner".
 *
 * Body:
 *   {
 *     "versionId": "..."  // the legal_versions.id to approve.
 *   }
 *
 * Response 200:
 *   {
 *     "versionId": "...",
 *     "status": "published",
 *     "publishedAt": "...",
 *     "effectiveDate": "..."
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ApproveBody = z.object({
  versionId: z.string().uuid(),
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

    const body = await req.json();
    const parsed = ApproveBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Verify the version exists + belongs to this doc type.
    const version = await getVersion(parsed.data.versionId);
    if (!version) {
      return NextResponse.json({ error: "version_not_found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const jurisdiction = url.searchParams.get("jurisdiction") ?? "global";
    const doc = await getLegalDocument(docType as LegalDocType, jurisdiction);
    if (!doc || doc.id !== version.documentId) {
      return NextResponse.json({ error: "version_doc_mismatch" }, { status: 400 });
    }

    // Approve the version (archives the previous, publishes the new).
    const approved = await approveVersion(version.id, ctx.adminId);

    const res = NextResponse.json(
      {
        versionId: approved.id,
        status: approved.status,
        publishedAt: approved.publishedAt?.toISOString() ?? null,
        effectiveDate: approved.effectiveDate?.toISOString() ?? null,
      },
      { status: 200 },
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
    return errorResponse(err, `/api/admin/legal/${docType}/approve`);
  }
}
