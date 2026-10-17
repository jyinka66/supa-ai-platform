import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordConsent, getConsent, withdrawConsent, isCategoryAllowed, JURISDICTION_MODEL, type ConsentJurisdiction, type ConsentCategory } from "@/lib/security/consent";
import { ip } from "@/lib/utils/ip";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConsentBody = z.object({
  sessionId: z.string().min(1),
  jurisdiction: z.enum(["gdpr", "ccpa", "lgpd", "dpdp", "popia", "pipl", "none"]),
  consentGiven: z.boolean(),
  consentCategories: z.array(z.enum(["necessary", "analytics", "marketing", "functional"])).default(["necessary"]),
});

const CheckBody = z.object({
  sessionId: z.string().min(1),
  category: z.enum(["necessary", "analytics", "marketing", "functional"]).optional(),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const body = await req.json();
    const parsed = ConsentBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request", detail: parsed.error.message }, { status: 400 });
    }

    const consent = await recordConsent({
      sessionId: parsed.data.sessionId,
      jurisdiction: parsed.data.jurisdiction as ConsentJurisdiction,
      consentGiven: parsed.data.consentGiven,
      consentCategories: parsed.data.consentCategories as ConsentCategory[],
      ip: ip(req),
      userAgent: req.headers.get("user-agent") ?? null,
    });

    const res = NextResponse.json(consent, { status: 201 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/consent");
  }
}

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const category = url.searchParams.get("category") as ConsentCategory | null;

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    const consent = await getConsent(sessionId);
    if (!consent) {
      return NextResponse.json({ hasConsent: false, allowed: false }, { status: 200 });
    }

    const allowed = category ? isCategoryAllowed(consent, category) : consent.consentGiven;
    const res = NextResponse.json({ hasConsent: true, consent, allowed }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/consent");
  }
}

export async function DELETE(req: NextRequest) {
  const rid = requestId(req);
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    await withdrawConsent(sessionId);
    const res = NextResponse.json({ ok: true, withdrawn: true }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/consent");
  }
}
