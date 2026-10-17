import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { db } from "@supa/db";
import { legalDocuments } from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import type { LegalDocType } from "@/lib/legal/service";

/**
 * GET /api/admin/legal
 *
 * List all legal documents (owner-only). For the legal management UI —
 * shows the 8 doc types (privacy/terms/cookies/dpa/refund/security/
 * subprocessors/aup) + their current version + jurisdiction.
 *
 * Response 200:
 *   {
 *     "items": [
 *       {
 *         "id": "...",
 *         "docType": "privacy",
 *         "jurisdiction": "global",
 *         "title": "Privacy Policy",
 *         "currentVersionId": "...",
 *         "updatedAt": "..."
 *       }
 *     ]
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const rows = await db
      .select({
        id: legalDocuments.id,
        docType: legalDocuments.docType,
        jurisdiction: legalDocuments.jurisdiction,
        title: legalDocuments.title,
        description: legalDocuments.description,
        currentVersionId: legalDocuments.currentVersionId,
        updatedAt: legalDocuments.updatedAt,
        createdAt: legalDocuments.createdAt,
      })
      .from(legalDocuments)
      .orderBy(legalDocuments.docType);

    const res = NextResponse.json(
      {
        items: rows.map((r) => ({
          id: r.id as string,
          docType: r.docType as LegalDocType,
          jurisdiction: r.jurisdiction,
          title: r.title,
          description: r.description,
          currentVersionId: (r.currentVersionId as string | null) ?? null,
          updatedAt: r.updatedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/legal");
  }
}
