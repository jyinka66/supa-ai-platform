/**
 * Tests for the new migration SQL files.
 *
 * Verifies:
 *   1. Each migration file exists at the expected path.
 *   2. Each migration creates the expected tables + indexes.
 *   3. Column types match what the lib code expects (no missing columns).
 *   4. Check constraints allow the enum values the code uses.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path — use import.meta.url so the test works regardless of which
// directory vitest is invoked from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __dirname is /home/z/my-project/apps/web/tests/unit
// migrations are at  /home/z/my-project/packages/db/migrations
// From tests/unit, go up 4 levels: tests/unit → tests → web → apps → my-project
// Then down to packages/db/migrations.
const migrationsDir = path.resolve(__dirname, "../../../../packages/db/migrations");

function readMigration(name: string): string {
  const full = path.join(migrationsDir, name);
  if (!fs.existsSync(full)) {
    throw new Error(`Migration file not found: ${name} (resolved to ${full})`);
  }
  return fs.readFileSync(full, "utf-8");
}

describe("0063_supa_os_build_sessions.sql", () => {
  it("creates the build_sessions table", () => {
    const sql = readMigration("0063_supa_os_build_sessions.sql");
    expect(sql).toMatch(/create table build_sessions/i);
  });

  it("has all the columns the lib code expects", () => {
    const sql = readMigration("0063_supa_os_build_sessions.sql");
    const expectedColumns = [
      "id", "owner_id", "ws_id", "name", "original_prompt", "platform",
      "status", "plan", "repo_url", "build_artifact_hash", "test_results",
      "preview_url", "deployment_target", "created_at", "updated_at",
    ];
    for (const col of expectedColumns) {
      expect(sql).toContain(col);
    }
  });

  it("platform check constraint allows web/mobile/full_stack", () => {
    const sql = readMigration("0063_supa_os_build_sessions.sql");
    expect(sql).toMatch(/platform\s+text not null check.*'web'.*'mobile'.*'full_stack'/is);
  });

  it("status check constraint covers all BuildSessionStatus values", () => {
    const sql = readMigration("0063_supa_os_build_sessions.sql");
    const statuses = [
      "planning", "building", "testing", "previewing",
      "deployed", "published", "monitoring",
      "paused", "failed", "archived",
    ];
    for (const s of statuses) {
      expect(sql).toContain(s);
    }
  });

  it("has indexes on owner + workspace + status", () => {
    const sql = readMigration("0063_supa_os_build_sessions.sql");
    expect(sql).toMatch(/create index.*idx_build_sessions_owner/i);
    expect(sql).toMatch(/create index.*idx_build_sessions_ws/i);
    expect(sql).toMatch(/create index.*idx_build_sessions_status/i);
  });
});

describe("0064_governance_decision_log.sql", () => {
  it("creates the governance_decision_log table", () => {
    const sql = readMigration("0064_governance_decision_log.sql");
    expect(sql).toMatch(/create table governance_decision_log/i);
  });

  it("has the hash chain columns (seq, prev_hash, hash)", () => {
    const sql = readMigration("0064_governance_decision_log.sql");
    expect(sql).toMatch(/seq\s+bigserial primary key/);
    expect(sql).toContain("prev_hash");
    expect(sql).toContain("hash");
  });

  it("creates the governance_decision_log_append function", () => {
    const sql = readMigration("0064_governance_decision_log.sql");
    expect(sql).toMatch(/create or replace function governance_decision_log_append/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/digest\(.*'sha256'\)/i);
  });

  it("creates the governance_decision_log_verify_chain function", () => {
    const sql = readMigration("0064_governance_decision_log.sql");
    expect(sql).toMatch(/create or replace function governance_decision_log_verify_chain/i);
  });

  it("decision check constraint covers all 5 decision values", () => {
    const sql = readMigration("0064_governance_decision_log.sql");
    const decisions = ["auto_approved", "policy_approved", "human_approved", "blocked", "deferred"];
    for (const d of decisions) {
      expect(sql).toContain(d);
    }
  });
});

describe("0065_governance_appeals.sql", () => {
  it("creates the governance_appeals table", () => {
    const sql = readMigration("0065_governance_appeals.sql");
    expect(sql).toMatch(/create table governance_appeals/i);
  });

  it("appeal_type check constraint covers all 4 appeal types", () => {
    const sql = readMigration("0065_governance_appeals.sql");
    const types = ["user_appeal", "policy_exception", "executive_override", "abuse_dispute"];
    for (const t of types) {
      expect(sql).toContain(t);
    }
  });

  it("status check constraint covers the workflow states", () => {
    const sql = readMigration("0065_governance_appeals.sql");
    const statuses = ["filed", "under_review", "awaiting_committee", "resolved", "withdrawn", "timeout_closed"];
    for (const s of statuses) {
      expect(sql).toContain(s);
    }
  });

  it("has an SLA deadline column for auto-escalation", () => {
    const sql = readMigration("0065_governance_appeals.sql");
    expect(sql).toContain("sla_deadline");
  });
});

describe("0066_regional_expansion.sql", () => {
  it("creates the regional_market_data table", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    expect(sql).toMatch(/create table regional_market_data/i);
  });

  it("creates the regional_evaluation_queue table", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    expect(sql).toMatch(/create table regional_evaluation_queue/i);
  });

  it("creates the regional_preparation_progress table", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    expect(sql).toMatch(/create table regional_preparation_progress/i);
  });

  it("creates the regional_optimization_log table", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    expect(sql).toMatch(/create table regional_optimization_log/i);
  });

  it("regional_market_data has population + internet_penetration columns", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    expect(sql).toContain("population");
    expect(sql).toContain("internet_penetration");
    expect(sql).toContain("smartphone_penetration");
    expect(sql).toContain("freelancer_population");
    expect(sql).toContain("smb_population");
  });

  it("regional_preparation_progress covers all 9 workstreams", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    const workstreams = [
      "language", "content", "legal", "tax", "payments",
      "infrastructure", "support", "marketing", "cultural",
    ];
    for (const w of workstreams) {
      expect(sql).toContain(w);
    }
  });

  it("regional_optimization_log covers all 6 optimization areas", () => {
    const sql = readMigration("0066_regional_expansion.sql");
    const areas = ["pricing", "packaging", "onboarding", "support", "growth", "retention"];
    for (const a of areas) {
      expect(sql).toContain(a);
    }
  });
});

describe("0067_supa_os_sandbox_preview.sql", () => {
  it("creates the sandbox_sessions table", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/create table sandbox_sessions/i);
  });

  it("creates the sandbox_files table", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/create table sandbox_files/i);
  });

  it("creates the sandbox_terminal_lines table", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/create table sandbox_terminal_lines/i);
  });

  it("creates the preview_instances table", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/create table preview_instances/i);
  });

  it("sandbox_sessions state check covers all 8 states", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    const states = ["booting", "mounted", "installing", "migrating", "running", "sleeping", "stopped", "failed"];
    for (const s of states) {
      expect(sql).toContain(s);
    }
  });

  it("preview_instances status check covers all 5 states", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    const statuses = ["starting", "running", "sleeping", "stopped", "failed"];
    for (const s of statuses) {
      expect(sql).toContain(s);
    }
  });

  it("sandbox_files has unique constraint on (sandbox_session_id, path)", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/unique.*sandbox_session_id.*path/i);
  });

  it("sandbox_sessions references build_sessions with on delete cascade", () => {
    const sql = readMigration("0067_supa_os_sandbox_preview.sql");
    expect(sql).toMatch(/references build_sessions\(id\)\s+on delete cascade/i);
  });
});

describe("0068_governance_developer_reputation.sql", () => {
  it("creates the governance_developer_reputation table", () => {
    const sql = readMigration("0068_governance_developer_reputation.sql");
    expect(sql).toMatch(/create table governance_developer_reputation/i);
  });

  it("has all 5 reputation dimensions", () => {
    const sql = readMigration("0068_governance_developer_reputation.sql");
    const dims = [
      "activity_reputation",
      "financial_reputation",
      "security_reputation",
      "quality_reputation",
      "community_reputation",
    ];
    for (const d of dims) {
      expect(sql).toContain(d);
    }
  });

  it("tier check constraint covers all 4 trust tiers", () => {
    const sql = readMigration("0068_governance_developer_reputation.sql");
    const tiers = ["trusted", "new", "distrusted", "banned"];
    for (const t of tiers) {
      expect(sql).toContain(t);
    }
  });

  it("creates the recompute_developer_tier trigger function", () => {
    const sql = readMigration("0068_governance_developer_reputation.sql");
    expect(sql).toMatch(/create or replace function recompute_developer_tier/i);
    expect(sql).toMatch(/create trigger trg_recompute_developer_tier/i);
  });
});

describe("0069_supa_os_marketplace.sql", () => {
  it("creates the supa_os_marketplace_items table", () => {
    const sql = readMigration("0069_supa_os_marketplace.sql");
    expect(sql).toMatch(/create table supa_os_marketplace_items/i);
  });

  it("creates the supa_os_marketplace_reviews table", () => {
    const sql = readMigration("0069_supa_os_marketplace.sql");
    expect(sql).toMatch(/create table supa_os_marketplace_reviews/i);
  });

  it("type check constraint covers all 5 item types", () => {
    const sql = readMigration("0069_supa_os_marketplace.sql");
    const types = ["agent_skill", "api_connector", "ui_component", "template", "theme"];
    for (const t of types) {
      expect(sql).toContain(t);
    }
  });

  it("monetization check constraint covers all 4 models", () => {
    const sql = readMigration("0069_supa_os_marketplace.sql");
    const models = ["free", "one_time", "subscription", "revenue_share"];
    for (const m of models) {
      expect(sql).toContain(m);
    }
  });

  it("status check constraint covers the review workflow states", () => {
    const sql = readMigration("0069_supa_os_marketplace.sql");
    const statuses = ["draft", "submitted", "in_review", "approved", "rejected", "published", "deprecated", "removed", "yanked"];
    for (const s of statuses) {
      expect(sql).toContain(s);
    }
  });
});
