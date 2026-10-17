// Platform primitives shared across @supa/agents modules.
//
//   hashJson   — stable JSON hash (sorted keys → sha256). Used for tool-arg
//                fingerprints (loop detection + idempotency keys).
//   facts      — append-only activity-fact emitter (the same facts table the
//                money + CRM layers write to; one write path, one source of truth).
//   notify     — sprint-4 matrix channel (email / push / in-app / webhook). Stub
//                until the matrix lands; calls are no-ops so the executor
//                doesn't grow a hard dependency on something that doesn't exist yet.
//   redactPII  — sprint-5 PII redactor (regex-based; sprint 5 will swap to a
//                model-based redactor). Applied at every memory write so PII
//                never lands in the agent_memory table in the clear.

import { createHash } from "node:crypto";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";

/** Stable JSON string — keys sorted at every depth so the hash is order-independent. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** SHA-256 hex of the canonical JSON of `value`. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * A Fact — the shape subscribers receive. Mirrors the `activity_facts` row
 * (id + workspaceId + kind + ref + occurredAt). The `ref` is parsed from the
 * stored `ref_id` JSON string so subscribers don't have to re-parse.
 */
export interface Fact {
  id: string;
  wsId: string;
  kind: string;
  ref: Record<string, unknown>;
  occurredAt: Date;
}

/** Subscriber callback — receives each fact as it's emitted. */
type FactSubscriber = (fact: Fact) => void;

/**
 * Append-only fact emitter. Same facts table the money + CRM layers write to;
 * one write path, one source of truth. A fact is never mutated — corrected by
 * a new fact (the invoice-void rule, applied everywhere).
 *
 * `subscribe(fn)` registers an in-process subscriber. The dispatcher uses this
 * to wire event triggers: facts flow in → matching event triggers fire
 * enqueueRun. Production would swap the in-process Set for a real message bus
 * (Kafka / NATS / PG LISTEN/NOTIFY); the subscribe API is the contract.
 */
const factSubscribers = new Set<FactSubscriber>();

export const facts = {
  async emit(
    wsId: string,
    kind: string,
    ref: Record<string, unknown>,
  ): Promise<void> {
    const [row] = await db.insert(activityFacts).values({
      workspaceId: wsId as any,
      kind,
      refId: JSON.stringify(ref),
      occurredAt: new Date(),
      actor: "system",
      source: "system",
    }).returning({
      id: activityFacts.id,
      kind: activityFacts.kind,
      refId: activityFacts.refId,
      occurredAt: activityFacts.occurredAt,
    });

    // Fan out to in-process subscribers. Best-effort: a subscriber throwing
    // doesn't break the emit (caught + logged; the fact is already persisted).
    if (row) {
      const fact: Fact = {
        id: row.id,
        wsId,
        kind: row.kind,
        ref: ref, // pass the original object (subscribers get parsed ref, not the stored string)
        occurredAt: row.occurredAt,
      };
      for (const sub of factSubscribers) {
        try {
          sub(fact);
        } catch (err) {
          // Subscriber error — log + continue (don't break the emit).
          console.error("[facts.subscribe] subscriber error:", err);
        }
      }
    }
  },

  /**
   * Register a fact subscriber. Returns an unsubscribe function.
   * Used by the dispatcher's `wireTriggers()` to subscribe to the fact stream.
   */
  subscribe(fn: FactSubscriber): () => void {
    factSubscribers.add(fn);
    return () => factSubscribers.delete(fn);
  },
} as const;

/**
 * Sprint-4 notification matrix — email / push / in-app / webhook fan-out.
 * Stubbed until the matrix lands; no-ops so the executor + inbox don't break.
 * The signature mirrors what the real implementation will accept.
 *
 * `payload` is opaque to the caller — the matrix implementation is free to
 * shape it per channel. The approvals inbox passes `{ wsId, kind, approvalId,
 * channels, dedupeKey }` for in_app (and a trimmed shape for email / push);
 * a future real implementation will route to the right provider per channel.
 */
export const notify = {
  async send(_channel: "email" | "push" | "in_app" | "webhook", _payload: unknown): Promise<void> {
    // no-op until sprint 4
  },
} as const;

// ───────────────────────────────────────────────
// redactPII — sprint-5 PII redactor (regex-based; sprint 5 swaps to a model)
// ───────────────────────────────────────────────

/**
 * Redaction rules — applied in order. Each rule has a pattern + replacement.
 * The patterns are intentionally conservative (false-positive is worse than
 * false-negative for a redactor that runs on every memory write — over-
 * redaction mangles the agent's recall; under-redaction leaks PII).
 *
 * Sprint 5 will replace this with a model-based redactor (context-aware, can
 * catch names / addresses / medical / financial contexts that regex misses).
 * The interface (`redactPII(content) → { text, redactedSomething }`) is the
 * contract; the underlying implementation will swap underneath without the
 * memory store needing to change.
 */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const REDACTION_RULES: RedactionRule[] = [
  // Email addresses — RFC-5322 simplified.
  { name: "email", pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, replacement: "[EMAIL]" },
  // Phone numbers — international (E.164) + US-style. 7+ digits to avoid short matches.
  { name: "phone", pattern: /(?<!\w)(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\w)/g, replacement: "[PHONE]" },
  // Credit card numbers — 13-19 digits, optional separators.
  { name: "credit_card", pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: "[CARD]" },
  // SSN (US) — XXX-XX-XXXX or XXXXXXXXX.
  { name: "ssn", pattern: /\b\d{3}-?\d{2}-?\d{4}\b/g, replacement: "[SSN]" },
  // IPv4 addresses (skip version-like patterns: x.y.z where y/z < 100 doesn't match the IPv4 octet rule).
  { name: "ipv4", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g, replacement: "[IP]" },
  // IBAN — country code + 14-32 alphanumeric. Conservative; only matches when prefixed with "IBAN" or two uppercase letters + many digits.
  { name: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, replacement: "[IBAN]" },
];

export interface RedactedText {
  /** The redacted text. */
  text: string;
  /** True if any rule matched. Used to set the `redacted` flag on agent_memory. */
  redactedSomething: boolean;
}

/**
 * Redact PII from a string. Sprint-5 will swap to a model-based redactor; the
 * interface is the contract, so the memory store doesn't need to change.
 */
export function redactPII(content: string): RedactedText {
  let text = content;
  let redactedSomething = false;
  for (const rule of REDACTION_RULES) {
    if (rule.pattern.test(text)) {
      text = text.replace(rule.pattern, rule.replacement);
      redactedSomething = true;
    }
    // Reset lastIndex (some patterns are global; safe to reset always).
    rule.pattern.lastIndex = 0;
  }
  return { text, redactedSomething };
}
