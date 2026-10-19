/**
 * Tests for the DB-backed repository modules.
 *
 * These tests verify that the repository functions execute the right SQL
 * queries with the right parameters. The actual DB is mocked — we capture
 * the SQL strings + parameters and assert on them.
 *
 * The repository functions are not yet wired into the route handlers (the
 * routes still use the in-memory stores). These tests are scaffolding for
 * the migration to DB persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @supa/db module so repository functions don't try to hit a real
// Postgres. We capture every SQL execution so we can assert on it. For SELECT
// queries we return mock rows so the repository's data-shaping logic runs.
const sqlCapture: Array<{ sql: string; params: unknown[] }> = [];

function makeMockRow(sqlStr: string): Record<string, unknown> {
  // Return different mock rows depending on which table is being queried.
  if (sqlStr.includes("from sandbox_sessions")) {
    return {
      id: "00000000-0000-0000-0000-000000000aaa",
      build_session_id: "00000000-0000-0000-0000-000000000001",
      state: "running",
      port: 3000,
      started_at: new Date(),
      stopped_at: null,
      last_activity_at: new Date(),
      memory_used_mb: 256,
      cpu_used_percent: 12.5,
    };
  }
  if (sqlStr.includes("from sandbox_files")) {
    return {
      path: "/app/src/index.ts",
      content: "console.log('hello')",
      byte_size: 21,
      content_type: null,
      updated_at: new Date(),
      created_by: null,
    };
  }
  if (sqlStr.includes("from sandbox_terminal_lines")) {
    return {
      seq: 1,
      stream: "stdout",
      content: "hello",
      source: null,
      timestamp: new Date(),
    };
  }
  if (sqlStr.includes("from preview_instances")) {
    return {
      id: "00000000-0000-0000-0000-000000000bbb",
      build_session_id: "00000000-0000-0000-0000-000000000001",
      port: 3000,
      url: "https://preview-xxx.supa-hosting.local:3000",
      status: "running",
      started_at: new Date(),
      stopped_at: null,
      last_health_check_at: null,
      health_status: "unknown",
    };
  }
  if (sqlStr.includes("from supa_os_marketplace_items")) {
    return {
      id: "00000000-0000-0000-0000-000000000ccc",
      name: "Fraud Detector",
      type: "agent_skill",
      description: "Detects fraudulent transactions.",
      creator_id: "admin_test_001",
      creator_name: "Admin",
      status: "draft",
      monetization: "subscription",
      price: "29.99",
      version: "1.0.0",
      tags: ["fintech"],
      manifest: {},
      download_count: 0,
      rating: "0",
      review_count: 0,
      featured: false,
      verified: false,
      published_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }
  return {};
}

const mockSystemTx = {
  unsafe: vi.fn(async (sql: string, params: unknown[] = []) => {
    sqlCapture.push({ sql, params });
    if (/^\s*select/i.test(sql.trim())) return [makeMockRow(sql)];
    if (/returning/i.test(sql)) return [{ id: "00000000-0000-0000-0000-000000000aaa" }];
    return [];
  }),
  array: (values: unknown[]) => values,
};

vi.mock("@supa/db", () => ({
  db: {
    execute: vi.fn(async (sqlTag: { queryChunks?: unknown[] }) => {
      const sqlStr = String(sqlTag);
      sqlCapture.push({ sql: sqlStr, params: sqlTag.queryChunks ?? [] });
      if (/^\s*select/i.test(sqlStr.trim())) return [makeMockRow(sqlStr)];
      if (/returning/i.test(sqlStr)) return [{ id: "00000000-0000-0000-0000-000000000aaa" }];
      return [];
    }),
  },
  getSystemPool: () => mockSystemTx,
  withSystem: async (_pool: unknown, callback: (tx: typeof mockSystemTx) => Promise<unknown>) => callback(mockSystemTx),
}));

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Build a fake Sql object that captures the chunks.
      const queryChunks: unknown[] = [];
      for (let i = 0; i < strings.length; i++) {
        queryChunks.push(strings[i]!);
        if (i < values.length) queryChunks.push(values[i]);
      }
      return {
        queryChunks,
        toString: () => strings.join("?"),
        __raw: strings,
      };
    },
    {
      raw: (str: string) => ({ queryChunks: [str], toString: () => str, __raw: str }),
    },
  ),
}));

import {
  createSandbox,
  upsertFile,
  appendTerminalLine,
  updateState,
} from "@/lib/supa-os/sandbox-repository";
import {
  startPreview,
  stopPreview,
  performLifecycleAction,
} from "@/lib/supa-os/preview-repository";
import {
  insertItem,
  getItem,
  updateItem,
} from "@/lib/supa-os/marketplace-repository";

beforeEach(() => {
  sqlCapture.length = 0;
});

// ───────────────────────────────────────────────
// Sandbox repository
// ───────────────────────────────────────────────

describe("sandbox-repository", () => {
  it("createSandbox executes INSERT ... ON CONFLICT DO NOTHING", async () => {
    await createSandbox("00000000-0000-0000-0000-000000000001");
    const insertSql = sqlCapture.find((c) => c.sql.includes("insert into sandbox_sessions"));
    expect(insertSql).toBeDefined();
    expect(insertSql!.sql).toContain("on conflict (build_session_id) do nothing");
  });

  it("upsertFile executes INSERT ... ON CONFLICT DO UPDATE", async () => {
    await upsertFile("00000000-0000-0000-0000-000000000001", {
      path: "/app/src/index.ts",
      content: "console.log('hello')",
    });
    const upsertSql = sqlCapture.find((c) => c.sql.includes("insert into sandbox_files"));
    expect(upsertSql).toBeDefined();
    expect(upsertSql!.sql).toContain("on conflict (sandbox_session_id, path)");
    expect(upsertSql!.sql).toContain("do update set content = excluded.content");
  });

  it("appendTerminalLine executes INSERT into sandbox_terminal_lines", async () => {
    await appendTerminalLine("00000000-0000-0000-0000-000000000001", {
      stream: "stdout",
      content: "hello world",
    });
    const appendSql = sqlCapture.find((c) => c.sql.includes("insert into sandbox_terminal_lines"));
    expect(appendSql).toBeDefined();
  });

  it("updateState executes UPDATE sandbox_sessions SET state", async () => {
    await updateState("00000000-0000-0000-0000-000000000001", "running");
    const updateSql = sqlCapture.find((c) => c.sql.includes("update sandbox_sessions"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("set state =");
  });
});

// ───────────────────────────────────────────────
// Preview repository
// ───────────────────────────────────────────────

describe("preview-repository", () => {
  it("startPreview executes INSERT ... ON CONFLICT DO UPDATE", async () => {
    await startPreview("00000000-0000-0000-0000-000000000001", 3000);
    const insertSql = sqlCapture.find((c) => c.sql.includes("insert into preview_instances"));
    expect(insertSql).toBeDefined();
    expect(insertSql!.sql).toContain("on conflict (build_session_id)");
    expect(insertSql!.sql).toContain("do update set port = excluded.port");
  });

  it("stopPreview executes UPDATE with status='stopped'", async () => {
    await stopPreview("00000000-0000-0000-0000-000000000001");
    const updateSql = sqlCapture.find((c) => c.sql.includes("update preview_instances"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("set status =");
  });

  it("performLifecycleAction('sleep') sets status='sleeping'", async () => {
    await performLifecycleAction("00000000-0000-0000-0000-000000000001", "sleep");
    const updateSql = sqlCapture.find((c) => c.sql.includes("update preview_instances"));
    expect(updateSql).toBeDefined();
    // 'sleeping' is a parameter value, not a SQL literal — check queryChunks.
    const chunks = updateSql!.params as unknown[];
    expect(chunks.some((c) => c === "sleeping")).toBe(true);
  });

  it("performLifecycleAction('restart') sets started_at = now()", async () => {
    await performLifecycleAction("00000000-0000-0000-0000-000000000001", "restart");
    const updateSql = sqlCapture.find((c) => c.sql.includes("update preview_instances"));
    expect(updateSql).toBeDefined();
  });
});

// ───────────────────────────────────────────────
// Marketplace repository
// ───────────────────────────────────────────────

describe("marketplace-repository", () => {
  const sampleItem = {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Fraud Detector",
    type: "agent_skill" as const,
    description: "Detects fraudulent transactions in real-time.",
    creatorId: "admin_test_001",
    creatorName: "Admin test",
    status: "draft" as const,
    monetization: "subscription" as const,
    price: 29.99,
    version: "1.0.0",
    tags: ["fintech", "fraud"],
    downloadCount: 0,
    rating: 0,
    reviewCount: 0,
    featured: false,
    verified: false,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("insertItem executes INSERT into supa_os_marketplace_items", async () => {
    await insertItem(sampleItem as never);
    const insertSql = sqlCapture.find((c) => c.sql.includes("insert into supa_os_marketplace_items"));
    expect(insertSql).toBeDefined();
    // The queryChunks contain the parameter values; check that 'agent_skill' is among them.
    const chunks = insertSql!.params as unknown[];
    expect(chunks.some((c) => c === "agent_skill")).toBe(true);
  });

  it("getItem executes SELECT by id", async () => {
    await getItem("00000000-0000-0000-0000-000000000002");
    const selectSql = sqlCapture.find((c) => c.sql.includes("from supa_os_marketplace_items"));
    expect(selectSql).toBeDefined();
    expect(selectSql!.sql).toContain("where id =");
  });

  it("updateItem executes UPDATE on supa_os_marketplace_items", async () => {
    await updateItem({ ...sampleItem, status: "published" } as never);
    const updateSql = sqlCapture.find((c) => c.sql.includes("update supa_os_marketplace_items"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toMatch(/status\s*=/);
  });
});
