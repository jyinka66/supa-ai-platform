// AI triage — classify, route, auto-answer support requests.
//
// The spec: "AI triage — incoming requests classified, routed, and auto-answered
// where possible." + "AI first-response — common questions answered automatically,
// in the user's language." + "Macros — human agents use pre-written, localized
// responses for common issues."
//
// Flow:
//   1. triageTicket(subject, body, locale) — classifies the ticket:
//      - category: billing/technical/account/feature/bug/other.
//      - severity: low/normal/high/urgent/critical.
//      - confidence: 0.0-1.0.
//      - suggestedMacro: the best-matching macro key (for auto-answer).
//      - autoAnswerable: true if confidence > threshold + a macro matches.
//   2. If autoAnswerable: send the macro response as the first reply (no human needed).
//   3. If not: route to the appropriate queue (by category + severity).
//
// The triage uses keyword matching + a simple scoring heuristic. The real impl
// would use an LLM (the same provider infrastructure as chat) for classification.
// For now, the keyword approach is deterministic + testable.

import { db } from "@supa/db";
import { supportMacros } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { TicketCategory, TicketSeverity } from "./tickets";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface TriageResult {
  category: TicketCategory;
  severity: TicketSeverity;
  confidence: number; // 0.0 to 1.0.
  suggestedMacro: string | null; // the macro key.
  autoAnswerable: boolean;
  autoAnswer: string | null; // the macro body (if auto-answerable).
  routing: string; // the queue to route to.
}

export interface Macro {
  id: string;
  key: string;
  locale: string;
  title: string;
  body: string;
  category: string;
  active: boolean;
  usageCount: number;
  helpfulYes: number;
  helpfulNo: number;
}

// ───────────────────────────────────────────────
// Keyword-based classification.
// ───────────────────────────────────────────────

interface CategoryKeywords {
  category: TicketCategory;
  keywords: string[];
}

const CATEGORY_KEYWORDS: CategoryKeywords[] = [
  { category: "billing", keywords: ["invoice", "payment", "charge", "refund", "subscription", "billing", "price", "plan", "upgrade", "downgrade", "cancel"] },
  { category: "technical", keywords: ["error", "bug", "crash", "not working", "slow", "broken", "500", "404", "timeout", "api", "webhook", "integration"] },
  { category: "account", keywords: ["login", "password", "reset", "2fa", "mfa", "account", "sso", "saml", "access", "locked out", "verify"] },
  { category: "feature", keywords: ["how do i", "how to", "can i", "feature", "request", "wish", "would be nice", "ability to"] },
  { category: "bug", keywords: ["crash", "stack trace", "exception", "unexpected", "regression", "wrong", "incorrect", "data loss"] },
];

const SEVERITY_KEYWORDS: Array<{ severity: TicketSeverity; keywords: string[] }> = [
  { severity: "critical", keywords: ["urgent", "critical", "emergency", "down", "outage", "data loss", "security", "breach"] },
  { severity: "urgent", keywords: ["asap", "immediately", "blocking", "can't work", "production", "live"] },
  { severity: "high", keywords: ["important", "serious", "broken", "not working", "failing"] },
];

// ───────────────────────────────────────────────
// triageTicket — classify + route + suggest macro.
// ───────────────────────────────────────────────

/**
 * Triage a support ticket. Classifies by category + severity, suggests a macro,
 * and determines if the ticket can be auto-answered.
 *
 * @param subject — the ticket subject.
 * @param body — the ticket body.
 * @param locale — the user's locale (for localized macros).
 *
 * @returns TriageResult with category, severity, confidence, suggestedMacro,
 *          autoAnswerable, autoAnswer (the macro body), and routing (the queue).
 */
export async function triageTicket(
  subject: string,
  body: string,
  locale: string,
): Promise<TriageResult> {
  const text = `${subject} ${body}`.toLowerCase();

  // 1. Classify category (highest keyword match count wins).
  let bestCategory: TicketCategory = "other";
  let bestCategoryScore = 0;
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    const score = keywords.filter((kw) => text.includes(kw)).length;
    if (score > bestCategoryScore) {
      bestCategoryScore = score;
      bestCategory = category;
    }
  }

  // 2. Classify severity (highest keyword match wins).
  let severity: TicketSeverity = "normal";
  for (const { severity: sev, keywords } of SEVERITY_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) {
      severity = sev;
      break; // first match wins (the list is ordered by severity).
    }
  }

  // 3. Confidence — based on how many keywords matched.
  const confidence = Math.min(1, bestCategoryScore / 3); // 3+ keyword matches = 100% confidence.

  // 4. Find the best macro for this category + locale.
  const macro = await findMacro(bestCategory, locale);

  // 5. Auto-answerable if confidence > 0.5 + a macro exists.
  const autoAnswerable = confidence > 0.5 && macro !== null;

  // 6. Routing — by category + severity.
  const routing = routeTicket(bestCategory, severity);

  return {
    category: bestCategory,
    severity,
    confidence,
    suggestedMacro: macro?.key ?? null,
    autoAnswerable,
    autoAnswer: autoAnswerable ? macro?.body ?? null : null,
    routing,
  };
}

// ───────────────────────────────────────────────
// findMacro — find the best macro for a category + locale.
// ───────────────────────────────────────────────

async function findMacro(category: TicketCategory, locale: string): Promise<Macro | null> {
  const rows = await db
    .select({
      id: supportMacros.id,
      key: supportMacros.key,
      locale: supportMacros.locale,
      title: supportMacros.title,
      body: supportMacros.body,
      category: supportMacros.category,
      active: supportMacros.active,
      usageCount: supportMacros.usageCount,
      helpfulYes: supportMacros.helpfulYes,
      helpfulNo: supportMacros.helpfulNo,
    })
    .from(supportMacros)
    .where(
      and(
        eq(supportMacros.category, category),
        eq(supportMacros.locale, locale),
        eq(supportMacros.active, true),
      ),
    )
    .orderBy(sql`${supportMacros.helpfulYes} desc, ${supportMacros.usageCount} desc`)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    key: row.key,
    locale: row.locale,
    title: row.title,
    body: row.body,
    category: row.category,
    active: row.active,
    usageCount: row.usageCount,
    helpfulYes: row.helpfulYes,
    helpfulNo: row.helpfulNo,
  };
}

// ───────────────────────────────────────────────
// routeTicket — determine the queue.
// ───────────────────────────────────────────────

function routeTicket(category: TicketCategory, severity: TicketSeverity): string {
  // Critical/urgent → immediate queue (regardless of category).
  if (severity === "critical" || severity === "urgent") {
    return "priority";
  }

  // By category.
  switch (category) {
    case "billing": return "billing";
    case "technical": return "technical";
    case "account": return "account";
    case "bug": return "engineering";
    case "feature": return "product";
    default: return "general";
  }
}

// ───────────────────────────────────────────────
// incrementMacroUsage — track macro effectiveness.
// ───────────────────────────────────────────────

export async function incrementMacroUsage(macroId: string, helpful: boolean): Promise<void> {
  if (helpful) {
    await db
      .update(supportMacros)
      .set({ usageCount: sql`${supportMacros.usageCount} + 1`, helpfulYes: sql`${supportMacros.helpfulYes} + 1` })
      .where(eq(supportMacros.id, macroId as any));
  } else {
    await db
      .update(supportMacros)
      .set({ usageCount: sql`${supportMacros.usageCount} + 1`, helpfulNo: sql`${supportMacros.helpfulNo} + 1` })
      .where(eq(supportMacros.id, macroId as any));
  }
}
