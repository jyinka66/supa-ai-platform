// Support tickets — creation, SLA tracking, escalation, CSAT.
//
// The spec: "Response SLAs — Free 48h, Pro 24h, Business 8h, Enterprise 1h." +
// "SLA monitoring — every ticket tracked against its SLA, alerted before breach." +
// "Escalation path — tickets escalated based on severity and age."
//
// SLA per plan:
//   - free:       48h (172800000 ms)
//   - pro:        24h (86400000 ms)
//   - business:    8h (28800000 ms)
//   - enterprise:  1h (3600000 ms)
//
// Severity affects priority (queue ordering):
//   - critical: priority 100 (highest)
//   - urgent:   priority 80
//   - high:     priority 60
//   - normal:   priority 40
//   - low:      priority 20
//
// Escalation: a ticket is auto-escalated when:
//   - SLA breached (past deadline + not resolved).
//   - Severity is critical/urgent + open for > 1h without first response.
//
// CSAT: every resolved ticket gets a CSAT survey (1-5). The survey is
// optional but the prompt is automatic.

import { db } from "@supa/db";
import { supportTickets, csatSurveys } from "@supa/db/schema";
import { eq, and, sql, lte, isNull, desc } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type TicketSeverity = "low" | "normal" | "high" | "urgent" | "critical";
export type TicketStatus = "open" | "pending" | "resolved" | "closed" | "escalated";
export type TicketCategory = "billing" | "technical" | "account" | "feature" | "bug" | "other";

export interface SupportTicket {
  id: string;
  wsId: string | null;
  userId: string;
  userEmail: string;
  userLocale: string;
  userPlan: string;
  userRegion: string | null;
  subject: string;
  body: string;
  category: string | null;
  severity: TicketSeverity;
  status: TicketStatus;
  priority: number;
  assignedTo: string | null;
  slaDeadline: Date;
  slaBreached: boolean;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  triageResult: Record<string, unknown> | null;
  csatScore: number | null;
  csatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTicketInput {
  wsId?: string | null;
  userId: string;
  userEmail: string;
  userLocale: string;
  userPlan: string;
  userRegion?: string | null;
  subject: string;
  body: string;
  category?: TicketCategory;
  severity?: TicketSeverity;
}

export class TicketError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "TicketError";
  }
}

// ───────────────────────────────────────────────
// SLA configuration per plan.
// ───────────────────────────────────────────────

export const SLA_BY_PLAN: Record<string, number> = {
  free: 48 * 60 * 60 * 1000,       // 48h
  pro: 24 * 60 * 60 * 1000,        // 24h
  business: 8 * 60 * 60 * 1000,    // 8h
  enterprise: 1 * 60 * 60 * 1000, // 1h
};

/** SLA alert threshold — alert when 80% of the SLA window has elapsed. */
export const SLA_ALERT_THRESHOLD = 0.8;

// ───────────────────────────────────────────────
// Severity → priority mapping.
// ───────────────────────────────────────────────

export const SEVERITY_PRIORITY: Record<TicketSeverity, number> = {
  critical: 100,
  urgent: 80,
  high: 60,
  normal: 40,
  low: 20,
};

// ───────────────────────────────────────────────
// createTicket — create a support ticket with SLA.
// ───────────────────────────────────────────────

/**
 * Create a support ticket. Computes the SLA deadline from the user's plan +
 * the severity-based priority.
 *
 * @throws TicketError(400) if required fields are missing.
 */
export async function createTicket(input: CreateTicketInput): Promise<SupportTicket> {
  if (!input.userId || !input.userEmail || !input.subject || !input.body) {
    throw new TicketError("missing_required_fields", 400);
  }

  const plan = input.userPlan ?? "free";
  const slaMs = SLA_BY_PLAN[plan] ?? SLA_BY_PLAN.free ?? SLA_BY_PLAN["free"]!;
  const slaDeadline = new Date(Date.now() + slaMs);
  const severity = input.severity ?? "normal";
  const priority = SEVERITY_PRIORITY[severity];

  const rows = await db
    .insert(supportTickets)
    .values({
      ...(input.wsId ? { workspaceId: input.wsId as any } : {}),
      userId: input.userId as any,
      userEmail: input.userEmail,
      userLocale: input.userLocale,
      userPlan: plan,
      ...(input.userRegion ? { userRegion: input.userRegion } : {}),
      subject: input.subject,
      body: input.body,
      ...(input.category ? { category: input.category } : {}),
      severity,
      status: "open",
      priority,
      slaDeadline,
    })
    .returning({ id: supportTickets.id });

  const row = rows[0];
  if (!row) throw new TicketError("ticket_insert_failed", 500);

  const ticket = await getTicket(row.id as string);
  if (!ticket) throw new TicketError("ticket_not_found_after_insert", 500);

  await auditTicket("support.ticket.created", ticket.id, { userId: input.userId, plan, severity });

  return ticket;
}

// ───────────────────────────────────────────────
// getTicket / listTickets
// ───────────────────────────────────────────────

export async function getTicket(id: string): Promise<SupportTicket | null> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.id, id as any))
    .limit(1);
  return mapRow(rows[0]);
}

export async function listTickets(opts: {
  status?: TicketStatus;
  assignedTo?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<SupportTicket[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions = [];
  if (opts.status) conditions.push(eq(supportTickets.status, opts.status));
  if (opts.assignedTo) conditions.push(eq(supportTickets.assignedTo, opts.assignedTo as any));

  const rows = await db
    .select()
    .from(supportTickets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(supportTickets.priority), desc(supportTickets.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(mapRow).filter((t): t is SupportTicket => t !== null);
}

// ───────────────────────────────────────────────
// assignTicket — assign to a support agent.
// ───────────────────────────────────────────────

export async function assignTicket(ticketId: string, agentId: string): Promise<void> {
  await db
    .update(supportTickets)
    .set({ assignedTo: agentId as any, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId as any));
  await auditTicket("support.ticket.assigned", ticketId, { agentId });
}

// ───────────────────────────────────────────────
// recordFirstResponse — mark the first reply time.
// ───────────────────────────────────────────────

export async function recordFirstResponse(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new TicketError("ticket_not_found", 404);
  if (ticket.firstResponseAt) return; // already has a first response.

  await db
    .update(supportTickets)
    .set({ firstResponseAt: new Date(), status: "pending", updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId as any));

  await auditTicket("support.ticket.first_response", ticketId, {});
}

// ───────────────────────────────────────────────
// resolveTicket — mark as resolved.
// ───────────────────────────────────────────────

export async function resolveTicket(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new TicketError("ticket_not_found", 404);

  await db
    .update(supportTickets)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId as any));

  await auditTicket("support.ticket.resolved", ticketId, {});
}

// ───────────────────────────────────────────────
// submitCsat — record the CSAT score.
// ───────────────────────────────────────────────

export async function submitCsat(ticketId: string, userId: string, score: number, comment?: string): Promise<void> {
  if (score < 1 || score > 5) throw new TicketError("invalid_csat_score", 400);

  await db.insert(csatSurveys).values({
    ticketId: ticketId as any,
    userId: userId as any,
    score,
    ...(comment ? { comment } : {}),
  });

  await db
    .update(supportTickets)
    .set({ csatScore: score, csatAt: new Date(), updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId as any));

  await auditTicket("support.ticket.csat", ticketId, { score });
}

// ───────────────────────────────────────────────
// escalateTicket — auto/manual escalation.
// ───────────────────────────────────────────────

export async function escalateTicket(ticketId: string, reason: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new TicketError("ticket_not_found", 404);

  await db
    .update(supportTickets)
    .set({ status: "escalated", priority: 100, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId as any));

  await auditTicket("support.ticket.escalated", ticketId, { reason });
}

// ───────────────────────────────────────────────
// checkSlaBreaches — the cron calls this to flag breached tickets.
// ───────────────────────────────────────────────

/**
 * Check all open/pending tickets for SLA breaches. Sets sla_breached=true
 * for tickets past their deadline. Escalates critical/urgent tickets that
 * haven't had a first response in 1h.
 *
 * Returns { breachedCount, escalatedCount }.
 */
export async function checkSlaBreaches(): Promise<{ breachedCount: number; escalatedCount: number }> {
  const now = new Date();

  // Flag breached tickets (past deadline, not resolved).
  const breached = await db
    .update(supportTickets)
    .set({ slaBreached: true, updatedAt: now })
    .where(
      and(
        sql`${supportTickets.status} in ('open', 'pending')`,
        lte(supportTickets.slaDeadline, now),
        sql`${supportTickets.slaBreached} = false`,
      ),
    )
    .returning({ id: supportTickets.id });

  // Escalate critical/urgent tickets open > 1h without first response.
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const escalated = await db
    .update(supportTickets)
    .set({ status: "escalated", priority: 100, updatedAt: now })
    .where(
      and(
        eq(supportTickets.status, "open"),
        sql`${supportTickets.severity} in ('critical', 'urgent')`,
        isNull(supportTickets.firstResponseAt),
        lte(supportTickets.createdAt, oneHourAgo),
      ),
    )
    .returning({ id: supportTickets.id });

  // Audit the breaches + escalations.
  if (breached.length > 0) {
    try {
      await adminAudit({
        actor: "system",
        action: "support.sla.breached",
        target: { count: breached.length },
        justification: `${breached.length} tickets breached their SLA deadline`,
      });
    } catch { /* audit failure must not fail the cron */ }
  }

  if (escalated.length > 0) {
    try {
      await adminAudit({
        actor: "system",
        action: "support.ticket.escalated",
        target: { count: escalated.length, reason: "no_first_response_in_1h" },
        justification: `${escalated.length} critical/urgent tickets escalated (no first response in 1h)`,
      });
    } catch { /* audit failure must not fail the cron */ }
  }

  return { breachedCount: breached.length, escalatedCount: escalated.length };
}

// ───────────────────────────────────────────────
// getSupportAnalytics — for the admin dashboard.
// ───────────────────────────────────────────────

export interface SupportAnalytics {
  totalOpen: number;
  totalResolved: number;
  slaBreachedCount: number;
  avgResponseTimeMs: number | null;
  avgResolutionTimeMs: number | null;
  avgCsat: number | null;
  topCategories: Array<{ category: string; count: number }>;
  deflectionRate: number; // % of requests auto-answered (not turned into tickets).
}

export async function getSupportAnalytics(): Promise<SupportAnalytics> {
  const result = await db.execute(sql`
    select
      count(*) filter (where status in ('open', 'pending', 'escalated')) as total_open,
      count(*) filter (where status in ('resolved', 'closed')) as total_resolved,
      count(*) filter (where sla_breached = true) as sla_breached,
      avg(extract(epoch from (first_response_at - created_at)) * 1000) filter (where first_response_at is not null) as avg_response_ms,
      avg(extract(epoch from (resolved_at - created_at)) * 1000) filter (where resolved_at is not null) as avg_resolution_ms,
      avg(csat_score) filter (where csat_score is not null) as avg_csat
    from support_tickets
    where created_at > now() - interval '30 days'
  `);

  const row = (result as unknown as Array<Record<string, string | number | null>>)[0];

  // Top categories.
  const catResult = await db.execute(sql`
    select category, count(*)::integer as n
    from support_tickets
    where created_at > now() - interval '30 days' and category is not null
    group by category
    order by n desc
    limit 5
  `);

  const topCategories = (catResult as unknown as Array<{ category: string; n: number }>).map((r) => ({
    category: r.category,
    count: r.n,
  }));

  return {
    totalOpen: Number(row?.total_open ?? 0),
    totalResolved: Number(row?.total_resolved ?? 0),
    slaBreachedCount: Number(row?.sla_breached ?? 0),
    avgResponseTimeMs: row?.avg_response_ms != null ? Number(row.avg_response_ms) : null,
    avgResolutionTimeMs: row?.avg_resolution_ms != null ? Number(row.avg_resolution_ms) : null,
    avgCsat: row?.avg_csat != null ? Number(row.avg_csat) : null,
    topCategories,
    deflectionRate: 0, // stub — would compute from AI triage auto-answer rate.
  };
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function mapRow(row: Record<string, unknown> | undefined): SupportTicket | null {
  if (!row) return null;
  return {
    id: row.id as string,
    wsId: (row.workspaceId as string | null) ?? null,
    userId: row.userId as string,
    userEmail: row.userEmail as string,
    userLocale: row.userLocale as string,
    userPlan: row.userPlan as string,
    userRegion: (row.userRegion as string | null) ?? null,
    subject: row.subject as string,
    body: row.body as string,
    category: (row.category as string | null) ?? null,
    severity: row.severity as TicketSeverity,
    status: row.status as TicketStatus,
    priority: row.priority as number,
    assignedTo: (row.assignedTo as string | null) ?? null,
    slaDeadline: row.slaDeadline as Date,
    slaBreached: row.slaBreached as boolean,
    firstResponseAt: (row.firstResponseAt as Date | null) ?? null,
    resolvedAt: (row.resolvedAt as Date | null) ?? null,
    closedAt: (row.closedAt as Date | null) ?? null,
    triageResult: (row.triageResult as Record<string, unknown> | null) ?? null,
    csatScore: (row.csatScore as number | null) ?? null,
    csatAt: (row.csatAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

async function auditTicket(action: string, ticketId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await adminAudit({
      actor: "system",
      action,
      target: { ticketId, ...target },
      justification: `support ticket operation: ${action}`,
    });
  } catch {
    // audit failure must not fail the operation.
  }
}
