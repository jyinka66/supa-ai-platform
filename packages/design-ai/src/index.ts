// ─────────────────────────────────────────────────────────────
// @supa/design-ai — AI commands that mutate the design doc.
//
// Phase 1 surface: `generateDesignFromPrompt(wsId, prompt, modelId)` —
// takes a natural-language prompt + model id, calls the AI gateway,
// and returns a draft DesignDoc ready to be loaded into the editor.
//
// The prompt is built from a registered prompt template (registry
// below). The generation is wired to @supa/observability/ai-quality
// so the 2% review-queue sample + undo-rate KPIs attribute correctly
// per (promptTemplateId, model, provider).
//
// Honest scope: the AI gateway contract is JSON { doc, provider,
// generationId }. When the gateway is unreachable (offline, dev
// without key, network error), the function synthesizes a minimal
// draft doc client-side so the command palette's "Generate design
// from prompt" still produces something the user can edit. The
// synthesized draft is clearly a placeholder — a heading + body
// text layer derived from the prompt — not a real generation.
// ─────────────────────────────────────────────────────────────

import type {
  DesignDoc,
  Page,
  TextLayer,
} from "@supa/design-model";
import {
  newId,
  CURRENT_SCHEMA_VERSION,
} from "@supa/design-model";
import type {
  AIQualityTracker,
  GenerationAcceptedSignal,
} from "@supa/observability/ai-quality";

// ============ PROMPT TEMPLATE REGISTRY ============

/**
 * A prompt template — the prompt-building contract for an AI command.
 *
 * Prompt changes ship like code: each template has a stable id + version
 * so the AI quality KPIs attribute to (template, model, provider).
 * Before a template change rolls out, the candidate is benchmarked
 * against the 200-doc corpus via @supa/observability/ai-quality's
 * `evaluateBenchmarkGate`.
 */
export interface PromptTemplate {
  /** Stable id, e.g. "ai.generate.v1". */
  id: string;
  /** Monotonic version — bumped when the prompt text changes. */
  version: number;
  /** Human-readable description (for the prompt-change audit log). */
  description: string;
  /** Builds the final prompt sent to the model. */
  buildPrompt: (userPrompt: string) => string;
}

const PROMPT_TEMPLATES = new Map<string, PromptTemplate>();

/**
 * Registers a prompt template. Later registrations with the same id
 * override earlier ones (HMR-friendly).
 */
export function registerPromptTemplate(template: PromptTemplate): void {
  PROMPT_TEMPLATES.set(template.id, template);
}

/**
 * Returns a registered prompt template by id, or undefined.
 */
export function getPromptTemplate(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.get(id);
}

/**
 * Returns all registered prompt templates (for the prompt-change audit UI).
 */
export function listPromptTemplates(): PromptTemplate[] {
  return Array.from(PROMPT_TEMPLATES.values());
}

// Register the default "generate design from prompt" template.
// This is the prompt used by the `ai.generate` palette command.
registerPromptTemplate({
  id: "ai.generate.v1",
  version: 1,
  description:
    "Generate a single-page draft design document from a natural-language prompt.",
  buildPrompt: (userPrompt) =>
    "You are a design assistant. Generate a single-page design document " +
    "for the following request. Respond with a JSON DesignDoc.\n\n" +
    `Request: ${userPrompt}`,
});

// ============ GENERATION ============

export interface GenerateDesignOptions {
  /** Prompt template id. Default: "ai.generate.v1". */
  promptTemplateId?: string;
  /**
   * Optional AI quality tracker. If provided, the generation is recorded
   * as an accepted generation so undo-rate + accept-without-edit KPIs
   * attribute to (template, model, provider).
   */
  qualityTracker?: AIQualityTracker;
  /** Override fetch (tests, server-side). */
  fetch?: typeof fetch;
  /** AI gateway endpoint. Default: "/api/ai/generate-design". */
  endpoint?: string;
  /** Override clock (tests). */
  now?: () => number;
}

export interface GenerateDesignResult {
  /** The generated draft doc. */
  doc: DesignDoc;
  /** Prompt template id used (for telemetry attribution). */
  promptTemplateId: string;
  /** Provider tag (e.g. "openai", "anthropic"). */
  provider: string;
  /** Model id used. */
  model: string;
  /** Generation id (for quality tracking + provenance). */
  generationId: string;
  /**
   * True if the doc was synthesized locally because the gateway was
   * unreachable or errored. Useful for surfacing "offline draft" UX.
   */
  synthesized: boolean;
}

/**
 * Generates a draft DesignDoc from a natural-language prompt.
 *
 * Flow:
 *   1. Build the final prompt from the registered template.
 *   2. POST to the AI gateway ({ wsId, prompt, promptTemplateId, modelId }).
 *   3. On success: use the returned doc.
 *      On failure/unreachable: synthesize a minimal draft doc locally
 *      so the user still gets something to edit (clearly a placeholder).
 *   4. If a qualityTracker is provided, fire `onGenerationAccepted` so
 *      the 2% review-queue sample + implicit KPIs attribute correctly.
 *
 * @example
 *   const { doc } = await generateDesignFromPrompt(wsId, "flyer for a bake sale", "gpt-4o");
 *   store.load(doc);
 */
export async function generateDesignFromPrompt(
  wsId: string,
  prompt: string,
  modelId: string,
  options?: GenerateDesignOptions,
): Promise<GenerateDesignResult> {
  const template =
    getPromptTemplate(options?.promptTemplateId ?? "ai.generate.v1") ??
    getPromptTemplate("ai.generate.v1");
  if (!template) {
    throw new Error("design-ai: no prompt template registered");
  }

  const finalPrompt = template.buildPrompt(prompt);
  const endpoint = options?.endpoint ?? "/api/ai/generate-design";
  const fetchImpl = options?.fetch ?? fetch;
  const now = options?.now ?? Date.now;

  let generationId = `gen_${newId()}`;
  let doc: DesignDoc;
  let provider = "unknown";
  let synthesized = false;

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wsId,
        prompt: finalPrompt,
        promptTemplateId: template.id,
        modelId,
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as {
        doc?: DesignDoc;
        provider?: string;
        generationId?: string;
      };
      if (json.doc) {
        doc = json.doc;
        provider = json.provider ?? "unknown";
        if (json.generationId) {
          // Use the server's generation id if provided (for telemetry
          // attribution + provenance).
          generationId = json.generationId;
        }
      } else {
        doc = synthesizeDraftDoc(prompt);
        synthesized = true;
      }
    } else {
      // Gateway responded with an error status — fall back to a draft.
      doc = synthesizeDraftDoc(prompt);
      synthesized = true;
    }
  } catch {
    // Network error / gateway unreachable — synthesize so the function
    // is still usable in dev + offline.
    doc = synthesizeDraftDoc(prompt);
    synthesized = true;
  }

  // Wire to the AI quality channel — record this as an accepted generation
  // so undo-rate + accept-without-edit KPIs attribute correctly per
  // (promptTemplateId, model, provider).
  if (options?.qualityTracker) {
    const signal: GenerationAcceptedSignal = {
      generationId,
      docId: doc.id,
      promptTemplateId: template.id,
      model: modelId,
      provider,
      acceptedAt: now(),
    };
    options.qualityTracker.onGenerationAccepted(signal);
  }

  return {
    doc,
    promptTemplateId: template.id,
    provider,
    model: modelId,
    generationId,
    synthesized,
  };
}

// ============ DRAFT SYNTHESIS (offline fallback) ============

/**
 * Synthesizes a minimal draft DesignDoc from the prompt — a heading
 * layer + body text layer derived from the prompt. Used as a fallback
 * when the AI gateway is unreachable.
 *
 * This is a placeholder, not a real generation — the synthesized doc
 * is clearly derivable from the prompt so users can tell.
 */
function synthesizeDraftDoc(prompt: string): DesignDoc {
  const pageId = `p_${newId()}`;
  const headingId = `n_${newId()}`;
  const bodyId = `n_${newId()}`;

  const heading = prompt.slice(0, 60).trim() || "Untitled design";
  const bodyText = prompt.trim() || "Generated draft — edit me.";

  const headingLayer: TextLayer = {
    id: headingId,
    type: "text",
    name: "Heading",
    locked: false,
    hidden: false,
    rect: { x: 64, y: 64, width: 672, height: 80 },
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: { horizontal: "left", vertical: "top" },
    content: heading,
    runs: [],
    fontFamily: "Inter",
    fontSize: 48,
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: { value: 0, unit: "px" },
    align: "left",
    direction: "ltr",
    autoResize: "width",
  };

  const bodyLayer: TextLayer = {
    id: bodyId,
    type: "text",
    name: "Body",
    locked: false,
    hidden: false,
    rect: { x: 64, y: 168, width: 672, height: 240 },
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: { horizontal: "left", vertical: "top" },
    content: bodyText,
    runs: [],
    fontFamily: "Inter",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.5,
    letterSpacing: { value: 0, unit: "px" },
    align: "left",
    direction: "ltr",
    autoResize: "none",
  };

  const page: Page = {
    id: pageId,
    name: "Page 1",
    size: { width: 800, height: 600 },
    background: { type: "solid", color: { hex: "#ffffff" } },
    layers: [headingLayer, bodyLayer],
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: `doc_${newId()}`,
    kind: "flyer",
    name: heading,
    isTemplate: false,
    locale: "en",
    pages: [page],
    assets: {},
    a11y: { issues: [] },
  };
}

// ============ TYPE RE-EXPORT ============

export type { DesignDoc, Page, TextLayer } from "@supa/design-model";
export type {
  AIQualityTracker,
  GenerationAcceptedSignal,
} from "@supa/observability/ai-quality";
