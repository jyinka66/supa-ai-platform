// PII redaction + support data access logging.
//
// The spec: "Support tickets handled securely, with PII redaction." +
// "Support access to user data logged and justified."
//
// Two concerns:
//   1. PII redaction — when support tickets are displayed in analytics/logs,
//      PII (email, phone, addresses) is redacted to prevent data leakage.
//   2. Access logging — every time a support agent accesses a user's ticket
//      (which contains PII), the access is logged with a mandatory justification.
//      This is the GDPR Art. 30 record-keeping requirement.

import { db } from "@supa/db";
import { piiRedactionLog } from "@supa/db/schema";
import { eq, desc } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type AccessType = "view" | "export" | "redact";

export interface PiiRedactionEntry {
  id: string;
  ticketId: string;
  accessedBy: string;
  accessType: AccessType;
  fieldsAccessed: string[];
  justification: string;
  ip: string;
  userAgent: string | null;
  createdAt: Date;
}

export class PiiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "PiiError";
  }
}

// ───────────────────────────────────────────────
// PII patterns — what to redact.
// ───────────────────────────────────────────────

/** Email regex (RFC 5322 simplified). */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Phone number regex (international + US formats). */
const PHONE_PATTERN = /(\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;

/** Credit card number regex (13-16 digits, with optional spaces/dashes). */
const CREDIT_CARD_PATTERN = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,4}\b/g;

/** SSN regex (US format: XXX-XX-XXXX). */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** IP address regex. */
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// ───────────────────────────────────────────────
// redactPii — redact PII from text.
// ───────────────────────────────────────────────

/**
 * Redact PII from a text string. Replaces emails, phone numbers, credit cards,
 * SSNs, and IP addresses with [REDACTED].
 *
 * Used when displaying ticket content in analytics, logs, or the admin dashboard
 * (where the agent doesn't need the raw PII).
 *
 * The redaction is reversible only via the access log — an agent with
 * justification can view the raw ticket (which is logged).
 *
 * @param text — the text to redact.
 * @param fields — which PII types to redact (default: all).
 */
export function redactPii(
  text: string,
  fields: Array<"email" | "phone" | "credit_card" | "ssn" | "ip"> = ["email", "phone", "credit_card", "ssn", "ip"],
): string {
  let result = text;

  // Order matters: redact credit cards BEFORE phones (the phone pattern is
  // greedy and would match parts of credit card numbers).
  if (fields.includes("credit_card")) {
    result = result.replace(CREDIT_CARD_PATTERN, "[CARD_REDACTED]");
  }
  if (fields.includes("email")) {
    result = result.replace(EMAIL_PATTERN, "[EMAIL_REDACTED]");
  }
  if (fields.includes("phone")) {
    result = result.replace(PHONE_PATTERN, "[PHONE_REDACTED]");
  }
  if (fields.includes("ssn")) {
    result = result.replace(SSN_PATTERN, "[SSN_REDACTED]");
  }
  if (fields.includes("ip")) {
    result = result.replace(IP_PATTERN, "[IP_REDACTED]");
  }

  return result;
}

/**
 * Redact all PII fields from a support ticket for display.
 * Returns a copy with the body + user_email + subject redacted.
 */
export function redactTicket(ticket: {
  subject: string;
  body: string;
  userEmail: string;
}): {
  subject: string;
  body: string;
  userEmail: string;
} {
  return {
    subject: redactPii(ticket.subject, ["email", "phone"]),
    body: redactPii(ticket.body),
    userEmail: redactPii(ticket.userEmail, ["email"]),
  };
}

// ───────────────────────────────────────────────
// logDataAccess — record a support agent's PII access.
// ───────────────────────────────────────────────

/**
 * Log a support agent's access to user PII. MANDATORY justification.
 *
 * The spec: "Support access to user data logged and justified."
 *
 * @throws PiiError(400) if justification is empty.
 */
export async function logDataAccess(input: {
  ticketId: string;
  accessedBy: string;
  accessType: AccessType;
  fieldsAccessed: string[];
  justification: string;
  ip: string;
  userAgent?: string;
}): Promise<PiiRedactionEntry> {
  if (!input.justification || input.justification.trim().length < 10) {
    throw new PiiError("justification_required_min_10_chars", 400);
  }

  const rows = await db
    .insert(piiRedactionLog)
    .values({
      ticketId: input.ticketId as any,
      accessedBy: input.accessedBy as any,
      accessType: input.accessType,
      fieldsAccessed: input.fieldsAccessed,
      justification: input.justification.trim(),
      ip: input.ip as any,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    })
    .returning({ id: piiRedactionLog.id, createdAt: piiRedactionLog.createdAt });

  const row = rows[0];
  if (!row) throw new PiiError("log_insert_failed", 500);

  return {
    id: row.id as string,
    ticketId: input.ticketId,
    accessedBy: input.accessedBy,
    accessType: input.accessType,
    fieldsAccessed: input.fieldsAccessed,
    justification: input.justification.trim(),
    ip: input.ip,
    userAgent: input.userAgent ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Get the access log for a ticket (for the compliance UI).
 */
export async function getAccessLog(ticketId: string): Promise<PiiRedactionEntry[]> {
  const rows = await db
    .select()
    .from(piiRedactionLog)
    .where(eq(piiRedactionLog.ticketId, ticketId as any))
    .orderBy(desc(piiRedactionLog.createdAt));

  return rows.map((row) => ({
    id: row.id as string,
    ticketId: row.ticketId as string,
    accessedBy: row.accessedBy as string,
    accessType: row.accessType as AccessType,
    fieldsAccessed: row.fieldsAccessed ?? [],
    justification: row.justification,
    ip: String(row.ip),
    userAgent: (row.userAgent as string | null) ?? null,
    createdAt: row.createdAt,
  }));
}
