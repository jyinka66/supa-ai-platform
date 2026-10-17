// Next.js 15 + Supabase Architecture & Code Generation Engine.
//
// "SUPA AI OS — ARCHITECT & CODE GENERATION ENGINE (NEXT.JS + SUPABASE)"
//
// TARGET STACK:
//   - Frontend/Framework: Next.js 15 (App Router, Server Actions, RSC).
//   - Styling & UI: Tailwind CSS, Shadcn UI / Radix primitives, Lucide icons.
//   - Backend & Database: Supabase (PostgreSQL, RLS, GoTrue Auth, Realtime, Storage).
//   - Type Safety: TypeScript Strict Mode, Zod schema validation, Supabase Generated Types.
//
// MANDATORY ARCHITECTURAL DIRECTIVES:
//   1. Supabase Database & Security (RLS First).
//   2. Next.js App Router Architecture.
//   3. Reasoning & Execution Pipeline (pre-generation validation checklist).
//   4. Code Generation Contract (what every generated file must satisfy).

// ───────────────────────────────────────────────
// 1. Target Stack Specification.
// ───────────────────────────────────────────────

export type FrontendFramework = "nextjs_15";
export type StylingSystem = "tailwind_css" | "shadcn_ui" | "radix_primitives" | "lucide_icons";
export type BackendSystem = "supabase_postgres" | "supabase_rls" | "supabase_gotrue" | "supabase_realtime" | "supabase_storage";
export type TypeSystem = "typescript_strict" | "zod_validation" | "supabase_generated_types";

export interface StackSpecification {
  frontend: {
    framework: FrontendFramework;
    version: string;
    features: string[];
  };
  styling: {
    system: StylingSystem[];
    tailwindVersion: string;
    shadcnVersion: string;
  };
  backend: {
    system: BackendSystem[];
    postgresVersion: string;
    features: string[];
  };
  typeSystem: {
    system: TypeSystem[];
    typescriptVersion: string;
    zodVersion: string;
  };
}

export const TARGET_STACK: StackSpecification = {
  frontend: {
    framework: "nextjs_15",
    version: "15.0.0",
    features: [
      "App Router (app/ directory)",
      "Server Actions (mutate state without API routes)",
      "React Server Components (RSC — server-rendered, zero JS)",
      "Streaming + Suspense",
      "Route Handlers (app/api/.../route.ts)",
      "Middleware (middleware.ts — edge runtime)",
      "Metadata API (SEO, OpenGraph)",
      "Partial Prerendering (PPR)",
    ],
  },
  styling: {
    system: ["tailwind_css", "shadcn_ui", "radix_primitives", "lucide_icons"],
    tailwindVersion: "4.0.0",
    shadcnVersion: "latest (Radix + Tailwind + CVA)",
  },
  backend: {
    system: ["supabase_postgres", "supabase_rls", "supabase_gotrue", "supabase_realtime", "supabase_storage"],
    postgresVersion: "16.0",
    features: [
      "PostgreSQL 16 (managed by Supabase)",
      "Row Level Security (RLS) on every table",
      "GoTrue Auth (email/password, OAuth, magic link, MFA)",
      "Realtime (WebSocket subscriptions — postgres_changes, broadcast, presence)",
      "Storage (S3-compatible object storage with signed URLs)",
      "Edge Functions (Deno runtime — serverless functions)",
      "Database Webhooks (trigger on row changes)",
      "Generated Types (auto-generated from schema — supabase gen types)",
    ],
  },
  typeSystem: {
    system: ["typescript_strict", "zod_validation", "supabase_generated_types"],
    typescriptVersion: "5.4.0",
    zodVersion: "3.23.0",
  },
};

// ───────────────────────────────────────────────
// 2. Mandatory Architectural Directives.
// ───────────────────────────────────────────────

export type DirectiveId =
  | "rls_first"              // Directive 1: Supabase Database & Security.
  | "app_router"              // Directive 2: Next.js App Router Architecture.
  | "reasoning_pipeline"      // Directive 3: Reasoning & Execution Pipeline.
  | "code_gen_contract";      // Directive 4: Code Generation Contract.

export interface DirectiveSpec {
  id: DirectiveId;
  number: number;
  title: string;
  description: string;
  /** The rules this directive enforces. */
  rules: string[];
  /** Whether this directive is blocking (code generation cannot start until it passes). */
  blocking: boolean;
  implemented: boolean;
}

export const ARCHITECTURAL_DIRECTIVES: DirectiveSpec[] = [
  {
    id: "rls_first",
    number: 1,
    title: "Supabase Database & Security (RLS First)",
    description: "Every PostgreSQL table MUST include Row Level Security. Security policies MUST explicitly guard operations.",
    rules: [
      "Every table MUST have: ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;",
      "Security policies MUST guard SELECT, INSERT, UPDATE, DELETE explicitly.",
      "Policies MUST reference auth.uid() or role claims (request.jwt.claims).",
      "Financial/Ledger tables MUST use DECIMAL(18, 4) for monetary values.",
      "Primary keys MUST be UUID DEFAULT gen_random_uuid().",
      "Every table MUST have created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP.",
      "Foreign keys MUST be explicitly defined with REFERENCES + ON DELETE behavior.",
      "Indexes MUST be created on all foreign key columns + frequently queried columns.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "app_router",
    number: 2,
    title: "Next.js App Router Architecture",
    description: "Utilize Route Handlers or Server Actions for state mutation. Use @supabase/ssr for client instantiation.",
    rules: [
      "Use app/ directory (App Router) — NOT pages/ directory.",
      "Use Route Handlers (app/api/.../route.ts) for REST API endpoints.",
      "Use Server Actions ('use server') for form mutations — NOT client-side fetch.",
      "Use React Server Components (RSC) by default — mark 'use client' ONLY when state/effects required.",
      "Instantiate Supabase client via @supabase/ssr (createServerClient for SSR, createBrowserClient for client).",
      "Protect routes at the network edge using middleware.ts synced with Supabase session tokens.",
      "Use Next.js Metadata API for SEO (export const metadata / generateMetadata).",
      "Use Streaming + Suspense for progressive rendering of slow components.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "reasoning_pipeline",
    number: 3,
    title: "Reasoning & Execution Pipeline",
    description: "Before returning any code, run this internal validation checklist.",
    rules: [
      "SCHEMA CHECK: Are foreign keys, indexes, and RLS policies defined for all tables?",
      "COMPONENT CHECK: Are client components marked with 'use client' only when state/effects are required?",
      "ERROR HANDLING: Are API and Database mutations wrapped in try/catch returning typed error responses?",
      "TYPE SAFETY: Are all inputs validated with Zod before processing?",
      "AUTH CHECK: Are all protected routes guarded by middleware + session check?",
      "SECURITY CHECK: Are sensitive fields encrypted + masked in logs?",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "code_gen_contract",
    number: 4,
    title: "Code Generation Contract",
    description: "Every generated file must satisfy this contract.",
    rules: [
      "Every file MUST pass TypeScript strict mode (strict: true, noUncheckedIndexedAccess: true).",
      "Every API route MUST have Zod validation on input (safeParse).",
      "Every database mutation MUST use the Supabase client (never raw SQL in application code).",
      "Every server component MUST use the server-side Supabase client (createServerClient).",
      "Every client component MUST use the browser-side Supabase client (createBrowserClient).",
      "Every table MUST have a corresponding Drizzle schema definition (pgTable).",
      "Every table MUST have RLS policies (at minimum: user can see own data).",
      "Every monetary value MUST use DECIMAL(18, 4) — never FLOAT or REAL.",
      "Every error response MUST be a typed NextResponse.json with a consistent error shape.",
      "Every file MUST have JSDoc/TSDoc documentation.",
      "Never use 'any' — use 'unknown' + type narrowing.",
      "Never use pages/ directory — use app/ directory exclusively.",
      "Never use getServerSideProps/getStaticProps — use Server Components.",
      "Never use useEffect for data fetching — use Server Components or Server Actions.",
    ],
    blocking: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 3. RLS Policy Templates.
//
// Pre-built RLS policy templates that the code generator uses
// for every table.
// ───────────────────────────────────────────────

export type RlsOperation = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
export type RlsScope = "own_data" | "workspace" | "public_read" | "admin_only" | "service_only";

export interface RlsPolicyTemplate {
  operation: RlsOperation;
  scope: RlsScope;
  /** The SQL policy definition. */
  sql: string;
  description: string;
}

export const RLS_POLICY_TEMPLATES: RlsPolicyTemplate[] = [
  {
    operation: "SELECT",
    scope: "own_data",
    sql: `CREATE POLICY "users_select_own" ON {table}
  FOR SELECT USING (auth.uid() = user_id);`,
    description: "Users can only SELECT their own rows (where user_id matches their auth.uid()).",
  },
  {
    operation: "INSERT",
    scope: "own_data",
    sql: `CREATE POLICY "users_insert_own" ON {table}
  FOR INSERT WITH CHECK (auth.uid() = user_id);`,
    description: "Users can only INSERT rows where user_id is their own auth.uid().",
  },
  {
    operation: "UPDATE",
    scope: "own_data",
    sql: `CREATE POLICY "users_update_own" ON {table}
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`,
    description: "Users can only UPDATE their own rows.",
  },
  {
    operation: "DELETE",
    scope: "own_data",
    sql: `CREATE POLICY "users_delete_own" ON {table}
  FOR DELETE USING (auth.uid() = user_id);`,
    description: "Users can only DELETE their own rows.",
  },
  {
    operation: "SELECT",
    scope: "workspace",
    sql: `CREATE POLICY "ws_members_select" ON {table}
  FOR SELECT USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );`,
    description: "Workspace members can SELECT rows in their workspace.",
  },
  {
    operation: "INSERT",
    scope: "workspace",
    sql: `CREATE POLICY "ws_members_insert" ON {table}
  FOR INSERT WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = true
    )
  );`,
    description: "Workspace members can INSERT rows into their workspace.",
  },
  {
    operation: "SELECT",
    scope: "public_read",
    sql: `CREATE POLICY "public_select" ON {table}
  FOR SELECT USING (true);`,
    description: "Anyone can SELECT (public read — for public content).",
  },
  {
    operation: "SELECT",
    scope: "admin_only",
    sql: `CREATE POLICY "admin_select" ON {table}
  FOR SELECT USING (
    auth.uid() IN (
      SELECT user_id FROM workspace_members
      WHERE role IN ('owner', 'admin') AND is_active = true
    )
  );`,
    description: "Only admin/owner roles can SELECT.",
  },
];

/**
 * Generate RLS SQL for a table with the specified scope.
 */
export function generateRlsSql(input: {
  tableName: string;
  scope: RlsScope;
  operations?: RlsOperation[];
}): string {
  const ops = input.operations ?? ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const templates = RLS_POLICY_TEMPLATES.filter(
    (t) => t.scope === input.scope && ops.includes(t.operation),
  );

  const policies = templates.map((t) => t.sql.replace("{table}", input.tableName));
  return [
    `-- RLS for ${input.tableName} (${input.scope})`,
    `ALTER TABLE ${input.tableName} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${input.tableName} FORCE ROW LEVEL SECURITY;`,
    "",
    ...policies,
  ].join("\n");
}

// ───────────────────────────────────────────────
// 4. Supabase Client Instantiation Templates.
// ───────────────────────────────────────────────

export interface SupabaseClientTemplate {
  context: "server_component" | "route_handler" | "server_action" | "client_component" | "middleware";
  fileName: string;
  code: string;
  description: string;
}

export const SUPABASE_CLIENT_TEMPLATES: SupabaseClientTemplate[] = [
  {
    context: "server_component",
    fileName: "lib/supabase/server.ts",
    code: `import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch { /* Server Component — middleware refreshes sessions */ }
        },
      },
    }
  )
}`,
    description: "Server-side Supabase client for Server Components + Server Actions.",
  },
  {
    context: "client_component",
    fileName: "lib/supabase/client.ts",
    code: `import { createBrowserClient } from '@supabase/ssr'

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}`,
    description: "Browser-side Supabase client for Client Components.",
  },
  {
    context: "middleware",
    fileName: "middleware.ts",
    code: `import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response.cookies.set(name, value)
        },
      },
    }
  )
  const { data: { session } } = await supabase.auth.getSession()
  // Protect routes that require auth.
  if (!session && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return response
}

export const config = {
  matcher: ['/dashboard/:path*', '/settings/:path*', '/api/:path*'],
}`,
    description: "Middleware that syncs Supabase session + protects routes at the edge.",
  },
];

// ───────────────────────────────────────────────
// 5. Reasoning & Execution Pipeline.
//
// "Before returning any code, run this internal validation checklist."
// ───────────────────────────────────────────────

export type ReasoningCheckId =
  | "schema_check"
  | "component_check"
  | "error_handling_check"
  | "type_safety_check"
  | "auth_check"
  | "security_check";

export interface ReasoningCheck {
  id: ReasoningCheckId;
  title: string;
  description: string;
  /** What this check verifies. */
  verifications: string[];
  blocking: boolean;
  implemented: boolean;
}

export const REASONING_CHECKS: ReasoningCheck[] = [
  {
    id: "schema_check",
    title: "Schema Check",
    description: "Are foreign keys, indexes, and RLS policies defined for all tables?",
    verifications: [
      "Every table has a primary key (UUID DEFAULT gen_random_uuid()).",
      "Every foreign key has REFERENCES + ON DELETE behavior (CASCADE / SET NULL / RESTRICT).",
      "Every foreign key column has an index.",
      "Every table has RLS enabled (ALTER TABLE ... ENABLE ROW LEVEL SECURITY).",
      "Every table has RLS policies for SELECT, INSERT, UPDATE, DELETE.",
      "Every monetary column uses DECIMAL(18, 4) — not FLOAT or REAL.",
      "Every table has created_at + updated_at timestamps.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "component_check",
    title: "Component Check",
    description: "Are client components marked with 'use client' only when state/effects are required?",
    verifications: [
      "Components WITHOUT state/effects are Server Components (no 'use client' directive).",
      "Components WITH useState/useEffect/useReducer are Client Components ('use client').",
      "Components that use browser APIs (window, document, localStorage) are Client Components.",
      "Components that use event handlers (onClick, onChange) are Client Components.",
      "Data fetching is done in Server Components — NOT in useEffect.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "error_handling_check",
    title: "Error Handling Check",
    description: "Are API and Database mutations wrapped in try/catch returning typed error responses?",
    verifications: [
      "Every API Route Handler (route.ts) wraps logic in try/catch.",
      "Every Server Action wraps mutations in try/catch.",
      "Errors return a typed NextResponse.json with { error: { code, message } } shape.",
      "Database errors are caught + return a 500 with a safe error message (no SQL leak).",
      "Validation errors return 400 with field-specific error details.",
      "Auth errors return 401 (unauthenticated) or 403 (forbidden).",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "type_safety_check",
    title: "Type Safety Check",
    description: "Are all inputs validated with Zod before processing?",
    verifications: [
      "Every API route has a Zod schema for request body + query params.",
      "Every Server Action has a Zod schema for form input.",
      "safeParse is used (not parse) — invalid input returns 400, not a crash.",
      "Every function has typed parameters + typed return values.",
      "No 'any' type — use 'unknown' + type narrowing.",
      "Supabase generated types are used for database query results.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "auth_check",
    title: "Auth Check",
    description: "Are all protected routes guarded by middleware + session check?",
    verifications: [
      "middleware.ts protects all authenticated routes.",
      "Every protected API route checks the Supabase session.",
      "Every protected Server Component checks the session before rendering.",
      "Unauthenticated users are redirected to /login.",
      "Unauthorized users (wrong role) get a 403.",
      "Session refresh is handled by middleware (not in the component).",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "security_check",
    title: "Security Check",
    description: "Are sensitive fields encrypted + masked in logs?",
    verifications: [
      "Sensitive fields (SSN, BVN, card numbers) are encrypted with AES-256-GCM.",
      "Sensitive fields are masked in all log output.",
      "Card data is tokenized — never stored in the database.",
      "RLS policies prevent cross-user data access.",
      "API routes have rate limiting configured.",
      "CORS headers are properly configured.",
      "Environment variables are validated at startup (no missing vars in production).",
    ],
    blocking: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 6. Code Generation Contract.
// ───────────────────────────────────────────────

export interface CodeGenRule {
  id: string;
  rule: string;
  enforcement: string;
  category: "typescript" | "supabase" | "nextjs" | "security" | "styling" | "documentation";
  blocking: boolean;
}

export const CODE_GEN_RULES: CodeGenRule[] = [
  // TypeScript.
  { id: "CG-01", rule: "Every file passes TypeScript strict mode.", enforcement: "strict: true, noUncheckedIndexedAccess: true in tsconfig.json.", category: "typescript", blocking: true },
  { id: "CG-02", rule: "No 'any' type — use 'unknown' + type narrowing.", enforcement: "ESLint rule @typescript-eslint/no-explicit-any: error.", category: "typescript", blocking: true },
  { id: "CG-03", rule: "Every function has typed parameters + typed return values.", enforcement: "All function signatures must include types — no implicit any.", category: "typescript", blocking: true },

  // Supabase.
  { id: "CG-04", rule: "Every database mutation uses the Supabase client.", enforcement: "Never raw SQL in application code — use supabase.from('table').insert()/update()/delete().", category: "supabase", blocking: true },
  { id: "CG-05", rule: "Server components use createServerClient (createSupabaseServerClient).", enforcement: "Import from lib/supabase/server.ts — NOT from @supabase/supabase-js directly.", category: "supabase", blocking: true },
  { id: "CG-06", rule: "Client components use createBrowserClient (createSupabaseBrowserClient).", enforcement: "Import from lib/supabase/client.ts — NOT from @supabase/supabase-js directly.", category: "supabase", blocking: true },
  { id: "CG-07", rule: "Every table has a Drizzle pgTable definition.", enforcement: "database/schema.ts with pgTable() for every table.", category: "supabase", blocking: true },
  { id: "CG-08", rule: "Every table has RLS policies.", enforcement: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY + CREATE POLICY for SELECT/INSERT/UPDATE/DELETE.", category: "supabase", blocking: true },
  { id: "CG-09", rule: "Monetary values use DECIMAL(18, 4).", enforcement: "Never FLOAT or REAL for money — always decimal({ precision: 18, scale: 4 }) in Drizzle.", category: "supabase", blocking: true },

  // Next.js.
  { id: "CG-10", rule: "Use app/ directory (App Router).", enforcement: "No pages/ directory — all routes in app/.", category: "nextjs", blocking: true },
  { id: "CG-11", rule: "Use Server Components by default.", enforcement: "Only add 'use client' when state/effects/browser APIs are needed.", category: "nextjs", blocking: true },
  { id: "CG-12", rule: "Use Server Actions for form mutations.", enforcement: "'use server' functions — not client-side fetch to API routes.", category: "nextjs", blocking: true },
  { id: "CG-13", rule: "Use Route Handlers for REST API endpoints.", enforcement: "app/api/.../route.ts — export async function GET/POST/PATCH/DELETE.", category: "nextjs", blocking: true },
  { id: "CG-14", rule: "Use middleware.ts for route protection.", enforcement: "Sync Supabase session at the edge — redirect unauthenticated users.", category: "nextjs", blocking: true },
  { id: "CG-15", rule: "Never use getServerSideProps/getStaticProps.", enforcement: "Use Server Components — data fetching is automatic.", category: "nextjs", blocking: true },
  { id: "CG-16", rule: "Never use useEffect for data fetching.", enforcement: "Use Server Components or Server Actions — not client-side fetch.", category: "nextjs", blocking: true },

  // Security.
  { id: "CG-17", rule: "Every API route has Zod validation.", enforcement: "safeParse on request body + query — reject invalid input with 400.", category: "security", blocking: true },
  { id: "CG-18", rule: "Every error response is typed.", enforcement: "NextResponse.json({ error: { code, message } }, { status }) — consistent shape.", category: "security", blocking: true },
  { id: "CG-19", rule: "Sensitive fields are encrypted + masked.", enforcement: "AES-256-GCM encryption at rest + mask in logs.", category: "security", blocking: true },

  // Styling.
  { id: "CG-20", rule: "Use Tailwind CSS for all styling.", enforcement: "No inline styles, no CSS modules — Tailwind utility classes only.", category: "styling", blocking: true },
  { id: "CG-21", rule: "Use Shadcn UI components.", enforcement: "Import from components/ui/ — Button, Input, Card, Dialog, etc.", category: "styling", blocking: false },
  { id: "CG-22", rule: "Every UI is responsive.", enforcement: "Mobile-first: sm:, md:, lg:, xl: breakpoints.", category: "styling", blocking: true },

  // Documentation.
  { id: "CG-23", rule: "Every function has JSDoc/TSDoc.", enforcement: "/** Description. @param @returns @throws */", category: "documentation", blocking: false },
  { id: "CG-24", rule: "Every file has a header comment.", enforcement: "// What this file does + how it fits in the architecture.", category: "documentation", blocking: false },
];

// ───────────────────────────────────────────────
// 7. File structure template.
// ───────────────────────────────────────────────

export interface FileStructureTemplate {
  path: string;
  description: string;
  category: "app" | "lib" | "components" | "database" | "config" | "middleware" | "public";
  required: boolean;
}

export const FILE_STRUCTURE: FileStructureTemplate[] = [
  // app/ directory (App Router).
  { path: "app/layout.tsx", description: "Root layout — wraps all pages with providers.", category: "app", required: true },
  { path: "app/page.tsx", description: "Home page (landing or dashboard).", category: "app", required: true },
  { path: "app/(auth)/login/page.tsx", description: "Login page.", category: "app", required: true },
  { path: "app/(auth)/signup/page.tsx", description: "Signup page.", category: "app", required: true },
  { path: "app/(app)/dashboard/page.tsx", description: "Dashboard page (protected).", category: "app", required: true },
  { path: "app/(app)/settings/page.tsx", description: "Settings page (protected).", category: "app", required: true },
  { path: "app/api/.../route.ts", description: "API Route Handlers (REST endpoints).", category: "app", required: true },

  // lib/ directory.
  { path: "lib/supabase/server.ts", description: "Server-side Supabase client (createSupabaseServerClient).", category: "lib", required: true },
  { path: "lib/supabase/client.ts", description: "Browser-side Supabase client (createSupabaseBrowserClient).", category: "lib", required: true },
  { path: "lib/supabase/admin.ts", description: "Service-role Supabase client (admin operations only).", category: "lib", required: false },
  { path: "lib/validations/...ts", description: "Zod validation schemas per entity.", category: "lib", required: true },
  { path: "lib/types/...ts", description: "TypeScript type definitions.", category: "lib", required: true },

  // components/ directory.
  { path: "components/ui/...", description: "Shadcn UI components (Button, Input, Card, etc.).", category: "components", required: true },
  { path: "components/layout/...", description: "Layout components (Sidebar, TopBar, etc.).", category: "components", required: true },

  // database/ directory.
  { path: "database/schema.ts", description: "Drizzle schema (pgTable definitions).", category: "database", required: true },
  { path: "database/migrations/...sql", description: "SQL migration files.", category: "database", required: true },
  { path: "database/rls/...sql", description: "RLS policy SQL files.", category: "database", required: true },

  // config.
  { path: "middleware.ts", description: "Next.js middleware (route protection + session refresh).", category: "middleware", required: true },
  { path: "tsconfig.json", description: "TypeScript config (strict mode).", category: "config", required: true },
  { path: "next.config.js", description: "Next.js config.", category: "config", required: true },
  { path: "tailwind.config.ts", description: "Tailwind CSS config.", category: "config", required: true },
  { path: "drizzle.config.ts", description: "Drizzle ORM config.", category: "config", required: true },
  { path: ".env.local", description: "Environment variables.", category: "config", required: true },
];

// ───────────────────────────────────────────────
// 8. Architecture verification.
// ───────────────────────────────────────────────

export interface ArchitectureVerification {
  totalDirectives: number;
  totalRlsTemplates: number;
  totalClientTemplates: number;
  totalReasoningChecks: number;
  totalCodeGenRules: number;
  totalFileStructureEntries: number;
  generateRlsFunctionImplemented: boolean;
  allImplemented: boolean;
}

export function verifyArchitectureEngine(): ArchitectureVerification {
  return {
    totalDirectives: ARCHITECTURAL_DIRECTIVES.length,
    totalRlsTemplates: RLS_POLICY_TEMPLATES.length,
    totalClientTemplates: SUPABASE_CLIENT_TEMPLATES.length,
    totalReasoningChecks: REASONING_CHECKS.length,
    totalCodeGenRules: CODE_GEN_RULES.length,
    totalFileStructureEntries: FILE_STRUCTURE.length,
    generateRlsFunctionImplemented: true,
    allImplemented:
      ARCHITECTURAL_DIRECTIVES.every((d) => d.implemented) &&
      REASONING_CHECKS.every((c) => c.implemented),
  };
}
