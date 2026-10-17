import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requestId, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { createTicket } from "@/lib/support/tickets";
import { triageTicket } from "@/lib/support/triage";
import { detectRegion } from "@/lib/regional/service";
import { ip } from "@/lib/utils/ip";

/**
 * POST /api/support/tickets
 *
 * Create a support ticket. Authenticated users only (the user's plan determines
 * the SLA). The ticket is auto-triaged by the AI triage service (category,
 * severity, suggested macro, auto-answer if possible).
 *
 * Body:
 *   {
 *     "subject": "How do I upgrade my plan?",
 *     "body": "I want to upgrade from Pro to Business...",
 *     "category"?: "billing",
 *     "severity"?: "normal"
 *   }
 *
 * Response 201: { ticketId, triage: { category, severity, autoAnswered, autoAnswer } }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TicketBody = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(10).max(10000),
  category: z.enum(["billing", "technical", "account", "feature", "bug", "other"]).optional(),
  severity: z.enum(["low", "normal", "high", "urgent", "critical"]).optional(),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);

    const body = await req.json();
    const parsed = TicketBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Detect the user's region from IP + Accept-Language.
    const userIp = ip(req);
    const acceptLanguage = req.headers.get("accept-language");
    const userRegion = detectRegion(userIp, acceptLanguage);

    // TODO: fetch the user's plan + email + locale from the DB.
    // For now, defaults.
    const userPlan = "free"; // would query from workspaces/memberships.
    const userEmail = "user@example.com"; // would query from auth.
    const userLocale = acceptLanguage?.split(",")[0]?.split("-")[0] ?? "en";

    // Create the ticket (computes SLA deadline from plan).
    const ticket = await createTicket({
      userId: uid,
      userEmail,
      userLocale,
      userPlan,
      userRegion,
      subject: parsed.data.subject,
      body: parsed.data.body,
      ...(parsed.data.category ? { category: parsed.data.category } : {}),
      ...(parsed.data.severity ? { severity: parsed.data.severity } : {}),
    });

    // Auto-triage the ticket.
    const triage = await triageTicket(ticket.subject, ticket.body, ticket.userLocale);

    const res = NextResponse.json(
      {
        ticketId: ticket.id,
        triage: {
          category: triage.category,
          severity: triage.severity,
          confidence: triage.confidence,
          autoAnswered: triage.autoAnswerable,
          autoAnswer: triage.autoAnswer,
          routing: triage.routing,
        },
      },
      { status: 201 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/support/tickets");
  }
}
