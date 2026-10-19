// ─────────────────────────────────────────────────────────────
// Schema migrations. Rule: doc.schemaVersion < CURRENT → migrate forward,
// one step at a time. Every step is pure (doc → doc) and covered by
// golden tests: migrate(oldFixture) must deep-equal newFixture.
// Forward-only. We never "downgrade" — old editors get a read-only
// notice instead of a lossy rewrite.
// ─────────────────────────────────────────────────────────────
import type { DesignDoc } from "./types";

export const CURRENT_SCHEMA_VERSION = 1;

type Migration = { from: number; to: number; fn: (doc: DesignDoc) => DesignDoc };

const MIGRATIONS: Migration[] = [
  // Example of the shape (registered the day we ship v2):
  // { from: 1, to: 2, fn: (doc) => ({
  //     ...doc,
  //     a11y: { issues: [] },            // v2 added a11y block
  //     schemaVersion: 2,
  // })},
];

/**
 * Migrates a raw (possibly old-schema) design document to the current
 * schema version.
 *
 * Rules:
 *   1. Forward-only — never downgrades.
 *   2. One step at a time — each migration transforms v(N) → v(N+1).
 *   3. Every step is pure (doc → doc) — no side effects.
 *   4. If the doc is newer than this build, throws (open read-only instead).
 *   5. If no migration path exists, throws (corrupt or too-old doc).
 *
 * @example
 *   const raw = JSON.parse(savedDocJson);
 *   const doc = migrate(raw); // now at CURRENT_SCHEMA_VERSION
 *
 * @throws if schemaVersion is missing, no migration path exists,
 *         or the doc is newer than the current build.
 */
export function migrate(raw: unknown): DesignDoc {
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw) || typeof raw.schemaVersion !== "number") {
    throw new Error("migrate: missing schemaVersion");
  }
  const doc = raw as DesignDoc;

  let current = doc;

  while (current.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === current.schemaVersion);
    if (!step) {
      throw new Error(
        `migrate: no path from v${String(current.schemaVersion)} → v${String(CURRENT_SCHEMA_VERSION)}`,
      );
    }
    current = step.fn(current);
    if (current.schemaVersion !== step.to) {
      throw new Error(
        `migrate: step v${String(step.from)} did not set schemaVersion=${String(step.to)}`,
      );
    }
  }

  if (current.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error("migrate: doc is newer than this build — open read-only");
  }

  return current;
}

/**
 * Returns true if the raw doc can be migrated to the current schema version.
 * Useful for UI to show "this doc was made with a newer version" before
 * attempting the migration.
 */
export function canMigrate(raw: unknown): boolean {
  try {
    if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw) || typeof raw.schemaVersion !== "number") return false;
    const doc = raw as DesignDoc;
    if (doc.schemaVersion > CURRENT_SCHEMA_VERSION) return false;
    // Check that all migration steps exist.
    let v = doc.schemaVersion;
    while (v < CURRENT_SCHEMA_VERSION) {
      const step = MIGRATIONS.find((m) => m.from === v);
      if (!step) return false;
      v = step.to;
    }
    return true;
  } catch {
    return false;
  }
}
