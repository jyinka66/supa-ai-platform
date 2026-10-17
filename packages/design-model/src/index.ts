// ─────────────────────────────────────────────────────────────
// @supa/design-model — public API
//
// Everything else in src/ is internal. This file is the single
// export point consumed by apps/design-editor and packages/design-render.
//
// Rules:
//   1. Only export what consumers need.
//   2. Types are exported as `type` (no runtime overhead).
//   3. Internal implementation details (applyInPlace, etc.) are NOT exported.
// ─────────────────────────────────────────────────────────────

// Types — the document model
export * from "./types";

// Commands — the write path (pure data, serializable)
export * from "./commands";

// Apply — immutable command execution (returns { doc, inverse })
export { apply, ApplyError } from "./apply";

// History — undo/redo stacks (session-only, memory-bounded)
export { History } from "./history";

// Validate — strict gate (structural, type, numeric, text, locale, budget)
export { validate, isValid, type ValidationError } from "./validate";

// Migrate — schema version migrations (forward-only, pure)
export { migrate, canMigrate, CURRENT_SCHEMA_VERSION } from "./migrate";

// ID generation — monotonic ULID (deterministic, sortable)
export { newId } from "./id";

// Journal — crash-safe autosave (append-only, snapshot + delta replay)
export type { JournalEntry, JournalStorage, JournalOptions } from "./journal";
export { Journal, InMemoryJournalStorage } from "./journal";
