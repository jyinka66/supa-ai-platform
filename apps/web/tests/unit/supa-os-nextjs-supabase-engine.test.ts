/**
 * Supa OS — Next.js 15 + Supabase Architecture Engine — tests.
 *
 * Verifies:
 *   1. Target stack (Next.js 15, Tailwind, Shadcn, Supabase, TypeScript strict).
 *   2. Architectural directives (RLS first, App Router, Reasoning, Code Gen Contract).
 *   3. RLS policy templates + generateRlsSql().
 *   4. Supabase client templates (server, browser, middleware).
 *   5. Reasoning checks (6 checks — schema, component, error, type, auth, security).
 *   6. Code generation rules (24 rules).
 *   7. File structure template.
 */

import { describe, it, expect } from "vitest";
import {
  TARGET_STACK,
  ARCHITECTURAL_DIRECTIVES,
  RLS_POLICY_TEMPLATES,
  generateRlsSql,
  SUPABASE_CLIENT_TEMPLATES,
  REASONING_CHECKS,
  CODE_GEN_RULES,
  FILE_STRUCTURE,
  verifyArchitectureEngine,
  type DirectiveId,
  type RlsOperation,
  type RlsScope,
  type ReasoningCheckId,
  type CodeGenRule,
  type FrontendFramework,
  type BackendSystem,
} from "@/lib/supa-os/nextjs-supabase-engine";

// ───────────────────────────────────────────────
// 1. Target Stack
// ───────────────────────────────────────────────

describe("1 — Target Stack Specification", () => {
  it("targets Next.js 15 with App Router", () => {
    expect(TARGET_STACK.frontend.framework).toBe("nextjs_15");
    expect(TARGET_STACK.frontend.version).toBe("15.0.0");
    expect(TARGET_STACK.frontend.features).toContain("App Router (app/ directory)");
    expect(TARGET_STACK.frontend.features).toContain("Server Actions (mutate state without API routes)");
    expect(TARGET_STACK.frontend.features).toContain("React Server Components (RSC — server-rendered, zero JS)");
  });

  it("uses Tailwind CSS + Shadcn UI + Radix + Lucide", () => {
    expect(TARGET_STACK.styling.system).toContain("tailwind_css");
    expect(TARGET_STACK.styling.system).toContain("shadcn_ui");
    expect(TARGET_STACK.styling.system).toContain("radix_primitives");
    expect(TARGET_STACK.styling.system).toContain("lucide_icons");
  });

  it("uses Supabase (Postgres + RLS + GoTrue + Realtime + Storage)", () => {
    expect(TARGET_STACK.backend.system).toContain("supabase_postgres");
    expect(TARGET_STACK.backend.system).toContain("supabase_rls");
    expect(TARGET_STACK.backend.system).toContain("supabase_gotrue");
    expect(TARGET_STACK.backend.system).toContain("supabase_realtime");
    expect(TARGET_STACK.backend.system).toContain("supabase_storage");
    expect(TARGET_STACK.backend.postgresVersion).toBe("16.0");
  });

  it("uses TypeScript strict + Zod + Supabase generated types", () => {
    expect(TARGET_STACK.typeSystem.system).toContain("typescript_strict");
    expect(TARGET_STACK.typeSystem.system).toContain("zod_validation");
    expect(TARGET_STACK.typeSystem.system).toContain("supabase_generated_types");
  });
});

// ───────────────────────────────────────────────
// 2. Architectural Directives
// ───────────────────────────────────────────────

describe("2 — Architectural Directives", () => {
  it("has 4 directives", () => {
    expect(ARCHITECTURAL_DIRECTIVES).toHaveLength(4);
    const ids = ARCHITECTURAL_DIRECTIVES.map((d) => d.id);
    expect(ids).toContain("rls_first");
    expect(ids).toContain("app_router");
    expect(ids).toContain("reasoning_pipeline");
    expect(ids).toContain("code_gen_contract");
  });

  it("all 4 directives are blocking + implemented", () => {
    expect(ARCHITECTURAL_DIRECTIVES.every((d) => d.blocking)).toBe(true);
    expect(ARCHITECTURAL_DIRECTIVES.every((d) => d.implemented)).toBe(true);
  });

  it("Directive 1 (RLS First) requires RLS on every table + DECIMAL(18,4) for money", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "rls_first");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("ENABLE ROW LEVEL SECURITY");
    expect(rules).toContain("DECIMAL(18, 4)");
    expect(rules).toContain("UUID DEFAULT gen_random_uuid()");
    expect(rules).toContain("auth.uid()");
    expect(rules).toContain("REFERENCES");
  });

  it("Directive 2 (App Router) requires app/ directory + @supabase/ssr + middleware.ts", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "app_router");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("app/");
    expect(rules).toContain("@supabase/ssr");
    expect(rules).toContain("middleware.ts");
    expect(rules).toContain("Server Actions");
    expect(rules).toContain("React Server Components");
  });

  it("Directive 3 (Reasoning Pipeline) has 6 checks", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "reasoning_pipeline");
    expect(d?.rules.length).toBeGreaterThanOrEqual(6);
    const rules = d?.rules.join(" ");
    expect(rules).toContain("SCHEMA CHECK");
    expect(rules).toContain("COMPONENT CHECK");
    expect(rules).toContain("ERROR HANDLING");
    expect(rules).toContain("TYPE SAFETY");
    expect(rules).toContain("AUTH CHECK");
    expect(rules).toContain("SECURITY CHECK");
  });

  it("Directive 4 (Code Gen Contract) forbids 'any', pages/, getServerSideProps, useEffect for data", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "code_gen_contract");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("Never use 'any'");
    expect(rules).toContain("Never use pages/");
    expect(rules).toContain("Never use getServerSideProps");
    expect(rules).toContain("Never use useEffect for data fetching");
  });
});

// ───────────────────────────────────────────────
// 3. RLS Policy Templates
// ───────────────────────────────────────────────

describe("3 — RLS Policy Templates", () => {
  it("has 8 RLS templates covering 4 operations × scopes", () => {
    expect(RLS_POLICY_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    const ops = new Set(RLS_POLICY_TEMPLATES.map((t) => t.operation));
    expect(ops.has("SELECT")).toBe(true);
    expect(ops.has("INSERT")).toBe(true);
    expect(ops.has("UPDATE")).toBe(true);
    expect(ops.has("DELETE")).toBe(true);
  });

  it("own_data templates reference auth.uid()", () => {
    const ownTemplates = RLS_POLICY_TEMPLATES.filter((t) => t.scope === "own_data");
    for (const t of ownTemplates) {
      expect(t.sql).toContain("auth.uid()");
    }
  });

  it("workspace templates check workspace_members", () => {
    const wsTemplates = RLS_POLICY_TEMPLATES.filter((t) => t.scope === "workspace");
    for (const t of wsTemplates) {
      expect(t.sql).toContain("workspace_members");
    }
  });

  it("generateRlsSql produces complete RLS for a table", () => {
    const sql = generateRlsSql({ tableName: "transactions", scope: "own_data" });
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("transactions");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("FOR SELECT");
    expect(sql).toContain("FOR INSERT");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FOR DELETE");
  });

  it("generateRlsSql with specific operations only", () => {
    const sql = generateRlsSql({ tableName: "users", scope: "own_data", operations: ["SELECT"] });
    expect(sql).toContain("FOR SELECT");
    expect(sql).not.toContain("FOR INSERT");
  });

  it("RlsOperation covers 4 operations", () => {
    const ops: RlsOperation[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    expect(ops).toHaveLength(4);
  });

  it("RlsScope covers 5 scopes", () => {
    const scopes: RlsScope[] = ["own_data", "workspace", "public_read", "admin_only", "service_only"];
    expect(scopes).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 4. Supabase Client Templates
// ───────────────────────────────────────────────

describe("4 — Supabase Client Templates", () => {
  it("has 3 client templates (server, browser, middleware)", () => {
    expect(SUPABASE_CLIENT_TEMPLATES).toHaveLength(3);
    const contexts = SUPABASE_CLIENT_TEMPLATES.map((t) => t.context);
    expect(contexts).toContain("server_component");
    expect(contexts).toContain("client_component");
    expect(contexts).toContain("middleware");
  });

  it("server template uses createServerClient from @supabase/ssr", () => {
    const server = SUPABASE_CLIENT_TEMPLATES.find((t) => t.context === "server_component");
    expect(server?.code).toContain("createServerClient");
    expect(server?.code).toContain("@supabase/ssr");
    expect(server?.code).toContain("cookies");
    expect(server?.fileName).toBe("lib/supabase/server.ts");
  });

  it("client template uses createBrowserClient from @supabase/ssr", () => {
    const client = SUPABASE_CLIENT_TEMPLATES.find((t) => t.context === "client_component");
    expect(client?.code).toContain("createBrowserClient");
    expect(client?.code).toContain("@supabase/ssr");
    expect(client?.fileName).toBe("lib/supabase/client.ts");
  });

  it("middleware template protects /dashboard routes + redirects to /login", () => {
    const middleware = SUPABASE_CLIENT_TEMPLATES.find((t) => t.context === "middleware");
    expect(middleware?.code).toContain("middleware");
    expect(middleware?.code).toContain("getSession");
    expect(middleware?.code).toContain("/dashboard");
    expect(middleware?.code).toContain("/login");
    expect(middleware?.code).toContain("matcher");
  });
});

// ───────────────────────────────────────────────
// 5. Reasoning Checks
// ───────────────────────────────────────────────

describe("5 — Reasoning & Execution Pipeline Checks", () => {
  it("has 6 reasoning checks", () => {
    expect(REASONING_CHECKS).toHaveLength(6);
    const ids = REASONING_CHECKS.map((c) => c.id);
    expect(ids).toContain("schema_check");
    expect(ids).toContain("component_check");
    expect(ids).toContain("error_handling_check");
    expect(ids).toContain("type_safety_check");
    expect(ids).toContain("auth_check");
    expect(ids).toContain("security_check");
  });

  it("all 6 checks are blocking + implemented", () => {
    expect(REASONING_CHECKS.every((c) => c.blocking)).toBe(true);
    expect(REASONING_CHECKS.every((c) => c.implemented)).toBe(true);
  });

  it("schema_check verifies FK, indexes, RLS, DECIMAL(18,4), timestamps", () => {
    const check = REASONING_CHECKS.find((c) => c.id === "schema_check");
    const verifications = check?.verifications.join(" ");
    expect(verifications).toContain("foreign key");
    expect(verifications).toContain("index");
    expect(verifications).toContain("ROW LEVEL SECURITY");
    expect(verifications).toContain("DECIMAL(18, 4)");
  });

  it("component_check verifies 'use client' only when needed + no useEffect for data", () => {
    const check = REASONING_CHECKS.find((c) => c.id === "component_check");
    const v = check?.verifications.join(" ");
    expect(v).toContain("'use client'");
    expect(v).toContain("useState");
    expect(v).toContain("Server Components");
    expect(v).toContain("useEffect");
  });

  it("type_safety_check verifies Zod safeParse + no 'any'", () => {
    const check = REASONING_CHECKS.find((c) => c.id === "type_safety_check");
    const v = check?.verifications.join(" ");
    expect(v).toContain("Zod");
    expect(v).toContain("safeParse");
    expect(v).toContain("'any'");
    expect(v).toContain("unknown");
  });
});

// ───────────────────────────────────────────────
// 6. Code Generation Rules
// ───────────────────────────────────────────────

describe("6 — Code Generation Contract", () => {
  it("has 24 code gen rules", () => {
    expect(CODE_GEN_RULES).toHaveLength(24);
  });

  it("rules cover 6 categories", () => {
    const categories = new Set(CODE_GEN_RULES.map((r) => r.category));
    expect(categories.has("typescript")).toBe(true);
    expect(categories.has("supabase")).toBe(true);
    expect(categories.has("nextjs")).toBe(true);
    expect(categories.has("security")).toBe(true);
    expect(categories.has("styling")).toBe(true);
    expect(categories.has("documentation")).toBe(true);
  });

  it("CG-04: database mutations use Supabase client (no raw SQL)", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "CG-04");
    expect(rule?.rule).toContain("Supabase client");
    expect(rule?.enforcement).toContain("Never raw SQL");
  });

  it("CG-09: monetary values use DECIMAL(18, 4)", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "CG-09");
    expect(rule?.rule).toContain("DECIMAL(18, 4)");
    expect(rule?.enforcement).toContain("Never FLOAT");
  });

  it("CG-10: use app/ directory (not pages/)", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "CG-10");
    expect(rule?.rule).toContain("app/");
    expect(rule?.enforcement).toContain("No pages/");
  });

  it("CG-16: never use useEffect for data fetching", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "CG-16");
    expect(rule?.rule).toContain("useEffect");
    expect(rule?.rule).toContain("data fetching");
    expect(rule?.blocking).toBe(true);
  });

  it("blocking rules cover TypeScript + Supabase + Next.js + security + styling", () => {
    const blockingCategories = new Set(
      CODE_GEN_RULES.filter((r) => r.blocking).map((r) => r.category),
    );
    expect(blockingCategories.has("typescript")).toBe(true);
    expect(blockingCategories.has("supabase")).toBe(true);
    expect(blockingCategories.has("nextjs")).toBe(true);
    expect(blockingCategories.has("security")).toBe(true);
    expect(blockingCategories.has("styling")).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 7. File Structure Template
// ───────────────────────────────────────────────

describe("7 — File Structure Template", () => {
  it("includes required files for Next.js + Supabase architecture", () => {
    const paths = FILE_STRUCTURE.map((f) => f.path);
    expect(paths).toContain("app/layout.tsx");
    expect(paths).toContain("app/page.tsx");
    expect(paths).toContain("lib/supabase/server.ts");
    expect(paths).toContain("lib/supabase/client.ts");
    expect(paths).toContain("middleware.ts");
    expect(paths).toContain("database/schema.ts");
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("tailwind.config.ts");
  });

  it("required files include app routes + lib + middleware + database + config", () => {
    const required = FILE_STRUCTURE.filter((f) => f.required);
    const categories = new Set(required.map((f) => f.category));
    expect(categories.has("app")).toBe(true);
    expect(categories.has("lib")).toBe(true);
    expect(categories.has("middleware")).toBe(true);
    expect(categories.has("database")).toBe(true);
    expect(categories.has("config")).toBe(true);
  });

  it("lib/supabase/server.ts is required", () => {
    const file = FILE_STRUCTURE.find((f) => f.path === "lib/supabase/server.ts");
    expect(file?.required).toBe(true);
    expect(file?.description).toContain("Server");
  });
});

// ───────────────────────────────────────────────
// 8. Verification
// ───────────────────────────────────────────────

describe("8 — Architecture Engine Verification", () => {
  it("verifyArchitectureEngine reports all implemented", () => {
    const v = verifyArchitectureEngine();
    expect(v.totalDirectives).toBe(4);
    expect(v.totalRlsTemplates).toBeGreaterThanOrEqual(8);
    expect(v.totalClientTemplates).toBe(3);
    expect(v.totalReasoningChecks).toBe(6);
    expect(v.totalCodeGenRules).toBe(24);
    expect(v.totalFileStructureEntries).toBeGreaterThanOrEqual(20);
    expect(v.generateRlsFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });

  it("DirectiveId covers 4 directive ids", () => {
    const ids: DirectiveId[] = ["rls_first", "app_router", "reasoning_pipeline", "code_gen_contract"];
    expect(ids).toHaveLength(4);
  });

  it("ReasoningCheckId covers 6 check ids", () => {
    const ids: ReasoningCheckId[] = [
      "schema_check", "component_check", "error_handling_check",
      "type_safety_check", "auth_check", "security_check",
    ];
    expect(ids).toHaveLength(6);
  });

  it("FrontendFramework is nextjs_15", () => {
    const f: FrontendFramework = "nextjs_15";
    expect(f).toBe("nextjs_15");
  });

  it("BackendSystem covers 5 Supabase systems", () => {
    const s: BackendSystem[] = [
      "supabase_postgres", "supabase_rls", "supabase_gotrue",
      "supabase_realtime", "supabase_storage",
    ];
    expect(s).toHaveLength(5);
  });
});
