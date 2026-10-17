// Agent templates — 15 launch templates, seedable shape.
//
// Each template carries: slug, category, i18n name key (no hardcoded English —
// sprint 4 rule), persona, goal, instructions, toolGrants (MINIMUM necessary,
// no wildcard grants ever), memorySeeds, budget (conservative defaults),
// triggers.
//
// installTemplate(wsId, userId, slug, overrides) creates a 'paused' agent from
// a template. Overrides can only TIGHTEN: fewer grants, lower budgets, stricter
// approvals, shallower a2a. The user reviews the paused agent, then activates.
//
// THE WILDCARD RULE: toolGrants is a closed list. A template that grants
// "invoices.*" is forbidden — each tool is granted explicitly by id. The
// template's grants are the MINIMUM the agent needs to do its job; the user
// can remove grants on install (tighten) but cannot add new ones via the
// template override path (adding grants requires editing the agent directly,
// which goes through a different permission gate).

import { db } from "@supa/db";
import { agents } from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { BudgetSpec, type BudgetSpec as BudgetSpecType } from "../schema.js";
import { MemoryStore, type MemoryKind } from "../memory/store.js";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type TemplateCategory =
  | "freelancing"
  | "business"
  | "marketing"
  | "design"
  | "finance"
  | "personal"
  | "content"
  | "research"
  | "moderation";

export type TriggerKind = "manual" | "schedule" | "event";

export interface TemplateTrigger {
  kind: TriggerKind;
  /** Cron expression (schedule triggers only). */
  cron?: string;
  /** Event name (event triggers only). E.g. "expense.created". */
  event?: string;
}

export interface MemorySeed {
  kind: MemoryKind;
  content: string;
}

export interface AgentTemplate {
  slug: string;
  category: TemplateCategory;
  /** i18n key — no hardcoded English. Resolved by the UI layer. */
  nameKey: string;
  persona: string;
  goal: string;
  instructions: string;
  /** Minimum necessary tool grants. No wildcards, ever. */
  toolGrants: string[];
  memorySeeds: MemorySeed[];
  /** Conservative budget defaults. User can tighten on install. */
  budget: BudgetSpecType;
  triggers: TemplateTrigger[];
}

// ───────────────────────────────────────────────
// The 15 templates
// ───────────────────────────────────────────────

export const TEMPLATES: AgentTemplate[] = [
  // 1. Invoice chaser (finance)
  {
    slug: "invoice-chaser",
    category: "finance",
    nameKey: "template.invoice_chaser.name",
    persona: "Polite, firm accounts-receivable assistant.",
    goal: "Follow up on overdue invoices until paid, escalating tone on a schedule.",
    instructions:
      "Check overdue invoices daily. For 1–7 days overdue send a polite reminder draft. " +
      "7–30 days a firmer draft. 30+ days draft an escalation note to the owner. " +
      "NEVER send directly — everything is a draft for approval. Log each contact in memory.",
    toolGrants: ["invoices.read", "messages.draft", "contacts.read"],
    memorySeeds: [{ kind: "preference", content: "Tone: polite, never accusatory." }],
    budget: {
      dailyUsdMinor: 200, monthlyUsdMinor: 2000, maxRunsPerDay: 20,
      maxStepsPerRun: 20, maxA2ADepth: 1, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "schedule", cron: "0 9 * * *" }, { kind: "manual" }],
  },

  // 2. Expense categorizer (finance)
  {
    slug: "expense-categorizer",
    category: "finance",
    nameKey: "template.expense_categorizer.name",
    persona: "Meticulous bookkeeper.",
    goal: "Categorize uncategorized expenses and propose corrections.",
    instructions:
      "Read uncategorized expenses, assign categories from the workspace chart of accounts. " +
      "If confidence < 0.8, flag for human rather than guess. Never modify amounts.",
    toolGrants: ["expenses.read", "expenses.categorize"],
    memorySeeds: [],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 30,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 90],
    },
    triggers: [{ kind: "event", event: "expense.created" }, { kind: "manual" }],
  },

  // 3. Translator (content)
  {
    slug: "translator",
    category: "content",
    nameKey: "template.translator.name",
    persona: "Accurate, context-aware translator.",
    goal: "Translate content between languages, preserving tone and intent.",
    instructions:
      "Translate the provided text. Preserve tone, formality, and cultural context. " +
      "If the text contains idioms or cultural references, provide a localized equivalent " +
      "and note the adaptation in a comment. Never publish — draft for review.",
    toolGrants: ["content.read", "content.draft"],
    memorySeeds: [
      { kind: "preference", content: "Default target language: workspace locale." },
    ],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 50,
      maxStepsPerRun: 10, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "manual" }],
  },

  // 4. Lead qualifier (marketing)
  {
    slug: "lead-qualifier",
    category: "marketing",
    nameKey: "template.lead_qualifier.name",
    persona: "Analytical, objective lead scorer.",
    goal: "Score and qualify incoming leads based on ICP fit.",
    instructions:
      "Read new leads. Score each on ICP fit (industry, size, signal strength). " +
      "Tag as hot/warm/cold. Draft a summary for the sales owner. Never contact leads directly.",
    toolGrants: ["contacts.read", "contacts.tag", "messages.draft"],
    memorySeeds: [
      { kind: "fact", content: "ICP: derived from workspace business profile." },
    ],
    budget: {
      dailyUsdMinor: 150, monthlyUsdMinor: 1500, maxRunsPerDay: 40,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "event", event: "contact.created" }, { kind: "manual" }],
  },

  // 5. Content planner (content)
  {
    slug: "content-planner",
    category: "content",
    nameKey: "template.content_planner.name",
    persona: "Strategic, audience-first content planner.",
    goal: "Propose a 30-day content calendar aligned with business goals.",
    instructions:
      "Read the workspace's recent content + business goals. Propose a 30-day calendar " +
      "with topics, formats, and channels. Each entry is a draft — never schedule directly. " +
      "Flag gaps in the content strategy for the owner.",
    toolGrants: ["content.read", "content.draft", "calendar.read"],
    memorySeeds: [],
    budget: {
      dailyUsdMinor: 200, monthlyUsdMinor: 2000, maxRunsPerDay: 10,
      maxStepsPerRun: 25, maxA2ADepth: 1, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 8 * * 1" }],
  },

  // 6. Design brief writer (design)
  {
    slug: "design-brief-writer",
    category: "design",
    nameKey: "template.design_brief_writer.name",
    persona: "Thorough, clear-eyed brief writer.",
    goal: "Draft design briefs from project context and stakeholder input.",
    instructions:
      "Read the project context. Draft a design brief covering: objective, audience, " +
      "deliverables, constraints, timeline. Flag missing context for the owner. " +
      "Never start design work — briefs are drafts for approval.",
    toolGrants: ["projects.read", "content.draft"],
    memorySeeds: [
      { kind: "preference", content: "Brief format: objective-first, constraints-last." },
    ],
    budget: {
      dailyUsdMinor: 150, monthlyUsdMinor: 1500, maxRunsPerDay: 15,
      maxStepsPerRun: 20, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "event", event: "project.created" }, { kind: "manual" }],
  },

  // 7. Freelance proposal writer (freelancing)
  {
    slug: "freelance-proposal-writer",
    category: "freelancing",
    nameKey: "template.freelance_proposal_writer.name",
    persona: "Persuasive, honest proposal writer.",
    goal: "Draft freelance proposals from job postings and profile context.",
    instructions:
      "Read the job posting + freelancer profile. Draft a proposal: intro, approach, " +
      "timeline, rate. Never fabricate experience or portfolio items. " +
      "Rate must match the profile's stated range. Draft for owner review.",
    toolGrants: ["jobs.read", "profile.read", "proposals.draft"],
    memorySeeds: [
      { kind: "fact", content: "Proposal tone: confident, evidence-based, no hyperbole." },
    ],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 25,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "event", event: "job.matched" }, { kind: "manual" }],
  },

  // 8. Customer follow-up (business)
  {
    slug: "customer-follow-up",
    category: "business",
    nameKey: "template.customer_follow_up.name",
    persona: "Warm, timely customer success assistant.",
    goal: "Follow up with customers after key milestones to drive retention.",
    instructions:
      "Monitor customer milestones (onboarding complete, first invoice paid, 30-day mark). " +
      "Draft a personalized follow-up message. Never send directly. " +
      "Log each follow-up in the customer's activity timeline.",
    toolGrants: ["contacts.read", "activity.read", "messages.draft"],
    memorySeeds: [
      { kind: "preference", content: "Tone: warm, specific, never generic." },
    ],
    budget: {
      dailyUsdMinor: 150, monthlyUsdMinor: 1500, maxRunsPerDay: 30,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "event", event: "milestone.reached" }, { kind: "manual" }],
  },

  // 9. Market researcher (research)
  {
    slug: "market-researcher",
    category: "research",
    nameKey: "template.market_researcher.name",
    persona: "Rigorous, citation-first researcher.",
    goal: "Compile market research briefs on requested topics.",
    instructions:
      "Search for recent data on the requested topic. Compile findings with sources. " +
      "Never fabricate citations. If a source can't be verified, flag it. " +
      "Output is a draft brief — owner decides what to act on.",
    toolGrants: ["search.read", "content.draft"],
    memorySeeds: [],
    budget: {
      dailyUsdMinor: 300, monthlyUsdMinor: 3000, maxRunsPerDay: 10,
      maxStepsPerRun: 30, maxA2ADepth: 0, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "manual" }],
  },

  // 10. Meeting prep (personal)
  {
    slug: "meeting-prep",
    category: "personal",
    nameKey: "template.meeting_prep.name",
    persona: "Organized, concise briefing assistant.",
    goal: "Prepare meeting briefs from calendar events and context.",
    instructions:
      "Read the calendar event + attendee context. Draft a brief: attendees, agenda, " +
      "talking points, open items from prior meetings. Never join meetings or send messages. " +
      "Brief is a draft for the owner.",
    toolGrants: ["calendar.read", "contacts.read", "content.draft"],
    memorySeeds: [],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 20,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "event", event: "calendar.upcoming" }, { kind: "manual" }],
  },

  // 11. Design reviewer (design)
  {
    slug: "design-reviewer",
    category: "design",
    nameKey: "template.design_reviewer.name",
    persona: "Constructive, spec-driven design reviewer.",
    goal: "Review designs against brief + brand guidelines, flag gaps.",
    instructions:
      "Read the design + the original brief + brand guidelines. Flag deviations, " +
      "accessibility issues, and missing deliverables. Never modify designs. " +
      "Output is a review note — owner decides what to act on.",
    toolGrants: ["designs.read", "briefs.read", "content.draft"],
    memorySeeds: [
      { kind: "fact", content: "Review criteria: brief adherence, brand fit, a11y." },
    ],
    budget: {
      dailyUsdMinor: 150, monthlyUsdMinor: 1500, maxRunsPerDay: 20,
      maxStepsPerRun: 20, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "event", event: "design.submitted" }, { kind: "manual" }],
  },

  // 12. Applicant screener (moderation)
  {
    slug: "applicant-screener",
    category: "moderation",
    nameKey: "template.applicant_screener.name",
    persona: "Fair, consistent application reviewer.",
    goal: "Screen applicants against posted criteria, flag for human review.",
    instructions:
      "Read the application + the posted criteria. Score on each criterion. " +
      "Flag borderline applicants for human review — never auto-reject. " +
      "Output is a screening summary — owner decides next steps. " +
      "Never communicate with applicants directly.",
    toolGrants: ["applications.read", "content.draft"],
    memorySeeds: [
      { kind: "preference", content: "Bias check: score on criteria only, never on identity." },
    ],
    budget: {
      dailyUsdMinor: 200, monthlyUsdMinor: 2000, maxRunsPerDay: 30,
      maxStepsPerRun: 20, maxA2ADepth: 0, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "event", event: "application.submitted" }, { kind: "manual" }],
  },

  // 13. Social media manager (marketing)
  {
    slug: "social-media-manager",
    category: "marketing",
    nameKey: "template.social_media_manager.name",
    persona: "Brand-aware, platform-native content drafter.",
    goal: "Draft social posts from business updates, aligned with brand voice.",
    instructions:
      "Read the business update + brand voice guidelines. Draft platform-appropriate posts. " +
      "Each post is a draft — never publish directly. Adapt tone per platform. " +
      "Flag sensitive topics for owner review.",
    toolGrants: ["content.read", "content.draft", "brand.read"],
    memorySeeds: [
      { kind: "preference", content: "Tone: brand-consistent, platform-native." },
    ],
    budget: {
      dailyUsdMinor: 150, monthlyUsdMinor: 1500, maxRunsPerDay: 25,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "schedule", cron: "0 10 * * *" }, { kind: "manual" }],
  },

  // 14. Product description writer (content)
  {
    slug: "product-description-writer",
    category: "content",
    nameKey: "template.product_description_writer.name",
    persona: "Clear, benefit-focused copywriter.",
    goal: "Draft product descriptions from specs and feature lists.",
    instructions:
      "Read the product spec + features. Draft a description: lead with benefit, " +
      "follow with features, close with use case. Never fabricate specs or reviews. " +
      "Draft for owner review — never publish directly.",
    toolGrants: ["products.read", "content.draft"],
    memorySeeds: [],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 30,
      maxStepsPerRun: 15, maxA2ADepth: 0, alertAtPct: [50, 80],
    },
    triggers: [{ kind: "event", event: "product.created" }, { kind: "manual" }],
  },

  // 15. Email triage (personal)
  {
    slug: "email-triage",
    category: "personal",
    nameKey: "template.email_triage.name",
    persona: "Fast, accurate email classifier.",
    goal: "Triage inbox: tag priority, draft responses for routine emails.",
    instructions:
      "Read unread emails. Tag as urgent/normal/low. For routine emails (acknowledgments, " +
      "scheduling), draft a response. For sensitive emails (financial, legal), flag only. " +
      "Never send — all drafts for owner review. Log triage decisions in memory.",
    toolGrants: ["email.read", "messages.draft", "email.tag"],
    memorySeeds: [
      { kind: "preference", content: "Triage rule: financial/legal = flag only, never draft." },
    ],
    budget: {
      dailyUsdMinor: 100, monthlyUsdMinor: 1000, maxRunsPerDay: 50,
      maxStepsPerRun: 20, maxA2ADepth: 0, alertAtPct: [50, 80, 95],
    },
    triggers: [{ kind: "schedule", cron: "*/30 * * * *" }, { kind: "manual" }],
  },
];

// ───────────────────────────────────────────────
// tightenBudget — overrides can only TIGHTEN
// ───────────────────────────────────────────────

/**
 * Merge a base budget with overrides. Overrides can only TIGHTEN:
 *   - caps (dailyUsdMinor, monthlyUsdMinor, maxRunsPerDay, maxStepsPerRun,
 *     maxA2ADepth): the LOWER value wins.
 *   - alertAtPct: union (more thresholds = more alerts = tighter).
 *
 * A careless override that tries to widen (e.g. dailyUsdMinor: 50000 on a
 * template that defaults to 200) is silently clamped to the template's default.
 * This is the "overrides can only tighten" rule enforced at the data layer —
 * the UI layer should also prevent widening, but this is the backstop.
 */
export function tightenBudget(
  base: BudgetSpecType,
  override: Partial<BudgetSpecType> | undefined,
): BudgetSpecType {
  if (!override) return base;
  const tightened: BudgetSpecType = {
    dailyUsdMinor: override.dailyUsdMinor != null
      ? Math.min(base.dailyUsdMinor, override.dailyUsdMinor)
      : base.dailyUsdMinor,
    monthlyUsdMinor: override.monthlyUsdMinor != null
      ? Math.min(base.monthlyUsdMinor, override.monthlyUsdMinor)
      : base.monthlyUsdMinor,
    maxRunsPerDay: override.maxRunsPerDay != null
      ? Math.min(base.maxRunsPerDay, override.maxRunsPerDay)
      : base.maxRunsPerDay,
    maxStepsPerRun: override.maxStepsPerRun != null
      ? Math.min(base.maxStepsPerRun, override.maxStepsPerRun)
      : base.maxStepsPerRun,
    maxA2ADepth: override.maxA2ADepth != null
      ? Math.min(base.maxA2ADepth, override.maxA2ADepth)
      : base.maxA2ADepth,
    // Union of alert thresholds (more alerts = tighter).
    alertAtPct: Array.from(
      new Set([...base.alertAtPct, ...(override.alertAtPct ?? [])]),
    ).sort((a, b) => a - b),
  };
  // Re-validate against the Zod schema (catches any out-of-range values
  // that slipped through the min() logic — e.g. an override with
  // dailyUsdMinor: 0 would pass min() but fail .positive()).
  return BudgetSpec.parse(tightened);
}

// ───────────────────────────────────────────────
// tightenToolGrants — overrides can only REMOVE grants, never add
// ───────────────────────────────────────────────

/**
 * Merge tool grants. Overrides can only REMOVE grants — the result is the
 * intersection of the template's grants and the override's grants. An override
 * that tries to add a grant not in the template is silently dropped (the
 * template's grant list is the ceiling; adding grants requires editing the
 * agent directly, which goes through a different permission gate).
 */
export function tightenToolGrants(
  base: readonly string[],
  override: readonly string[] | undefined,
): string[] {
  if (!override) return [...base];
  const overrideSet = new Set(override);
  return base.filter((g) => overrideSet.has(g));
}

// ───────────────────────────────────────────────
// createAgent — insert a row in the agents table
// ───────────────────────────────────────────────

export interface CreateAgentInput {
  slug: string;
  nameKey: string;
  persona: string;
  goal: string;
  instructions: string;
  toolGrants: string[];
  budget: BudgetSpecType;
  memorySeeds?: MemorySeed[];
  triggers?: TemplateTrigger[];
  status?: "draft" | "active" | "paused" | "killed";
}

/**
 * Create an agent row. Returns the agent id. The agent starts in 'paused'
 * status by default (template install path) — the user reviews, then activates.
 * The `name` column is set to the slug initially (user can rename); the UI
 * resolves the i18n nameKey for display.
 */
export async function createAgent(
  wsId: string,
  userId: string,
  input: CreateAgentInput,
): Promise<{ id: string }> {
  const rows = await db
    .insert(agents)
    .values({
      workspaceId: wsId as any,
      name: input.slug, // initial name = slug; user renames via UI
      persona: input.persona,
      goal: input.goal,
      instructions: input.instructions,
      toolGrants: input.toolGrants,
      approvalPolicy: {}, // no per-tool overrides from template; user adds via UI
      budget: input.budget as any,
      status: input.status ?? "paused",
      visibility: "private",
      locale: "en",
      configVersion: 1,
      createdBy: userId as any,
    })
    .returning({ id: agents.id });

  const row = rows[0];
  if (!row) {
    throw new Error("agent_insert_failed");
  }
  return { id: row.id };
}

// ───────────────────────────────────────────────
// seedMemories — write template seeds via MemoryStore
// ───────────────────────────────────────────────

/**
 * Write a template's memory seeds to the agent's memory store. Each seed is
 * written with `provenance: "template_seed"` so the agent's recall can
 * distinguish template-injected memories from agent-learned or user-edited
 * ones. Template seeds are low-confidence (0.3) — the agent should re-derive
 * these from observation as it runs; the seed is a starting point, not
 * authoritative.
 */
export async function seedMemories(
  wsId: string,
  agentId: string,
  seeds: readonly MemorySeed[],
): Promise<void> {
  if (seeds.length === 0) return;
  const store = new MemoryStore(wsId, agentId);
  for (const seed of seeds) {
    await store.write(seed.kind, seed.content, {
      provenance: "template_seed",
      confidence: 0.3, // low — seed, not authoritative
    });
  }
}

// ───────────────────────────────────────────────
// installTemplate — find + tighten + create + seed
// ───────────────────────────────────────────────

export interface InstallOverrides {
  toolGrants?: string[];
  budget?: Partial<BudgetSpecType>;
  /** Additional memory seeds (merged with the template's seeds). */
  memorySeeds?: MemorySeed[];
}

export interface InstallResult {
  agentId: string;
  slug: string;
  /** The final toolGrants after tightening (intersection of template + override). */
  toolGrants: string[];
  /** The final budget after tightening. */
  budget: BudgetSpecType;
  /** Number of memory seeds written. */
  memorySeedsCount: number;
}

/**
 * Install a template into a workspace. Creates a 'paused' agent from the
 * template, applies overrides (tighten-only: fewer grants, lower budgets,
 * more alerts), and seeds the agent's memory.
 *
 * THE WILDCARD RULE is enforced: toolGrants is the intersection of the
 * template's grants and the override's grants. An override that tries to add
 * a grant not in the template is silently dropped.
 *
 * Returns the agent id + the final tightened config (for the UI to show
 * the user what was actually installed).
 */
export async function installTemplate(
  wsId: string,
  userId: string,
  slug: string,
  overrides: InstallOverrides = {},
): Promise<InstallResult> {
  const template = TEMPLATES.find((t) => t.slug === slug);
  if (!template) {
    throw new Error(`template_not_found:${slug}`);
  }

  // Tighten — overrides can only reduce grants, lower caps, add alerts.
  const finalToolGrants = tightenToolGrants(template.toolGrants, overrides.toolGrants);
  const finalBudget = tightenBudget(template.budget, overrides.budget);
  const finalSeeds = [...template.memorySeeds, ...(overrides.memorySeeds ?? [])];

  // Create the agent in 'paused' status — user reviews, then activates.
  const { id: agentId } = await createAgent(wsId, userId, {
    slug: template.slug,
    nameKey: template.nameKey,
    persona: template.persona,
    goal: template.goal,
    instructions: template.instructions,
    toolGrants: finalToolGrants,
    budget: finalBudget,
    memorySeeds: finalSeeds,
    triggers: template.triggers,
    status: "paused",
  });

  // Seed the agent's memory with template seeds (provenance='template_seed').
  await seedMemories(wsId, agentId, finalSeeds);

  return {
    agentId,
    slug: template.slug,
    toolGrants: finalToolGrants,
    budget: finalBudget,
    memorySeedsCount: finalSeeds.length,
  };
}

// ───────────────────────────────────────────────
// listTemplates — for the template gallery UI
// ───────────────────────────────────────────────

/**
 * List all templates, optionally filtered by category. Returns the full
 * template objects (the UI resolves i18n nameKey + renders the gallery).
 */
export function listTemplates(category?: TemplateCategory): AgentTemplate[] {
  if (!category) return TEMPLATES;
  return TEMPLATES.filter((t) => t.category === category);
}

/**
 * Look up a single template by slug. Returns undefined if not found.
 */
export function getTemplate(slug: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}
