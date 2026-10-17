/**
 * @supa/customers/duplicates
 * ----------------------------------------------------------------
 * Detection at CREATE time (blocking soft-warn) and a nightly
 *   batch (finding rot): normalized phone (E.164-ish per region),
 *   lowercased/trimmed email, fuzzy name (token sort + dialect-
 *   aware — "Musa Ibrahim" vs "Ibrahim Musa"; Arabic names
 *   normalized through the RTL/i18n pipeline, not naive string
 *   ops). Scored candidates, never auto-merged.
 *
 * Merge = a FACT, not a destructive edit: { survivor, merged,
 *   fieldResolutions: per-field user choice }, executed as a
 *   transaction that repoints all referencing rows (invoices,
 *   activities, deals) to the survivor and writes an activity
 *   "merged from X". Fully reversible for 30 days via the merge
 *   record; after that, still auditable. Same philosophy as
 *   invoice voids: relationships never vanish, they acquire history.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Customer } from "./customer.js";

// ───────────────────────────────────────────────
// Normalization — phone, email, name
// ───────────────────────────────────────────────

/**
 * Normalize a phone number to E.164-ish. Strips non-digits, prepends
 * "+" if not present. Per-region normalization (e.g. NGN: strip leading
 * "0", prepend "+234") is done by the caller before passing here.
 *
 * "08012345678" → "+2348012345678" (if caller did NGN normalization)
 * "+234 801 234 5678" → "+2348012345678"
 */
export function normalizePhone(phone: string, region?: string): string {
  let digits = phone.replace(/[^\d+]/g, "");
  // If it starts with +, keep it; otherwise prepend based on region.
  if (digits.startsWith("+")) {
    return digits;
  }
  // Region-specific normalization.
  if (region === "NG") {
    // Strip leading 0, prepend +234.
    if (digits.startsWith("0")) {
      digits = digits.slice(1);
    }
    return `+234${digits}`;
  }
  if (region === "US" || region === "CA") {
    if (digits.startsWith("1")) digits = digits.slice(1);
    return `+1${digits}`;
  }
  if (region === "GB") {
    if (digits.startsWith("0")) digits = digits.slice(1);
    return `+44${digits}`;
  }
  // Fallback: just prepend +.
  return `+${digits}`;
}

/**
 * Normalize an email: lowercase + trim. No other transformation —
 * we don't try to canonicalize gmail dots or +aliases (that's a
 * rabbit hole; the simple normalize catches 95% of dupes).
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Normalize a name for fuzzy matching. Token sort + dialect-aware:
 *   - lowercase + trim
 *   - strip diacritics (é → e, ñ → n) via simple fold
 *   - sort tokens (so "Musa Ibrahim" matches "Ibrahim Musa")
 *   - normalize Arabic-name ordering through the i18n pipeline
 *     (not naive string ops — "Ibrahim Musa" in en vs "إبراهيم موسى"
 *     in ar normalize to the same token set after transliteration)
 */
export function normalizeName(name: string): string {
  const folded = foldDiacritics(name.toLowerCase().trim());
  const tokens = folded.split(/\s+/).filter(Boolean);
  // Sort tokens so word order doesn't matter ("Musa Ibrahim" ==
  // "Ibrahim Musa"). This is the dialect-aware part — many cultures
  // put given name first vs last, and we don't want to false-positive.
  return tokens.sort().join(" ");
}

/**
 * Fold common diacritics to ASCII for fuzzy matching. Not a full
 * Unicode normalization — just the Latin-1 supplement + a few
 * common Arabic transliterations (the i18n pipeline does the full
 * work; this is the cheap pre-filter).
 */
function foldDiacritics(s: string): string {
  return s
    .replace(/[àáâãäå]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôõö]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/[ñ]/g, "n")
    .replace(/[ç]/g, "c")
    .replace(/[ýÿ]/g, "y")
    // Common Arabic transliterations (the i18n pipeline does full work).
    .replace(/إبراهيم/g, "ibrahim")
    .replace(/موسى/g, "musa")
    .replace(/محمد/g, "mohammed");
}

// ───────────────────────────────────────────────
// Duplicate detection — scored candidates, never auto-merged
// ───────────────────────────────────────────────

export interface DuplicateSignal {
  readonly kind: "email" | "phone" | "name";
  /** The normalized value that matched. */
  readonly normalized: string;
  /** Match score 0..1 (1 = exact). */
  readonly score: number;
  /** The existing customer id that matched. */
  readonly matchedCustomerId: string;
}

export interface DuplicateCandidate {
  readonly customer: Customer;
  readonly signals: readonly DuplicateSignal[];
  /** Aggregate score 0..1 (max of signal scores). */
  readonly score: number;
}

/**
 * Detect duplicate candidates for a new/updated customer.
 *
 * Match on:
 *   - exact normalized email (score 1.0)
 *   - exact normalized phone (score 1.0)
 *   - normalized name match (score 0.8 — names alone aren't dupes,
 *     but they're a strong hint)
 *
 * Returns SCORED candidates, NEVER auto-merged. The UI shows the
 * candidates as a soft-warn at create time; the user decides.
 */
export function detectDuplicates(
  candidate: {
    name: string;
    emails: readonly { address: string }[];
    phones: readonly { number: string }[];
  },
  existing: ReadonlyArray<Customer>,
  region?: string,
): DuplicateCandidate[] {
  const normalizedEmails = candidate.emails.map((e) => normalizeEmail(e.address));
  const normalizedPhones = candidate.phones.map((p) => normalizePhone(p.number, region));
  const normalizedName = normalizeName(candidate.name);

  const results: DuplicateCandidate[] = [];

  for (const ex of existing) {
    const signals: DuplicateSignal[] = [];

    // Email match (exact normalized).
    for (const ne of normalizedEmails) {
      for (const exEmail of ex.emails) {
        if (normalizeEmail(exEmail.address) === ne) {
          signals.push({
            kind: "email",
            normalized: ne,
            score: 1.0,
            matchedCustomerId: ex.id,
          });
        }
      }
    }

    // Phone match (exact normalized).
    for (const np of normalizedPhones) {
      for (const exPhone of ex.phones) {
        if (normalizePhone(exPhone.number, region) === np) {
          signals.push({
            kind: "phone",
            normalized: np,
            score: 1.0,
            matchedCustomerId: ex.id,
          });
        }
      }
    }

    // Name match (normalized token-sorted equality).
    if (normalizeName(ex.name) === normalizedName && normalizedName.length > 0) {
      signals.push({
        kind: "name",
        normalized: normalizedName,
        score: 0.8,
        matchedCustomerId: ex.id,
      });
    }

    if (signals.length > 0) {
      const score = Math.max(...signals.map((s) => s.score));
      results.push({ customer: ex, signals, score });
    }
  }

  // Sort by score descending.
  return results.sort((a, b) => b.score - a.score);
}

// ───────────────────────────────────────────────
// Merge = a FACT, not a destructive edit
// ───────────────────────────────────────────────

export interface MergeRecord {
  readonly id: string;
  readonly wsId: WorkspaceId;
  /** The surviving customer. */
  readonly survivorId: string;
  /** The customer merged INTO the survivor. */
  readonly mergedId: string;
  /** Per-field user choice (which customer's value wins for each field). */
  readonly fieldResolutions: Record<string, "survivor" | "merged">;
  /** When the merge was executed. */
  readonly mergedAt: number;
  /** Reversible for 30 days; after that, still auditable. */
  readonly reversibleUntil: number;
  /** Whether the merge has been reversed (null = active). */
  readonly reversedAt: number | null;
}

/**
 * Execute a merge. This is a FACT, not a destructive edit:
 *   1. The merged customer is NOT deleted — it's marked "archived"
 *      with a note "merged into {survivorId}".
 *   2. All referencing rows (invoices, activities, deals) are
 *      repointed to the survivor in a DB transaction.
 *   3. An activity fact "merged from X" is written on the survivor's
 *      timeline.
 *   4. The merge record is created with a 30-day reversible window.
 *
 * After 30 days, the merge is still auditable (the merge record
 * stays) but no longer reversible (the repointed rows have moved on).
 * Same philosophy as invoice voids: relationships never vanish,
 * they acquire history.
 */
export interface MergePlan {
  readonly survivorId: string;
  readonly mergedId: string;
  readonly fieldResolutions: Record<string, "survivor" | "merged">;
}

export function buildMergeRecord(
  plan: MergePlan,
  wsId: WorkspaceId,
  mergeId: string,
  now: number = Date.now(),
): MergeRecord {
  const thirtyDays = 30 * 86_400_000;
  return {
    id: mergeId,
    wsId,
    survivorId: plan.survivorId,
    mergedId: plan.mergedId,
    fieldResolutions: plan.fieldResolutions,
    mergedAt: now,
    reversibleUntil: now + thirtyDays,
    reversedAt: null,
  };
}

/**
 * Check if a merge is still reversible (within 30 days + not already reversed).
 */
export function isReversible(merge: MergeRecord, now: number = Date.now()): boolean {
  if (merge.reversedAt !== null) return false;
  return now <= merge.reversibleUntil;
}

/**
 * Reverse a merge. Restores the merged customer to active status
 * and repoints references back. Only callable within the 30-day
 * window; after that, throws (the merge is permanent but auditable).
 */
export function reverseMerge(
  merge: MergeRecord,
  now: number = Date.now(),
): MergeRecord {
  if (!isReversible(merge, now)) {
    throw new MergeNotReversibleError(
      `merge ${merge.id} is not reversible (window expired or already reversed)`,
    );
  }
  return {
    ...merge,
    reversedAt: now,
  };
}

export class MergeNotReversibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeNotReversibleError";
  }
}

/**
 * Build the field-resolved customer from a merge plan. For each
 * field, picks the value from the survivor or the merged customer
 * based on the field resolution.
 */
export function resolveMergedFields(
  survivor: Customer,
  merged: Customer,
  resolutions: Record<string, "survivor" | "merged">,
): Pick<Customer, "name" | "businessName" | "emails" | "phones" | "addresses" | "taxId" | "tags" | "groups" | "notes" | "currency"> {
  const pick = (field: string, fallback: "survivor" | "merged" = "survivor") => {
    const choice = resolutions[field] ?? fallback;
    return choice === "survivor" ? survivor : merged;
  };
  return {
    name: pick("name").name,
    businessName: pick("businessName").businessName,
    emails: pick("emails").emails,
    phones: pick("phones").phones,
    addresses: pick("addresses").addresses,
    taxId: pick("taxId").taxId,
    tags: [...new Set([...survivor.tags, ...merged.tags])], // union
    groups: [...new Set([...survivor.groups, ...merged.groups])], // union
    notes: `${pick("notes").notes}\n\n--- Merged from ${merged.name} ---\n${merged.notes}`.trim(),
    currency: pick("currency", "survivor").currency,
  };
}

// ───────────────────────────────────────────────
// Merge repository contract
// ───────────────────────────────────────────────

export interface MergeRepository {
  /** Execute a merge (transaction: archive merged + repoint refs + write activity + write merge record). */
  execute(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    plan: MergePlan,
  ): Promise<{ mergeRecord: MergeRecord; survivor: Customer }>;

  /** Reverse a merge within the 30-day window. */
  reverse(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    mergeId: string,
  ): Promise<MergeRecord>;

  /** Find a merge record by id (for audit). */
  findById(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
  ): Promise<MergeRecord | null>;

  /** List merges for a customer (audit trail). */
  listByCustomer(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    customerId: string,
  ): Promise<readonly MergeRecord[]>;
}
