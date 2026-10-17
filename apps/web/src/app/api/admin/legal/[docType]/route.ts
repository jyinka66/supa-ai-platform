import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getLegalDocument, getCurrentVersion, listVersions, LegalError } from "@/lib/legal/service";
import { db } from "@supa/db";
import { legalDocuments } from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import type { LegalDocType } from "@/lib/legal/service";

/**
 * GET /api/admin/legal/:docType
 *   Get a legal document + its current published version + version history.
 *
 * PATCH /api/admin/legal/:docType
 *   Update the document's title/description (owner-only).
 *
 * Auth: admin session with minRole="owner".
 *
 * Path param: docType (privacy/terms/cookies/dpa/refund/security/subprocessors/aup).
 * Query param: ?jurisdiction=global (default: global).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(1000).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: "empty_patch" });

const VALID_DOC_TYPES = new Set([
  "privacy", "terms", "cookies", "dpa",
  "refund", "security", "subprocessors", "aup",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ docType: string }> },
) {
  const rid = requestId(req);
  const { docType } = await params;
  try {
    await requireAdminSession(req, "owner");

    if (!VALID_DOC_TYPES.has(docType)) {
      return NextResponse.json({ error: "invalid_doc_type" }, { status: 400 });
    }

    const url = new URL(req.url);
    const jurisdiction = url.searchParams.get("jurisdiction") ?? "global";

    const doc = await getLegalDocument(docType as LegalDocType, jurisdiction);
    if (!doc) {
      return NextResponse.json({ error: "document_not_found" }, { status: 404 });
    }

    const versions = await listVersions(doc.id);
    const currentVersion = doc.currentVersionId
      ? await getCurrentVersion(doc.id, "en") // default locale
      : null;

    const res = NextResponse.json(
      {
        document: {
          id: doc.id,
          docType: doc.docType,
          jurisdiction: doc.jurisdiction,
          title: doc.title,
          description: doc.description,
          currentVersionId: doc.currentVersionId,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
        },
        currentVersion: currentVersion
          ? {
              id: currentVersion.id,
              version: currentVersion.version,
              locale: currentVersion.locale,
              status: currentVersion.status,
              effectiveDate: currentVersion.effectiveDate?.toISOString() ?? null,
              publishedAt: currentVersion.publishedAt?.toISOString() ?? null,
              body: currentVersion.body,
            }
          : null,
        versionHistory: versions.map((v) => ({
          id: v.id,
          version: v.version,
          locale: v.locale,
          status: v.status,
          changelog: v.changelog,
          publishedAt: v.publishedAt?.toISOString() ?? null,
          archivedAt: v.archivedAt?.toISOString() ?? null,
          createdAt: v.createdAt.toISOString(),
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
    return errorResponse(err, `/api/admin/legal/${docType}`);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docType: string }> },
) {
  const rid = requestId(req);
  const { docType } = await params;
  try {
    await requireAdminSession(req, "owner");

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
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    updates.updatedAt = new Date();

    await db
      .update(legalDocuments)
      .set(updates)
      .where(eq(legalDocuments.id, doc.id as any));

    const res = NextResponse.json({ ok: true }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof LegalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/legal/${docType}`);
  }
}
