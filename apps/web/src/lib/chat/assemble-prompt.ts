import { db } from "@supa/db";
import { promptVersions } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { getPrompt, type Mode } from "@/lib/prompts";
import { withInjectionDefense } from "@/lib/prompts/injection-defense";

/**
 * Prompt assembly — picks the best variant for the detected language,
 * fills language-specific slots, and returns the final system prompt.
 *
 * Flow:
 *   1. Try to find an active A/B-tested variant for (mode, language)
 *   2. If found, use its system prompt text
 *   3. If not found, fall back to the base prompt from the prompt library
 *      (which is already localized for major languages)
 *   4. Fill template slots with context variables
 *   5. Apply injection-defense suffix
 *
 * The "variant" comes from the `prompt_versions` table, where the
 * `evaluatePromptVersions()` cron promotes winners (sets `is_active = true`).
 * If no variant has been promoted yet for a given language, we use the
 * base prompt from the code-level prompt library (lib/prompts/index.ts).
 */

export type PromptKind = Mode;

export interface AssembledPrompt {
  /** The final system prompt text (ready to send to the LLM). */
  text: string;
  /** The prompt version identifier (e.g. "chat-v3.2.1"). */
  version: string;
  /** The detected language code (ISO 639-1). */
  language: string;
  /** The prompt_versions.id if a DB variant was used, null if base prompt. */
  promptId: string | null;
  /** The experiment ID if part of an A/B test, null otherwise. */
  experimentId: string | null;
}

export interface AssemblePromptContext {
  /** Detected language (ISO 639-1, e.g. "en", "ar"). */
  language: string;
  /** UI locale (may differ from detected language — e.g. user's UI is French but message is English). */
  locale: string;
  /** Template variables to fill into the prompt (e.g. { workspaceName: "Acme" }). */
  vars: Record<string, string>;
}

interface PromptVariantRow {
  id: string;
  version: string;
  system: string;
  isActive: boolean;
  language: string;
  mode: string;
}

/**
 * Assembles the final system prompt for a chat request.
 *
 * @example
 *   const prompt = await assemblePrompt("chat", {
 *     language: "es",
 *     locale: "es",
 *     vars: { workspaceName: "Acme" },
 *   });
 *   // prompt.text → "Eres un asistente útil dentro de Acme..."
 *   // prompt.version → "chat-v3.2.1"
 */
export async function assemblePrompt(
  kind: PromptKind,
  ctx: AssemblePromptContext,
): Promise<AssembledPrompt> {
  // 1. Try to find an active A/B-tested variant for (mode, language).
  const variant = await pickPromptVariant(kind, ctx.language);

  if (variant) {
    // 2. Found a DB variant — fill its slots + return.
    const filled = fillSlots(variant.system, { ...ctx.vars, language: ctx.language });
    const text = withInjectionDefense(filled);

    return {
      text,
      version: variant.version,
      language: ctx.language,
      promptId: variant.id,
      experimentId: null, // future: track experiment assignment
    };
  }

  // 3. No tested variant — fall back to the code-level prompt library.
  //    The library already has localized overrides for major languages.
  const base = getPrompt(kind, ctx.language);
  const filled = fillSlots(base.system, { ...ctx.vars, language: ctx.language });
  const text = withInjectionDefense(filled);

  return {
    text,
    version: base.version,
    language: ctx.language,
    promptId: null,
    experimentId: null,
  };
}

/**
 * Picks the active prompt variant for a (mode, language) slot.
 *
 * Queries the `prompt_versions` table for the row with `is_active = true`
 * matching the mode + language. Returns null if no variant has been
 * promoted yet (the caller falls back to the base prompt).
 *
 * NOTE: this is NOT sticky assignment — it just returns the current winner.
 * For true A/B testing with sticky assignment, you'd need to:
 *   1. Hash the user_id + experiment_id to pick a bucket
 *   2. Return the variant assigned to that bucket
 *   3. Store the assignment so the same user always sees the same variant
 *
 * The current implementation is "post-experiment" — once a variant wins,
 * everyone gets it. The A/B testing happens BEFORE promotion (via the
 * `evaluatePromptVersions()` cron which compares approval rates).
 */
async function pickPromptVariant(
  kind: PromptKind,
  language: string,
): Promise<PromptVariantRow | null> {
  try {
    const rows = await db
      .select()
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.mode, kind),
          eq(promptVersions.language, language),
          eq(promptVersions.isActive, true),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      version: row.version,
      system: row.system,
      isActive: row.isActive,
      language: row.language,
      mode: row.mode,
    };
  } catch {
    // DB error (e.g. table doesn't exist yet) — fall back to base prompt.
    return null;
  }
}

/**
 * Fills template slots in a prompt string.
 *
 * Slots use the `{{slotName}}` syntax (double braces, matching Mustache).
 * Unknown slots are left as-is (not replaced) so they're visible in logs
 * if the prompt author forgets to pass a variable.
 *
 * @example
 *   fillSlots("Hello {{name}}, welcome to {{workspace}}!", { name: "Alice", workspace: "Acme" })
 *   // → "Hello Alice, welcome to Acme!"
 */
function fillSlots(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key]! : match;
  });
}
