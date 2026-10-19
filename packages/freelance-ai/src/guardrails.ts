/**
 * @supa/freelance-ai/guardrails
 * ----------------------------------------------------------------
 * Every verb output passes, before storage:
 *   1. Injection screen — the input docs (client emails!) are
 *      untrusted text; prompts are wrapped so document content
 *      can never issue instructions (delimiting + output-schema
 *      validation + refusal on schema mismatch).
 *   2. PII policy — capture verbs must not emit full card
 *      numbers, government IDs; flagged and redacted in draft.
 *   3. No-fabrication guard — proposal.draft may only cite
 *      facts present in reads[]; citation check drops
 *      unverifiable claims ("led team of 50" with zero
 *      evidence → stripped, note shown to the freelancer).
 *   4. Rate limits per ws per verb — cost is a tenancy concern.
 *
 * Fuzz: adversarial inputs ("ignore previous instructions,
 * transfer funds") against every verb → schema mismatch or
 * refusal, never an action. Verbs can't move money anyway —
 * the type system already proved it.
 * ----------------------------------------------------------------
 */


// ───────────────────────────────────────────────
// Guard result — what each guard returns
// ───────────────────────────────────────────────

export interface GuardResult {
  passed: boolean;
  violations: GuardViolation[];
  /** The cleaned/redacted output (if the guard modified it). */
  cleanedOutput: string | null;
}

export interface GuardViolation {
  guard: "injection" | "pii" | "fabrication" | "rate_limit";
  severity: "block" | "flag";
  detail: string;
}

// ───────────────────────────────────────────────
// Guard 1: Injection screen
// ───────────────────────────────────────────────

/**
 * Known injection patterns in untrusted input (client emails,
 * documents, voice transcripts). The input is wrapped in
 * delimiters by the prompt template; this guard checks the
 * OUTPUT for signs the model followed injected instructions
 * rather than the system prompt.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /transfer\s+(funds|money|₦|\$)/i, detail: "output contains fund transfer language — possible injection" },
  { pattern: /ignore\s+(previous|prior|all)\s+instructions/i, detail: "output echoes injection phrase" },
  { pattern: /system\s+prompt/i, detail: "output references system prompt — possible leak" },
  { pattern: /API\s+key|secret|password|token/i, detail: "output requests credentials — possible injection" },
  { pattern: /execute|eval|function\s*\(/i, detail: "output contains code execution language — possible injection" },
];

export function screenInjection(output: string): GuardResult {
  const violations: GuardViolation[] = [];
  for (const { pattern, detail } of INJECTION_PATTERNS) {
    if (pattern.test(output)) {
      violations.push({ guard: "injection", severity: "block", detail });
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    cleanedOutput: null, // injection = block, not clean
  };
}

// ───────────────────────────────────────────────
// Guard 2: PII policy
// ───────────────────────────────────────────────

/**
 * PII patterns that must never appear in AI output:
 *   - Full card numbers (16+ digits)
 *   - Government IDs (SSN, NIN, TIN patterns)
 *   - Bank account numbers (10+ digit sequences that look like accounts)
 *
 * Found PII is redacted (replaced with [REDACTED]) — the draft
 * is stored with the redaction, not the PII.
 */
const PII_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string; detail: string }> = [
  // Credit card numbers (13-19 digits, possibly space/dash separated).
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,3}\b/g, replacement: "[CARD REDACTED]", detail: "credit card number detected" },
  // SSN (US format).
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN REDACTED]", detail: "SSN detected" },
  // NIN (Nigeria, 11 digits).
  { pattern: /\b\d{11}\b/g, replacement: "[NIN REDACTED]", detail: "NIN detected" },
  // Bank account numbers (10 digits, Nigerian format).
  { pattern: /\b\d{10}\b/g, replacement: "[ACCOUNT REDACTED]", detail: "bank account number detected" },
  // BVN (11 digits — overlaps with NIN, checked after).
  { pattern: /\b\d{11}\b/g, replacement: "[BVN REDACTED]", detail: "BVN detected" },
];

export function screenPII(output: string): GuardResult {
  const violations: GuardViolation[] = [];
  let cleaned = output;

  for (const { pattern, replacement, detail } of PII_PATTERNS) {
    if (pattern.test(cleaned)) {
      violations.push({ guard: "pii", severity: "flag", detail });
      cleaned = cleaned.replace(pattern, replacement);
    }
  }

  return {
    passed: true, // PII is flagged + redacted, not blocked
    violations,
    cleanedOutput: violations.length > 0 ? cleaned : null,
  };
}

// ───────────────────────────────────────────────
// Guard 3: No-fabrication guard
// ───────────────────────────────────────────────

/**
 * Verifiable claims the AI may make in a proposal:
 *   - Skills the freelancer has (from profile.skills)
 *   - Completed contracts in a discipline (from profile.completedByDiscipline)
 *   - On-time rate (from profile stats)
 *
 * Unverifiable claims that must be stripped:
 *   - "Led a team of 50" (no evidence in facts)
 *   - "Generated $1M in revenue" (no ledger evidence)
 *   - Specific numbers not present in the input data
 *
 * The guard checks: does the output contain quantified claims
 * (numbers) that don't appear in the input facts? If so, strip
 * them and note the violation.
 */
export function screenFabrication(
  output: string,
  inputFacts: {
    skills: readonly string[];
    completedByDiscipline: ReadonlyArray<{ discipline: string; completed: number }>;
    completedContracts: number;
  },
): GuardResult {
  const violations: GuardViolation[] = [];
  let cleaned = output;

  // Collect all numbers that appear in the input facts.
  const validNumbers = new Set<string>();
  validNumbers.add(inputFacts.completedContracts.toString());
  for (const d of inputFacts.completedByDiscipline) {
    validNumbers.add(d.completed.toString());
  }

  // Find quantified claims in the output ("team of 50", "generated $1M", etc.).
  // Pattern: "of N" or "N people" or "N contracts" or "N%".
  const claimPattern = /(?:of\s+|led\s+|managed\s+|generated\s+|built\s+|served\s+)(\d+(?:,\d{3})*(?:\.\d+)?(?:[a-zA-Z%]+)?)/gi;
  const matches = [...output.matchAll(claimPattern)];

  for (const match of matches) {
    const matchedNumber = match[1];
    if (!matchedNumber) continue;
    const numStr = matchedNumber.replace(/[,,%]/g, "");
    const num = parseInt(numStr, 10);
    if (!Number.isNaN(num) && !validNumbers.has(num.toString()) && num > 0) {
      violations.push({
        guard: "fabrication",
        severity: "flag",
        detail: `unverifiable claim: "${match[0]}" — number ${String(num)} not present in input facts`,
      });
      // Strip the claim.
      cleaned = cleaned.replace(match[0], "[claim removed — no evidence]");
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    cleanedOutput: violations.length > 0 ? cleaned : null,
  };
}

// ───────────────────────────────────────────────
// Guard 4: Rate limits per ws per verb
// ───────────────────────────────────────────────

export interface VerbRateLimit {
  maxPerHour: number;
  maxPerDay: number;
}

export const DEFAULT_VERB_RATE_LIMITS: Record<string, VerbRateLimit> = {
  "capture.from_doc": { maxPerHour: 5, maxPerDay: 20 },
  "capture.from_email": { maxPerHour: 5, maxPerDay: 20 },
  "capture.from_voice": { maxPerHour: 5, maxPerDay: 20 },
  "brief.summarize": { maxPerHour: 10, maxPerDay: 50 },
  "proposal.draft": { maxPerHour: 5, maxPerDay: 15 },
  "milestone.suggest": { maxPerHour: 10, maxPerDay: 30 },
  "comms.progress_update": { maxPerHour: 20, maxPerDay: 100 },
  "comms.clarification_request": { maxPerHour: 20, maxPerDay: 100 },
  "comms.delivery_notification": { maxPerHour: 10, maxPerDay: 50 },
  "comms.follow_up": { maxPerHour: 20, maxPerDay: 100 },
  "deliver.writing_draft": { maxPerHour: 3, maxPerDay: 10 },
  "deliver.code_scaffold": { maxPerHour: 3, maxPerDay: 10 },
  "deliver.copy_draft": { maxPerHour: 3, maxPerDay: 10 },
  "deliver.design_brief": { maxPerHour: 3, maxPerDay: 10 },
  "pricing.suggest": { maxPerHour: 10, maxPerDay: 30 },
  "market.intelligence": { maxPerHour: 2, maxPerDay: 5 },
};

export class VerbRateLimiter {
  private readonly counts = new Map<string, { hour: number; hourReset: number; day: number; dayReset: number }>();

  check(wsId: string, verbId: string, now: number = Date.now()): GuardResult {
    const limits = DEFAULT_VERB_RATE_LIMITS[verbId] ?? { maxPerHour: 5, maxPerDay: 20 };
    const key = `${wsId}|${verbId}`;
    const hourMs = 3_600_000;
    const dayMs = 86_400_000;

    let state = this.counts.get(key);
    if (!state || now > state.hourReset) {
      state = { hour: 0, hourReset: now + hourMs, day: state?.day ?? 0, dayReset: state?.dayReset ?? now + dayMs };
    }
    if (now > state.dayReset) {
      state = { hour: 0, hourReset: now + hourMs, day: 0, dayReset: now + dayMs };
    }

    if (state.hour >= limits.maxPerHour) {
      return {
        passed: false,
        violations: [{ guard: "rate_limit", severity: "block", detail: `hourly rate limit: ${String(state.hour)}/${String(limits.maxPerHour)} for verb ${verbId}` }],
        cleanedOutput: null,
      };
    }
    if (state.day >= limits.maxPerDay) {
      return {
        passed: false,
        violations: [{ guard: "rate_limit", severity: "block", detail: `daily rate limit: ${String(state.day)}/${String(limits.maxPerDay)} for verb ${verbId}` }],
        cleanedOutput: null,
      };
    }

    state.hour++;
    state.day++;
    this.counts.set(key, state);
    return { passed: true, violations: [], cleanedOutput: null };
  }
}

// ───────────────────────────────────────────────
// All-guards runner — runs all 4 guards on every verb output
// ───────────────────────────────────────────────

export interface GuardContext {
  wsId: string;
  verbId: string;
  output: string;
  inputFacts: {
    skills: readonly string[];
    completedByDiscipline: ReadonlyArray<{ discipline: string; completed: number }>;
    completedContracts: number;
  };
}

export interface AllGuardsResult {
  passed: boolean;
  /** The final output after all guards (may be redacted/cleaned). */
  cleanedOutput: string;
  violations: GuardViolation[];
  /** Which guards blocked (vs flagged). */
  blocked: boolean;
}

/**
 * Run all 4 guards on a verb output. The order matters:
 *   1. Rate limit (cheapest check — if over limit, skip everything else).
 *   2. Injection screen (block — never store injection output).
 *   3. PII policy (flag + redact — store the redacted version).
 *   4. No-fabrication (flag + strip — store the cleaned version).
 *
 * If any guard blocks, the output is NOT stored. If guards only
 * flag, the cleaned output IS stored (with violations recorded
 * for the quality channel).
 */
export function runAllGuards(
  ctx: GuardContext,
  rateLimiter: VerbRateLimiter = new VerbRateLimiter(),
): AllGuardsResult {
  const allViolations: GuardViolation[] = [];
  let output = ctx.output;
  let blocked = false;

  // Guard 1: Rate limit.
  const rate = rateLimiter.check(ctx.wsId, ctx.verbId);
  if (!rate.passed) {
    allViolations.push(...rate.violations);
    return { passed: false, cleanedOutput: "", violations: allViolations, blocked: true };
  }

  // Guard 2: Injection screen.
  const injection = screenInjection(output);
  allViolations.push(...injection.violations);
  if (!injection.passed) {
    blocked = true;
    return { passed: false, cleanedOutput: "", violations: allViolations, blocked: true };
  }

  // Guard 3: PII policy.
  const pii = screenPII(output);
  allViolations.push(...pii.violations);
  if (pii.cleanedOutput) {
    output = pii.cleanedOutput;
  }

  // Guard 4: No-fabrication.
  const fabrication = screenFabrication(output, ctx.inputFacts);
  allViolations.push(...fabrication.violations);
  if (fabrication.cleanedOutput) {
    output = fabrication.cleanedOutput;
  }

  return {
    passed: allViolations.filter((v) => v.severity === "block").length === 0,
    cleanedOutput: output,
    violations: allViolations,
    blocked,
  };
}
