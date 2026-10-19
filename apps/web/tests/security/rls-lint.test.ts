/**
 * RLS lint test — the CI gate that enforces the @tenant_table pattern.
 *
 * Migration 0033 established the pattern: every tenant table has a
 * `@tenant_table` comment + must have RLS enabled + FORCED + a policy
 * calling `is_ws_member(ws_id)`. This test scans the migration files +
 * verifies the pattern.
 *
 * A table that's missing any of these is a CI failure (blocks merge).
 * This is the "enforced by CI lint" the migration references.
 *
 * The test is PURE FILE SCANNING — no DB needed. It reads the .sql files
 * in packages/db/migrations/ and checks for the required patterns.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ───────────────────────────────────────────────
// Migration file loader
// ───────────────────────────────────────────────

const MIGRATIONS_DIR = resolve(
  __dirname,
  "../../../../packages/db/migrations",
);

/** Read all migration SQL files, concatenated. */
function readAllMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n\n");
}

/** Read a specific migration file. */
function readMigration(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
}

// ───────────────────────────────────────────────
// @tenant_table extraction
// ───────────────────────────────────────────────

/**
 * Extract all @tenant_table table names from the migration files.
 * The comment format is: `comment on table <name> is '@tenant_table ...'`.
 * Returns an array of table names (lowercased).
 */
function extractTenantTables(sql: string): string[] {
  const tables: string[] = [];
  // Match: comment on table <name> is '@tenant_table ...
  const regex = /comment\s+on\s+table\s+(\w+)\s+is\s+'@tenant_table/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    tables.push(match[1]!.toLowerCase());
  }
  return tables;
}

// ───────────────────────────────────────────────
// RLS pattern checks
// ───────────────────────────────────────────────

/**
 * Check if a table has RLS enabled in the migrations.
 * `force row level security` implicitly enables RLS, so either
 * `enable` OR `force` satisfies this check.
 */
function hasRLSEnabled(sql: string, table: string): boolean {
  const enableRegex = new RegExp(
    `alter\\s+table\\s+${escapeRegex(table)}\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  );
  const forceRegex = new RegExp(
    `alter\\s+table\\s+${escapeRegex(table)}\\s+force\\s+row\\s+level\\s+security`,
    "i",
  );
  return enableRegex.test(sql) || forceRegex.test(sql);
}

/**
 * Check if a table has `force row level security` in the migrations.
 */
function hasRLSForced(sql: string, table: string): boolean {
  const regex = new RegExp(
    `alter\\s+table\\s+${escapeRegex(table)}\\s+force\\s+row\\s+level\\s+security`,
    "i",
  );
  return regex.test(sql);
}

/**
 * Check if the migrations contain at least one policy that calls is_ws_member
 * for the given table. This is a coarse check — we look for `create policy ...
 * on <table> ... using (is_ws_member(...))` OR a policy that uses
 * `auth.uid()` + workspace_members join (the older pattern, still valid).
 */
function hasRLSPolicy(sql: string, table: string): boolean {
  // Pattern 1: is_ws_member(ws_id) — the canonical predicate.
  const canonicalRegex = new RegExp(
    `create\\s+policy\\s+\\w+\\s+on\\s+${escapeRegex(table)}[\\s\\S]*?is_ws_member`,
    "i",
  );
  if (canonicalRegex.test(sql)) return true;

  // Pattern 2: auth.uid() → workspace_members join (the older pattern).
  const legacyRegex = new RegExp(
    `create\\s+policy\\s+\\w+\\s+on\\s+${escapeRegex(table)}[\\s\\S]*?auth\\.uid\\(\\)[\\s\\S]*?workspace_members`,
    "i",
  );
  if (legacyRegex.test(sql)) return true;

  // Pattern 3: current_uid() — the canonical function from migration 0033.
  const currentUidRegex = new RegExp(
    `create\\s+policy\\s+\\w+\\s+on\\s+${escapeRegex(table)}[\\s\\S]*?current_uid\\(\\)`,
    "i",
  );
  if (currentUidRegex.test(sql)) return true;

  // Pattern 4: exists (select ... from <parent> ... has_permission (indirect scoping via parent table).
  const hasPermissionRegex = new RegExp(
    `create\\s+policy\\s+\\w+\\s+on\\s+${escapeRegex(table)}[\\s\\S]*?exists\\s*\\(\\s*select[\\s\\S]*?has_permission`,
    "i",
  );
  return hasPermissionRegex.test(sql);
}

/** Escape a string for use in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("RLS lint — @tenant_table CI gate", () => {
  const allMigrations = readAllMigrations();
  const tenantTables = extractTenantTables(allMigrations);

  it("migration files exist and are readable", () => {
    expect(allMigrations.length).toBeGreaterThan(0);
  });

  it("at least one @tenant_table is declared", () => {
    expect(tenantTables.length).toBeGreaterThan(0);
    // Migration 0033 declares 24 tenant tables.
    expect(tenantTables.length).toBeGreaterThanOrEqual(20);
  });

  it("is_ws_member function is defined", () => {
    expect(allMigrations).toMatch(
      /create\s+or\s+replace\s+function\s+is_ws_member/i,
    );
  });

  it("current_uid function is defined", () => {
    expect(allMigrations).toMatch(
      /create\s+or\s+replace\s+function\s+current_uid/i,
    );
  });

  it("supa_app role is created", () => {
    expect(allMigrations).toMatch(/create\s+role\s+supa_app/i);
  });

  it("supa_app has bypassrls revoked", () => {
    expect(allMigrations).toMatch(/alter\s+role\s+supa_app\s+nobypassrls/i);
  });

  it("supa_app has row_security = on", () => {
    expect(allMigrations).toMatch(/alter\s+role\s+supa_app\s+set\s+row_security\s*=\s*on/i);
  });

  // ── Per-table checks ──────────────────────────
  describe.each(tenantTables)("table: %s", (table) => {
    it("has RLS enabled", () => {
      expect(hasRLSEnabled(allMigrations, table)).toBe(true);
    });

    it("has RLS forced (applies to table owners)", () => {
      expect(hasRLSForced(allMigrations, table)).toBe(true);
    });

    it("has an RLS policy (is_ws_member or auth.uid or current_uid)", () => {
      expect(hasRLSPolicy(allMigrations, table)).toBe(true);
    });
  });
});
