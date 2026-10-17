// Vertical edition generation — autonomous assembly from templates.
//
// The spec (14.1): "Vertical editions are generated. A new vertical is
// configured from a vertical template plus domain-specific prompts, agents,
// connectors, and compliance — assembled by the platform, reviewed by humans
// once, then replicated autonomously."
//
// Flow:
//   1. createVerticalTemplate(slug, name, description) — start with a template.
//   2. assembleVertical(verticalId) — the platform assembles: domain prompts,
//      agent templates, connectors, compliance rules, tools — from the template.
//   3. reviewVertical(verticalId, reviewerId) — human reviews once.
//   4. publishVertical(verticalId) — published, then replicated autonomously.
//
// The template specifies WHAT to assemble; the platform does the HOW.

import { db } from "@supa/db";
import { verticalEditions } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type VerticalStatus = "template" | "assembling" | "reviewing" | "published" | "deprecated";

export interface VerticalTemplate {
  prompts: string[];                    // domain-specific system prompt IDs.
  agents: string[];                     // agent template keys.
  connectors: string[];                 // connector keys (e.g. ['slack', 'github']).
  tools: string[];                      // tool keys (e.g. ['search.web', 'file.upload']).
  complianceRules: Record<string, boolean>; // { hipaa: true, gdpr: true, soc2: true }.
  budgets: {
    agentBudgetPerRunUsd: number;
    monthlyBudgetPerWsUsd: number;
  };
  rateLimits: {
    requestsPerMin: number;
    concurrentAgents: number;
  };
}

export interface VerticalEdition {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: VerticalTemplate;
  status: VerticalStatus;
  assembledAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  publishedAt: Date | null;
  complianceRules: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

export class VerticalError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "VerticalError";
  }
}

// ───────────────────────────────────────────────
// Predefined vertical templates (the assembly blueprints).
// ───────────────────────────────────────────────

export const VERTICAL_TEMPLATES: Record<string, VerticalTemplate> = {
  legal: {
    prompts: ["legal.system", "legal.contract_review", "legal.citation"],
    agents: ["legal.contract_reviewer", "legal.research_assistant"],
    connectors: ["google_workspace", "microsoft_365"],
    tools: ["search.web", "file.upload", "file.download", "pdf.generate"],
    complianceRules: { gdpr: true, soc2: true, attorney_client_privilege: true },
    budgets: { agentBudgetPerRunUsd: 2.0, monthlyBudgetPerWsUsd: 500 },
    rateLimits: { requestsPerMin: 100, concurrentAgents: 5 },
  },
  healthcare: {
    prompts: ["healthcare.system", "healthcare.clinical_summary", "healthcare.patient_education"],
    agents: ["healthcare.clinical_assistant", "healthcare.scheduling_agent"],
    connectors: ["google_workspace", "slack"],
    tools: ["search.web", "file.upload", "file.download"],
    complianceRules: { hipaa: true, gdpr: true, phi_protection: true },
    budgets: { agentBudgetPerRunUsd: 1.5, monthlyBudgetPerWsUsd: 300 },
    rateLimits: { requestsPerMin: 50, concurrentAgents: 3 },
  },
  finance: {
    prompts: ["finance.system", "finance.analysis", "finance.risk_assessment"],
    agents: ["finance.analyst", "finance.risk_assessor", "finance.report_generator"],
    connectors: ["stripe", "hubspot", "google_workspace"],
    tools: ["search.web", "file.upload", "file.download", "pdf.generate", "email.send"],
    complianceRules: { soc2: true, pci_dss: true, gdpr: true, sox: true },
    budgets: { agentBudgetPerRunUsd: 3.0, monthlyBudgetPerWsUsd: 1000 },
    rateLimits: { requestsPerMin: 200, concurrentAgents: 10 },
  },
  education: {
    prompts: ["education.system", "education.tutor", "education.curriculum"],
    agents: ["education.tutor", "education.curriculum_designer", "education.grading_assistant"],
    connectors: ["google_workspace", "microsoft_365", "discord"],
    tools: ["search.web", "file.upload", "file.download", "pdf.generate"],
    complianceRules: { ferpa: true, gdpr: true, coppa: true },
    budgets: { agentBudgetPerRunUsd: 0.5, monthlyBudgetPerWsUsd: 100 },
    rateLimits: { requestsPerMin: 150, concurrentAgents: 8 },
  },
  retail: {
    prompts: ["retail.system", "retail.inventory", "retail.customer_service"],
    agents: ["retail.inventory_manager", "retail.customer_service_agent"],
    connectors: ["shopify", "stripe", "slack"],
    tools: ["search.web", "file.upload", "file.download", "email.send"],
    complianceRules: { pci_dss: true, gdpr: true, ccpa: true },
    budgets: { agentBudgetPerRunUsd: 1.0, monthlyBudgetPerWsUsd: 200 },
    rateLimits: { requestsPerMin: 200, concurrentAgents: 10 },
  },
  construction: {
    prompts: ["construction.system", "construction.project_mgmt", "construction.safety"],
    agents: ["construction.project_manager", "construction.safety_inspector"],
    connectors: ["google_workspace", "slack", "asana"],
    tools: ["search.web", "file.upload", "file.download", "pdf.generate"],
    complianceRules: { osha: true, gdpr: true },
    budgets: { agentBudgetPerRunUsd: 1.0, monthlyBudgetPerWsUsd: 300 },
    rateLimits: { requestsPerMin: 100, concurrentAgents: 5 },
  },
};

// ───────────────────────────────────────────────
// createVerticalTemplate — start a new vertical.
// ───────────────────────────────────────────────

export async function createVerticalTemplate(
  slug: string,
  name: string,
  description: string,
  templateKey?: string,
): Promise<VerticalEdition> {
  // Use a predefined template if specified, otherwise start with an empty template.
  const template = templateKey ? VERTICAL_TEMPLATES[templateKey] : {
    prompts: [], agents: [], connectors: [], tools: [],
    complianceRules: {},
    budgets: { agentBudgetPerRunUsd: 1.0, monthlyBudgetPerWsUsd: 100 },
    rateLimits: { requestsPerMin: 100, concurrentAgents: 5 },
  };

  try {
    const rows = await db
      .insert(verticalEditions)
      .values({
        slug,
        name,
        description,
        template: template as any,
        status: "template",
        complianceRules: (template?.complianceRules ?? {}) as any,
      })
      .returning({ id: verticalEditions.id });
    const row = rows[0];
    if (!row) throw new VerticalError("vertical_insert_failed", 500);

    await auditVertical("vertical.template.created", row.id as string, { slug, name });
    return (await getVertical(row.id as string))!;
  } catch (err) {
    if (err instanceof VerticalError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("23505")) {
      throw new VerticalError("vertical_slug_exists", 409);
    }
    throw err;
  }
}

// ───────────────────────────────────────────────
// assembleVertical — the platform assembles from the template.
//
// This is the autonomous step: the platform reads the template, validates
// that all referenced prompts/agents/connectors/tools exist, and marks
// the vertical as 'assembling' → 'reviewing'.
// ───────────────────────────────────────────────

export async function assembleVertical(verticalId: string): Promise<VerticalEdition> {
  const vertical = await getVertical(verticalId);
  if (!vertical) throw new VerticalError("vertical_not_found", 404);
  if (vertical.status !== "template") {
    throw new VerticalError(`vertical_not_in_template_state:${vertical.status}`, 409);
  }

  // Mark as assembling.
  await db
    .update(verticalEditions)
    .set({ status: "assembling", updatedAt: new Date() })
    .where(eq(verticalEditions.id, verticalId as any));

  const template = vertical.template;

  // Validate referenced entities exist (stubs — would query tool_registry, connectors, etc.).
  const validation = {
    promptsValid: template.prompts.length > 0,
    agentsValid: template.agents.length > 0,
    connectorsValid: template.connectors.length > 0,
    toolsValid: template.tools.length > 0,
    complianceValid: Object.keys(template.complianceRules).length > 0,
    budgetsValid: template.budgets.agentBudgetPerRunUsd > 0 && template.budgets.monthlyBudgetPerWsUsd > 0,
    rateLimitsValid: template.rateLimits.requestsPerMin > 0 && template.rateLimits.concurrentAgents > 0,
  };

  const allValid = Object.values(validation).every(Boolean);
  if (!allValid) {
    await db
      .update(verticalEditions)
      .set({ status: "template", updatedAt: new Date() })
      .where(eq(verticalEditions.id, verticalId as any));
    throw new VerticalError(`assembly_validation_failed:${JSON.stringify(validation)}`, 400);
  }

  // Assembly complete — move to reviewing.
  await db
    .update(verticalEditions)
    .set({ status: "reviewing", assembledAt: new Date(), updatedAt: new Date() })
    .where(eq(verticalEditions.id, verticalId as any));

  await auditVertical("vertical.assembled", verticalId, { template, validation });

  return (await getVertical(verticalId))!;
}

// ───────────────────────────────────────────────
// reviewVertical — human reviews once.
// ───────────────────────────────────────────────

export async function reviewVertical(verticalId: string, reviewerId: string, approved: boolean): Promise<VerticalEdition> {
  const vertical = await getVertical(verticalId);
  if (!vertical) throw new VerticalError("vertical_not_found", 404);
  if (vertical.status !== "reviewing") {
    throw new VerticalError(`vertical_not_in_reviewing:${vertical.status}`, 409);
  }

  if (approved) {
    await db
      .update(verticalEditions)
      .set({ status: "published", reviewedBy: reviewerId as any, reviewedAt: new Date(), publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(verticalEditions.id, verticalId as any));

    await auditVertical("vertical.published", verticalId, { reviewerId });
  } else {
    // Rejected — back to template for revision.
    await db
      .update(verticalEditions)
      .set({ status: "template", reviewedBy: reviewerId as any, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(verticalEditions.id, verticalId as any));

    await auditVertical("vertical.rejected", verticalId, { reviewerId });
  }

  return (await getVertical(verticalId))!;
}

// ───────────────────────────────────────────────
// deprecateVertical — retire a published vertical.
// ───────────────────────────────────────────────

export async function deprecateVertical(verticalId: string): Promise<void> {
  const result = await db
    .update(verticalEditions)
    .set({ status: "deprecated", updatedAt: new Date() })
    .where(and(eq(verticalEditions.id, verticalId as any), eq(verticalEditions.status, "published")))
    .returning({ id: verticalEditions.id });

  if (result.length === 0) throw new VerticalError("vertical_not_found_or_not_published", 404);
  await auditVertical("vertical.deprecated", verticalId, {});
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getVertical(id: string): Promise<VerticalEdition | null> {
  const rows = await db.select().from(verticalEditions).where(eq(verticalEditions.id, id as any)).limit(1);
  return mapRow(rows[0]);
}

export async function getVerticalBySlug(slug: string): Promise<VerticalEdition | null> {
  const rows = await db.select().from(verticalEditions).where(eq(verticalEditions.slug, slug)).limit(1);
  return mapRow(rows[0]);
}

export async function listVerticals(opts: { status?: VerticalStatus } = {}): Promise<VerticalEdition[]> {
  const rows = await db
    .select()
    .from(verticalEditions)
    .where(opts.status ? eq(verticalEditions.status, opts.status) : undefined)
    .orderBy(verticalEditions.createdAt);

  return rows.map(mapRow).filter((v): v is VerticalEdition => v !== null);
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function mapRow(row: Record<string, unknown> | undefined): VerticalEdition | null {
  if (!row) return null;
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string,
    template: (row.template as VerticalTemplate) ?? VERTICAL_TEMPLATES.legal,
    status: row.status as VerticalStatus,
    assembledAt: (row.assembledAt as Date | null) ?? null,
    reviewedBy: (row.reviewedBy as string | null) ?? null,
    reviewedAt: (row.reviewedAt as Date | null) ?? null,
    publishedAt: (row.publishedAt as Date | null) ?? null,
    complianceRules: (row.complianceRules as Record<string, boolean>) ?? {},
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

async function auditVertical(action: string, verticalId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await adminAudit({ actor: "system", action, target: { verticalId, ...target }, justification: `vertical: ${action}` });
  } catch { /* audit failure must not fail the operation */ }
}
