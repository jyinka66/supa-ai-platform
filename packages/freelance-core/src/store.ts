// Thin store over the spine's existing fact pipeline. Jobs are
// records; job *transitions* are activity_facts (captured →
// proposing → active → delivered → paid) so the timeline,
// AI summaries, and the reports engine all see freelance work
// for free — no new fact kind, just a new activity type.

import { db } from "@supa/db";
import { freelanceJobs, activityFacts } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { FreelanceJob, JobStatus } from "./job.js";
import { assertExternalIsolation } from "./boundary.js";

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

export async function createJob(
  wsId: string,
  input: Omit<FreelanceJob, "id" | "wsId" | "createdAt" | "updatedAt" | "status">,
): Promise<FreelanceJob> {
  // FIX: { ...input, wsId } was missing id, status, createdAt, updatedAt.
  // Those are Omit'd from input but required on FreelanceJob — satisfies
  // would fail. Added the defaults.
  const now = new Date().toISOString();
  const job = {
    ...input,
    wsId,
    id: crypto.randomUUID(),
    status: "captured" as const,
    createdAt: now,
    updatedAt: now,
  } satisfies FreelanceJob;

  assertExternalIsolation(job);

  return db.transaction(async (tx) => {
    // FIX: replaced placeholder with real Drizzle insert into freelanceJobs table.
    const [row] = await tx
      .insert(freelanceJobs)
      .values({
        id: job.id,
        workspaceId: wsId,
        source: job.source,
        title: job.title,
        brief: job.brief,
        discipline: job.discipline,
        skills: job.skills,
        budgetMinor: BigInt(job.budget.value.amountMinor),
        budgetCurrency: job.budget.value.currency,
        budgetType: job.budget.type,
        deadline: job.deadline ? new Date(job.deadline) : null,
        status: "captured",
        clientRef: job.clientRef,
        externalPlatform: job.externalRef?.platform ?? null,
        externalUrl: job.externalRef?.url ?? null,
        // FIX: FreelanceJob schema doesn't have createdBy, but the DB table requires it.
        // The workspace creating the job is the creator.
        createdBy: wsId,
      })
      .returning();

    if (!row) throw new Error("freelance job insert failed");

    await recordActivity(tx, {
      wsId,
      kind: "supa.freelance.job.created",
      ref: { jobId: row.id, source: job.source },
    });

    return job;
  });
}

export async function transitionJob(
  wsId: string,
  jobId: string,
  to: JobStatus,
): Promise<FreelanceJob> {
  // Legal transitions only; every transition is a fact.
  const LEGAL = {
    captured: ["proposing", "active", "closed"],
    proposing: ["active", "closed"],
    active: ["delivered", "closed"],
    delivered: ["paid", "closed"],
    paid: ["closed"],
    closed: [],
  } as const;

  return db.transaction(async (tx) => {
    // FIX: replaced placeholder with real Drizzle query — scoped by wsId
    // (tenancy in the WHERE, not in the caller). A third wsId simply
    // finds no row.
    const [row] = await tx
      .select()
      .from(freelanceJobs)
      .where(and(eq(freelanceJobs.id, jobId), eq(freelanceJobs.workspaceId, wsId)))
      .limit(1);

    if (!row) throw new Error(`job ${jobId} not found in workspace ${wsId}`);

    const currentStatus = row.status as JobStatus;
    const allowed = LEGAL[currentStatus] as readonly string[];

    // FIX: template literal was broken — `job.status→{job.status} →job.status→{to}`
    // had no `$` before `{`, so it was a literal string not interpolation.
    if (!allowed.includes(to)) {
      throw new Error(`illegal transition: ${currentStatus} → ${to}`);
    }

    const now = new Date().toISOString();
    // FIX: replaced placeholder with real Drizzle update.
    const [updated] = await tx
      .update(freelanceJobs)
      .set({
        status: to,
        updatedAt: new Date(now),
      })
      .where(and(eq(freelanceJobs.id, jobId), eq(freelanceJobs.workspaceId, wsId)))
      .returning();

    if (!updated) throw new Error(`failed to update job ${jobId}`);

    await recordActivity(tx, {
      wsId,
      kind: "supa.freelance.job.status",
      ref: { jobId, from: currentStatus, to },
    });

    // Map the DB row back to the domain FreelanceJob type.
    return {
      id: updated.id,
      wsId: updated.workspaceId,
      source: updated.source as FreelanceJob["source"],
      title: updated.title,
      brief: updated.brief,
      discipline: updated.discipline as FreelanceJob["discipline"],
      skills: updated.skills as string[],
      budget: {
        value: {
          amountMinor: Number(updated.budgetMinor),
          currency: updated.budgetCurrency,
        },
        type: updated.budgetType as "hourly" | "fixed",
      },
      deadline: updated.deadline?.toISOString() ?? undefined,
      status: updated.status as JobStatus,
      clientRef: updated.clientRef,
      ...(updated.externalPlatform ? {
        externalRef: {
          platform: updated.externalPlatform as FreelanceJob["externalRef"] extends infer T ? T extends { platform: infer P } ? P : never : never,
          ...(updated.externalUrl ? { url: updated.externalUrl } : {}),
        },
      } : {}),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    } as FreelanceJob;
  });
}
