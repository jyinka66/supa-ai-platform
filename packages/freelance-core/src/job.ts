/**
 * @supa/freelance-core/job
 * ----------------------------------------------------------------
 * Freelance job entity — the anchor for the freelance management
 * module. Sits on top of the money spine (@supa/money) + CRM
 * (@supa/customers). A job is a piece of work with a budget,
 * a deadline, a client (reuses the customer record — CRM is
 * reuse, not rebuild), and a status lifecycle.
 *
 * The Money schema here is the WIRE format (Zod validates JSON,
 * which can't carry bigint). The domain layer converts to
 * @supa/money's bigint Money for arithmetic. Same rule, two
 * representations: Zod for validation at the API boundary,
 * bigint for exactness in the domain.
 *
 * Tenancy: wsId is non-nullable, no default — every row carries
 * workspace_id, enforced structurally (the lint rule + RLS + the
 * property test, same three gates as the rest of the system).
 * ----------------------------------------------------------------
 */

import { z } from "zod";

// ───────────────────────────────────────────────
// Enums — closed taxonomies
// ───────────────────────────────────────────────

export const Discipline = z.enum([
  "writing", "design", "development", "marketing", "video",
  "audio", "business", "translation", "data", "admin",
  "consulting", "education",
]);

export const JobSource = z.enum(["supa", "external"]);

export const ExternalPlatform = z.enum(["upwork", "fiverr", "direct", "other"]);

export const JobStatus = z.enum([
  "captured", "proposing", "active", "delivered", "paid", "closed",
]);

// ───────────────────────────────────────────────
// Money — wire format (Zod validates JSON; domain uses bigint)
// ───────────────────────────────────────────────

export const Money = z.object({
  amountMinor: z.number().int().nonnegative(), // minor units, integer, ≥ 0 — the money rule
  currency: z.string().length(3),              // ISO 4217, stored uppercase
});

// ───────────────────────────────────────────────
// FreelanceJob — the entity
// ───────────────────────────────────────────────

export const FreelanceJob = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),            // tenancy — row-level, non-nullable, no default
  source: JobSource,
  title: z.string().min(1).max(200),
  brief: z.string().max(50_000),      // block text — AI-summarizable, versioned via facts
  discipline: Discipline,
  skills: z.array(z.string().max(50)).max(30),
  budget: z.object({ value: Money, type: z.enum(["hourly", "fixed"]) }),
  deadline: z.string().datetime().optional(),
  status: JobStatus,
  clientRef: z.string().uuid(),       // a packages/customers record — CRM is reuse, not rebuild
  externalRef: z.object({
    platform: ExternalPlatform,
    url: z.string().url().optional(),
  }).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ───────────────────────────────────────────────
// Type exports — for use in domain code
// ───────────────────────────────────────────────

export type Discipline = z.infer<typeof Discipline>;
export type JobSource = z.infer<typeof JobSource>;
export type ExternalPlatform = z.infer<typeof ExternalPlatform>;
export type JobStatus = z.infer<typeof JobStatus>;
export type Money = z.infer<typeof Money>;
export type FreelanceJob = z.infer<typeof FreelanceJob>;

// ───────────────────────────────────────────────
// Status transitions — same discipline as invoices/expenses
// ───────────────────────────────────────────────

/**
 * Job status lifecycle:
 *   captured   → job entered into the system (from Supa marketplace or external)
 *   proposing  → a proposal is being drafted/sent
 *   active     → work in progress
 *   delivered  → work submitted to client
 *   paid       → payment received (writes a monetary fact)
 *   closed     → terminal (archived, rated, or abandoned)
 *
 * Transitions are one-way for money-relevant ones:
 *   captured → proposing → active → delivered → paid → closed
 *   Any status → closed (early close — abandoned, declined, etc.)
 *
 * Money facts: "paid" is the status that writes a monetary fact
 * (invoice-paid equivalent). The job's budget.value converts to
 * @supa/money's Money for arithmetic + report queries.
 */
const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  captured: ["proposing", "active", "closed"],
  proposing: ["active", "closed"],
  active: ["delivered", "closed"],
  delivered: ["paid", "closed"],
  paid: ["closed"],
  closed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidJobTransitionError extends Error {
  constructor(readonly from: JobStatus, readonly to: JobStatus) {
    super(`invalid job status transition: ${from} → ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

/**
 * Transition a job's status. Returns a new job with the updated status.
 * Throws InvalidJobTransitionError on invalid transition.
 *
 * The "paid" transition is the one that writes a monetary fact —
 * the caller (repository) writes the fact in the same DB transaction
 * as the status update, same discipline as invoicing.
 */
export function transitionStatus(
  job: FreelanceJob,
  to: JobStatus,
  now: string = new Date().toISOString(),
): FreelanceJob {
  if (!canTransition(job.status, to)) {
    throw new InvalidJobTransitionError(job.status, to);
  }
  return { ...job, status: to, updatedAt: now };
}

// ───────────────────────────────────────────────
// Wire → domain conversion (Money)
// ───────────────────────────────────────────────

import { fromMinor, asCurrency, type Money as DomainMoney } from "@supa/money/money";

/**
 * Convert the wire-format Money (Zod: number + string) to the
 * domain Money (bigint + branded Currency). Used when the job's
 * budget needs to participate in arithmetic (invoice conversion,
 * pipeline totals, report queries).
 */
export function toDomainMoney(wire: Money): DomainMoney {
  return fromMinor(BigInt(wire.amountMinor), asCurrency(wire.currency.toUpperCase()));
}

/**
 * Convert domain Money back to wire format (for API responses).
 */
export function toWireMoney(domain: DomainMoney): Money {
  return {
    amountMinor: Number(domain.minor),
    currency: domain.currency,
  };
}
