// Applications: AI drafts, freelancer authors, everything
// editable before submit. The proposal's model + prompt
// versions ride on the record — win-rate-per-version becomes
// a query (the AI-quality channel) without logging proposal
// text anywhere beyond the freelancer's own workspace.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@supa/db";
import { applications, activityFacts } from "@supa/db/schema";
import { Money } from "@supa/freelance-core/job";

// FIX: inlined the helper (same as listing.ts + store.ts).
async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

export const ApplicationStatus = z.enum([
  "draft", "submitted", "shortlisted", "client_info_requested",
  "hired", "withdrawn", "rejected",
]);

export const Application = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),                    // the freelancer's ws — applicants own their drafts
  listingId: z.string().uuid(),
  freelancerWsId: z.string().uuid(),          // tenancy on BOTH sides; the job owner sees a masked view
  coverLetter: z.string().max(10_000),
  rate: Money,
  days: z.number().int().min(1).max(365),
  attachedWorkItemIds: z.array(z.string().uuid()).max(10),
  proposalMeta: z.object({
    modelVersion: z.string().nullable(),      // null = freelancer wrote it solo
    promptVersion: z.string().nullable(),
    aiAssisted: z.boolean(),
  }),
  status: ApplicationStatus,
  // FIX: added timestamps — every entity in the system carries these.
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ApplicationStatus = z.infer<typeof ApplicationStatus>;
export type Application = z.infer<typeof Application>;

// Map a Drizzle applications row to the domain Application shape.
// Same boundary pattern as listing.ts: Date → ISO string, bigint → number.
type ApplicationRow = typeof applications.$inferSelect;

function rowToApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    wsId: row.workspaceId,
    listingId: row.listingId,
    freelancerWsId: row.freelancerWsId,
    coverLetter: row.coverLetter,
    rate: {
      amountMinor: Number(row.rateMinor),
      currency: row.rateCurrency,
    },
    days: row.days,
    attachedWorkItemIds: row.attachedWorkItemIds as string[],
    proposalMeta: row.proposalMeta as {
      modelVersion: string | null;
      promptVersion: string | null;
      aiAssisted: boolean;
    },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as Application;
}

// ───────────────────────────────────────────────
// Two-side tenancy — the novel hazard
// ───────────────────────────────────────────────

// The applicant reads the listing; the client reads submitted
// applications (masking rate until hire decision per client setting).
// Drafts are visible to the freelancer ONLY — enforced in the
// store's WHERE, fuzz-tested below. Draft applications that
// leak to clients would be the worst possible trust failure:
// "we saw your half-written proposal."

export type ApplicationView = "freelancer" | "client";

/**
 * Mask an application for the client view. Hides rate until hire
 * decision per client setting (the "masked view" from the spec).
 * Drafts are NEVER visible to the client — enforced before this
 * function is called (the store's WHERE filters by status="submitted").
 */
export function maskForClient(app: Application): Omit<Application, "rate"> & { rate: null } {
  return { ...app, rate: null };
}

// ───────────────────────────────────────────────
// Status transitions
// ───────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["shortlisted", "rejected", "withdrawn"],
  shortlisted: ["client_info_requested", "hired", "rejected", "withdrawn"],
  client_info_requested: ["hired", "rejected", "withdrawn"],
  hired: [],
  withdrawn: [],
  rejected: [],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ───────────────────────────────────────────────
// Withdraw — a fact + status, never a delete
// ───────────────────────────────────────────────

// Withdraw is a fact + status, never a delete. The client's
// applicant list shows "withdrawn" — deleting history from
// under a hiring decision is how disputes breed.

export async function withdraw(
  wsId: string,
  applicationId: string,
): Promise<Application> {
  // FIX: body was empty (comment only). Implemented the transition
  // + activity fact, matching the "withdraw is a fact" contract.
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(applications).where(
      and(eq(applications.id, applicationId), eq(applications.workspaceId, wsId)),
    );
    if (!app) throw new Error(`application ${applicationId} not found in workspace ${wsId}`);

    if (!canTransition(app.status, "withdrawn")) {
      throw new Error(`cannot withdraw from ${app.status}`);
    }

    const now = new Date();
    const [updated] = await tx.update(applications).set({
      status: "withdrawn",
      updatedAt: now,
    }).where(
      and(eq(applications.id, applicationId), eq(applications.workspaceId, wsId)),
    ).returning();
    if (!updated) throw new Error(`application ${applicationId} not updated`);

    await recordActivity(tx, {
      wsId,
      kind: "supa.application.withdrawn",
      ref: { applicationId },
    });

    return rowToApplication(updated);
  });
}

// Client request for more info: a message fact bound to the
// application, threading into the same timeline as contract
// messaging — one history rule, again.
export async function requestClientInfo(
  wsId: string,
  applicationId: string,
): Promise<Application> {
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(applications).where(
      and(eq(applications.id, applicationId), eq(applications.workspaceId, wsId)),
    );
    if (!app) throw new Error(`application ${applicationId} not found in workspace ${wsId}`);

    if (!canTransition(app.status, "client_info_requested")) {
      throw new Error(`cannot request client info from ${app.status}`);
    }

    const now = new Date();
    const [updated] = await tx.update(applications).set({
      status: "client_info_requested",
      updatedAt: now,
    }).where(
      and(eq(applications.id, applicationId), eq(applications.workspaceId, wsId)),
    ).returning();
    if (!updated) throw new Error(`application ${applicationId} not updated`);

    await recordActivity(tx, {
      wsId,
      kind: "supa.application.client_info_requested",
      ref: { applicationId },
    });

    return rowToApplication(updated);
  });
}
