// The heart of sprint 2. Contract with milestones, driven to
// completion with ZERO money involved — "released" here means
// "client approved, payout pending" (a sprint-3 shim). If this
// machine is correct broke, it's correct rich.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@supa/db";
import { contracts, milestones, activityFacts } from "@supa/db/schema";
import { Money } from "@supa/freelance-core/job";

// FIX: "@supa/activities" doesn't exist — inlined helper (same pattern
// as store.ts, listing.ts, application.ts).
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

// ───────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────

export const MilestoneStatus = z.enum([
  "pending",        // not yet active
  "active",         // freelancer working
  "submitted",      // note + attachments, awaiting client
  "changes_requested",
  "approved",       // → payment_pending (sprint 3 fills this)
  "paid",
]);

export const ContractStatus = z.enum([
  "draft", "active", "completed", "disputed", "cancelled",
]);

// ───────────────────────────────────────────────
// Milestone + Contract schemas
// ───────────────────────────────────────────────

export const Milestone = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid(),
  title: z.string().min(1).max(200),
  amount: Money,                 // minor units, integer — the money rule
  status: MilestoneStatus,
  // FIX: submission was used in the patch but not in the schema. Added it.
  submission: z.object({
    note: z.string().max(10_000),
    attachments: z.array(z.string().uuid()).max(20),
    at: z.string().datetime(),
  }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const Contract = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),              // the freelancer's ws (applicant owns the contract)
  clientWsId: z.string().uuid(),        // the client's ws — two-side tenancy
  listingId: z.string().uuid().nullable(),
  applicationId: z.string().uuid().nullable(),
  jobId: z.string().uuid(),
  title: z.string().min(1).max(200),
  totalAmount: Money,                   // = sum of milestone amounts (enforced at create)
  status: ContractStatus,
  milestones: z.array(Milestone),       // ≥1 milestone required at hire
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MilestoneStatus = z.infer<typeof MilestoneStatus>;
export type ContractStatus = z.infer<typeof ContractStatus>;
export type Milestone = z.infer<typeof Milestone>;
export type Contract = z.infer<typeof Contract>;

// ───────────────────────────────────────────────
// Row → domain mappers
// ───────────────────────────────────────────────
// The DB stores timestamps as Date and money as bigint; the
// wire/domain layer uses ISO strings + numbers (JSON can't carry
// bigint, so the boundary is here, not in callers).

type ContractRow = typeof contracts.$inferSelect;
type MilestoneRow = typeof milestones.$inferSelect;

function rowToMilestone(row: MilestoneRow): Milestone {
  const submission = row.submissionNote !== null
    ? {
      note: row.submissionNote,
      attachments: (row.submissionAttachments ?? []) as string[],
      at: row.submittedAt ? row.submittedAt.toISOString() : new Date().toISOString(),
    }
    : null;
  return {
    id: row.id,
    contractId: row.contractId,
    title: row.title,
    amount: {
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
    },
    status: row.status,
    submission,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as Milestone;
}

// ───────────────────────────────────────────────
// LEGAL MILESTONE TRANSITIONS — exhaustive, total, the kind of
// map that makes illegal states unrepresentable
// ───────────────────────────────────────────────

const LEGAL: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  pending:            ["active"],
  active:             ["submitted"],
  submitted:          ["approved", "changes_requested"],
  changes_requested:  ["submitted"],        // resubmit, with the request note attached as a fact
  approved:           ["paid"],             // sprint 3: paid = escrow release fact
  paid:               [],
};

export function canTransitionMilestone(from: MilestoneStatus, to: MilestoneStatus): boolean {
  return LEGAL[from].includes(to);
}

// FIX: assertTransition was referenced but not defined. Implemented.
export function assertTransition(from: MilestoneStatus, to: MilestoneStatus): void {
  if (!canTransitionMilestone(from, to)) {
    throw new Error(`illegal milestone transition: ${from} → ${to}`);
  }
}

// ───────────────────────────────────────────────
// Contract-level rules the machine enforces
// ───────────────────────────────────────────────
//
//   • hire requires ≥1 milestone; milestone amounts must sum
//     to contract total (integer minor units; the sum rule is
//     the money-integrity rule arriving early)
//   • only ONE milestone active OR changes_requested at a time
//     per contract — sequential by design at launch ("lite")
//   • dispute: only from active/submitted/changes_requested;
//     freezes the milestone, opens a case, all parties notified;
//     resolution is a final fact, then the milestone resumes
//     or the contract cancels — decided by admin mediation,
//     not by either party's client code
//   • cancel: only in draft/active with zero approved
//     milestones; anything past that needs the dispute path.
//     A cancel button that works after approval is a theft button.

const LEGAL_CONTRACT: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["completed", "disputed", "cancelled"],
  completed: [],
  disputed: ["active", "cancelled"],  // resolution: resume or cancel
  cancelled: [],
};

export function canTransitionContract(from: ContractStatus, to: ContractStatus): boolean {
  return LEGAL_CONTRACT[from].includes(to);
}

/**
 * Assert that cancel is only allowed in draft/active with zero
 * approved milestones. A cancel button that works after approval
 * is a theft button.
 */
export function assertCanCancel(contract: Contract): void {
  if (contract.status !== "draft" && contract.status !== "active") {
    throw new Error(`cannot cancel contract in status ${contract.status}`);
  }
  const hasApproved = contract.milestones.some(
    (m) => m.status === "approved" || m.status === "paid",
  );
  if (hasApproved) {
    throw new Error("cannot cancel contract with approved/paid milestones — use dispute path");
  }
}

/**
 * Assert that only ONE milestone is active OR changes_requested
 * at a time per contract — sequential by design at launch.
 */
export function assertOneActiveMilestone(contract: Contract): void {
  const activeOrChanges = contract.milestones.filter(
    (m) => m.status === "active" || m.status === "changes_requested",
  );
  if (activeOrChanges.length > 1) {
    throw new Error(
      `contract has ${activeOrChanges.length} milestones in active/changes_requested — only one allowed at a time`,
    );
  }
}

/**
 * Assert that milestone amounts sum to contract total (the
 * money-integrity rule arriving early).
 */
export function assertMilestoneSum(contract: Contract): void {
  const sum = contract.milestones.reduce(
    (acc, m) => acc + m.amount.amountMinor,
    0,
  );
  if (sum !== contract.totalAmount.amountMinor) {
    throw new Error(
      `milestone amounts (${sum}) do not sum to contract total (${contract.totalAmount.amountMinor})`,
    );
  }
}

// ───────────────────────────────────────────────
// submitMilestone — the state machine in action
// ───────────────────────────────────────────────

// FIX: now() was used but not defined.
function now(): string {
  return new Date().toISOString();
}

export async function submitMilestone(
  wsId: string, contractId: string, milestoneId: string,
  input: { note: string; attachmentIds: string[] },
): Promise<Milestone> {
  return db.transaction(async (tx) => {
    // Both parties' workspaces touch this contract — the lock + scoped
    // WHERE means a third wsId simply finds no row.
    const [c] = await tx.select().from(contracts).where(
      and(
        eq(contracts.id, contractId),
        // The freelancer owns the contract (workspaceId) — submit is
        // their action. The client could be authorized via clientWsId
        // in a richer handler; for the submit path, freelancer scope.
        eq(contracts.workspaceId, wsId),
      ),
    );
    if (!c) throw new Error(`contract ${contractId} not found in workspace ${wsId}`);

    const [m] = await tx.select().from(milestones).where(
      and(eq(milestones.id, milestoneId), eq(milestones.contractId, contractId)),
    );
    if (!m) throw new Error(`milestone ${milestoneId} not found in contract ${contractId}`);

    assertTransition(m.status, "submitted");

    const now = new Date();
    const [updated] = await tx.update(milestones).set({
      status: "submitted",
      submissionNote: input.note,
      submissionAttachments: input.attachmentIds,
      submittedAt: now,
      updatedAt: now,
    }).where(eq(milestones.id, milestoneId)).returning();
    if (!updated) throw new Error(`milestone ${milestoneId} not updated`);

    await recordActivity(tx, {
      wsId,
      kind: "supa.milestone.submitted",
      ref: { contractId, milestoneId },
    });

    return rowToMilestone(updated);
  });
}

// ───────────────────────────────────────────────
// Progress bar: derived, never stored
// ───────────────────────────────────────────────

// Progress bar: derived, never stored. computed from milestone
// states at read time — a stored progress integer is the kind
// of cached lie that drifts (the no-drift rule).
export function progress(contract: Contract): number {
  // FIX: division by zero if milestones is empty.
  if (contract.milestones.length === 0) return 0;

  const paid = contract.milestones.filter((m) => m.status === "paid").length;
  const approved = paid + contract.milestones.filter((m) => m.status === "approved").length;
  const submitted = approved + contract.milestones.filter((m) => m.status === "submitted").length;
  return Math.round((submitted / contract.milestones.length) * 100);
}
