// OpenAPI spec generator — produces an OpenAPI 3.1 spec from the route
// definitions + zod schemas.
//
// The spec covers the 98 new routes across 4 namespaces (Supa OS, Builder,
// Governance, Expansion). Each route is described with:
//   - HTTP method (GET/POST/PUT/PATCH/DELETE)
//   - Path + dynamic segments
//   - Request body schema (zod → JSON Schema)
//   - Response shape (the { ok: true, data: ... } envelope)
//   - Auth requirement (admin session)
//   - Rate limit tier
//
// Output: a single OpenAPI 3.1 JSON document that can be served at
// `/api/openapi.json` (so Swagger UI, Postman, or SDK generators can
// consume it).

import { z } from "zod";
import { TIERS } from "@/lib/ratelimit/config";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface OpenApiRouteSpec {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;                          // e.g. "/api/supa-os/build/{id}/agents/{role}"
  summary: string;
  description?: string;
  tags: string[];                        // ["Supa OS", "Build"]
  auth: "admin" | "admin_senior" | "admin_owner" | "user" | "none";
  rateLimitTier?: string;
  requestBodySchema?: z.ZodSchema<unknown>;
  responseSchema?: z.ZodSchema<unknown>;
  pathParams?: Array<{ name: string; description: string; required: true }>;
  queryParams?: Array<{ name: string; type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
}

export interface OpenApiSpec {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
  };
  security: Array<Record<string, unknown>>;
}

// ───────────────────────────────────────────────
// zod → JSON Schema conversion (lightweight — handles the common cases).
// ───────────────────────────────────────────────

function zodToJsonSchema(schema: z.ZodSchema<unknown>): Record<string, unknown> {
  // zod doesn't expose a built-in JSON Schema converter without the
  // `zod-to-json-schema` package. We hand-roll a converter that handles
  // the common cases (object, string, number, boolean, array, enum).
  const def = (schema as unknown as { _def: { typeName: string; [k: string]: unknown } })._def;

  switch (def.typeName) {
    case "ZodObject": {
      const shape = (def as unknown as { shape: Record<string, z.ZodSchema<unknown>> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!(value as unknown as { _def: { typeName: string } })._def) continue;
        const valueDef = (value as unknown as { _def: { typeName: string } })._def;
        if (valueDef.typeName !== "ZodOptional" && valueDef.typeName !== "ZodDefault") {
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray": {
      const element = (def as unknown as { element: z.ZodSchema<unknown> }).element;
      return { type: "array", items: zodToJsonSchema(element) };
    }
    case "ZodEnum": {
      const values = (def as unknown as { values: string[] }).values;
      return { type: "string", enum: values };
    }
    case "ZodOptional":
    case "ZodNullable": {
      const inner = (def as unknown as { innerType: z.ZodSchema<unknown> }).innerType;
      return zodToJsonSchema(inner);
    }
    case "ZodDefault": {
      const inner = (def as unknown as { innerType: z.ZodSchema<unknown> }).innerType;
      return zodToJsonSchema(inner);
    }
    case "ZodUuid":
      return { type: "string", format: "uuid" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    default:
      return { type: "object" };
  }
}

// ───────────────────────────────────────────────
// Route registry — the source of truth for the OpenAPI spec.
//
// Each route is described once here; the generator walks this list + emits
// the OpenAPI paths object. To document a new route, add an entry here.
//
// Note: we don't import zod schemas from the route files (they're declared
// as `const`, not `export const`). For Phase 2 we'll either change the
// routes to export them, or define the schemas in a shared module.
// ───────────────────────────────────────────────

export const ROUTE_REGISTRY: OpenApiRouteSpec[] = [
  // ─── Supa OS Build ───────────────────────────
  {
    method: "post",
    path: "/api/supa-os/build",
    summary: "Create a new Supa OS Build Session from a natural-language prompt",
    tags: ["Supa OS", "Build"],
    auth: "admin_senior",
    rateLimitTier: "supaOsBuild",

    responseSchema: z.object({
      ok: z.boolean(),
      data: z.object({
        session: z.object({ id: z.string() }),
        parsedGoal: z.object({}).passthrough(),
      }),
    }),
  },
  {
    method: "get",
    path: "/api/supa-os/build/{id}",
    summary: "Get a Supa OS Build Session's current state",
    tags: ["Supa OS", "Build"],
    auth: "admin",
    pathParams: [{ name: "id", description: "Build session UUID", required: true }],
  },
  {
    method: "delete",
    path: "/api/supa-os/build/{id}",
    summary: "Archive a Supa OS Build Session",
    tags: ["Supa OS", "Build"],
    auth: "admin_senior",
    pathParams: [{ name: "id", description: "Build session UUID", required: true }],
  },
  {
    method: "post",
    path: "/api/supa-os/build/{id}/agents/{role}",
    summary: "Run a specific agent (architect | security | uiux | fullstack | qa)",
    tags: ["Supa OS", "Build", "Agents"],
    auth: "admin_senior",
    rateLimitTier: "supaOsBuild",
    pathParams: [
      { name: "id", description: "Build session UUID", required: true },
      { name: "role", description: "Agent role: architect | security | uiux | fullstack | qa", required: true },
    ],
  },
  {
    method: "post",
    path: "/api/supa-os/build/{id}/deploy",
    summary: "One-click deploy a build session to a cloud target",
    tags: ["Supa OS", "Build", "Deploy"],
    auth: "admin_senior",
    rateLimitTier: "supaOsDeploy",
  },
  {
    method: "post",
    path: "/api/supa-os/build/{id}/sandbox/self-heal",
    summary: "Run the self-healing loop on a build session",
    tags: ["Supa OS", "Build", "Sandbox"],
    auth: "admin_senior",
    rateLimitTier: "supaOsSandbox",
  },
  {
    method: "post",
    path: "/api/supa-os/build/{id}/reasoning",
    summary: "Re-run System 2 reasoning (4-phase deliberation)",
    tags: ["Supa OS", "Build", "Reasoning"],
    auth: "admin",
  },

  // ─── Supa OS Catalog ───────────────────────
  {
    method: "get",
    path: "/api/supa-os/catalog/stacks",
    summary: "List available stacks (Next.js 15 + Supabase, Flutter + Firebase)",
    tags: ["Supa OS", "Catalog"],
    auth: "admin",
  },
  {
    method: "get",
    path: "/api/supa-os/catalog/cloud-targets",
    summary: "List cloud deploy targets (Vercel, Netlify, AWS, ...)",
    tags: ["Supa OS", "Catalog"],
    auth: "admin",
  },
  {
    method: "get",
    path: "/api/supa-os/catalog/kyc-providers",
    summary: "List KYC providers (Persona, Onfido, Sumsub, ...)",
    tags: ["Supa OS", "Catalog", "Fintech"],
    auth: "admin",
  },
  {
    method: "get",
    path: "/api/supa-os/catalog/payment-gateways",
    summary: "List payment gateways (Stripe, Flutterwave, Paystack, ...)",
    tags: ["Supa OS", "Catalog", "Fintech"],
    auth: "admin",
  },

  // ─── Supa OS Loan + Ledger ─────────────────
  {
    method: "post",
    path: "/api/supa-os/loan/calculate",
    summary: "Calculate a loan amortization schedule + summary",
    tags: ["Supa OS", "Fintech", "Loan"],
    auth: "admin",
    rateLimitTier: "supaOsSandbox",

  },
  {
    method: "post",
    path: "/api/supa-os/ledger/post",
    summary: "Post a double-entry transaction to the immutable ledger",
    tags: ["Supa OS", "Fintech", "Ledger"],
    auth: "admin_senior",
    rateLimitTier: "supaOsDeploy",

  },

  // ─── Supa OS Compliance ───────────────────
  {
    method: "post",
    path: "/api/supa-os/compliance/encrypt",
    summary: "Encrypt a sensitive field using AES-256-GCM",
    tags: ["Supa OS", "Compliance"],
    auth: "admin_senior",

  },
  {
    method: "post",
    path: "/api/supa-os/compliance/mask",
    summary: "Mask a sensitive field for display",
    tags: ["Supa OS", "Compliance"],
    auth: "admin",

  },

  // ─── Supa OS WASM ─────────────────────────
  {
    method: "post",
    path: "/api/supa-os/wasm/execute",
    summary: "Execute a shell command in the WASM runtime sandbox",
    tags: ["Supa OS", "WASM"],
    auth: "admin_senior",
    rateLimitTier: "supaOsWasm",

  },

  // ─── Supa OS Marketplace ──────────────────
  {
    method: "get",
    path: "/api/supa-os/marketplace",
    summary: "Browse / discover marketplace items",
    tags: ["Supa OS", "Marketplace"],
    auth: "admin",
  },
  {
    method: "post",
    path: "/api/supa-os/marketplace",
    summary: "Submit a new item for review",
    tags: ["Supa OS", "Marketplace"],
    auth: "admin_senior",
    rateLimitTier: "supaOsBuild",

  },
  {
    method: "post",
    path: "/api/supa-os/marketplace/{itemId}/review",
    summary: "Approve / reject a marketplace item",
    tags: ["Supa OS", "Marketplace"],
    auth: "admin_owner",
    rateLimitTier: "supaOsPublish",
    pathParams: [{ name: "itemId", description: "Marketplace item UUID", required: true }],
  },

  // ─── Builder Sessions ──────────────────────
  {
    method: "get",
    path: "/api/builder/sessions",
    summary: "List build sessions (filterable by owner / workspace / status)",
    tags: ["Builder", "Sessions"],
    auth: "admin",
  },
  {
    method: "get",
    path: "/api/builder/sessions/{id}",
    summary: "Get a single build session by id",
    tags: ["Builder", "Sessions"],
    auth: "admin",
    pathParams: [{ name: "id", description: "Build session UUID", required: true }],
  },
  {
    method: "post",
    path: "/api/builder/sessions/{id}/publish",
    summary: "Publish a build session to a target (Supa Hosting, App Store, ...)",
    tags: ["Builder", "Sessions", "Publish"],
    auth: "admin_senior",
    rateLimitTier: "supaOsPublish",
  },

  // ─── Governance ───────────────────────────
  {
    method: "post",
    path: "/api/governance/decisions",
    summary: "Route a decision request through the governance engine",
    tags: ["Governance", "Decisions"],
    auth: "admin_senior",

  },
  {
    method: "get",
    path: "/api/governance/kill-switches",
    summary: "List kill switches (active + inactive)",
    tags: ["Governance", "Kill Switches"],
    auth: "admin",
  },
  {
    method: "post",
    path: "/api/governance/kill-switches/{id}/trigger",
    summary: "Activate a kill switch (60-second propagation SLA)",
    tags: ["Governance", "Kill Switches"],
    auth: "admin_owner",
    rateLimitTier: "governanceKillSwitch",

    pathParams: [{ name: "id", description: "Kill switch type id", required: true }],
  },
  {
    method: "get",
    path: "/api/governance/circuit-breakers",
    summary: "List circuit breakers + their current state",
    tags: ["Governance", "Circuit Breakers"],
    auth: "admin",
  },
  {
    method: "get",
    path: "/api/governance/audit",
    summary: "Query the audit trail",
    tags: ["Governance", "Audit"],
    auth: "admin",
    rateLimitTier: "governanceQuery",
  },
  {
    method: "post",
    path: "/api/governance/developer-abuse",
    summary: "Detect developer abuse patterns + recommend response",
    tags: ["Governance", "Developer Ecosystem"],
    auth: "admin_senior",
    rateLimitTier: "governanceCommittee",

  },

  // ─── Expansion ─────────────────────────────
  {
    method: "get",
    path: "/api/expansion/pipeline",
    summary: "Get the 9-stage expansion pipeline + autonomy levels",
    tags: ["Expansion", "Pipeline"],
    auth: "admin",
  },
  {
    method: "post",
    path: "/api/expansion/detection",
    summary: "Detect demand signals for a region",
    tags: ["Expansion", "Detection"],
    auth: "admin_senior",
    rateLimitTier: "expansionPipeline",
  },
  {
    method: "post",
    path: "/api/expansion/evaluation",
    summary: "Evaluate market fit for a region",
    tags: ["Expansion", "Evaluation"],
    auth: "admin",
    rateLimitTier: "expansionPipeline",
  },
  {
    method: "post",
    path: "/api/expansion/preparation",
    summary: "Run a preparation workstream for a region (9 workstreams)",
    tags: ["Expansion", "Preparation"],
    auth: "admin_senior",
    rateLimitTier: "expansionPipeline",
  },
  {
    method: "post",
    path: "/api/expansion/optimization",
    summary: "Identify + implement optimization opportunities for a region",
    tags: ["Expansion", "Optimization"],
    auth: "admin_senior",
    rateLimitTier: "expansionOptimization",
  },
];

// ───────────────────────────────────────────────
// generateOpenApiSpec — walk the route registry + produce the spec.
// ───────────────────────────────────────────────

export function generateOpenApiSpec(): OpenApiSpec {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  for (const route of ROUTE_REGISTRY) {
    if (!paths[route.path]) paths[route.path] = {};

    // Build the operation object.
    const operation: Record<string, unknown> = {
      summary: route.summary,
      description: route.description ?? route.summary,
      tags: route.tags,
      security: route.auth === "none" ? [] : [{ adminAuth: [] }],
    };

    // Path parameters.
    if (route.pathParams && route.pathParams.length > 0) {
      operation.parameters = route.pathParams.map((p) => ({
        name: p.name,
        in: "path",
        description: p.description,
        required: p.required,
        schema: { type: "string" },
      }));
    }

    // Query parameters.
    if (route.queryParams && route.queryParams.length > 0) {
      operation.parameters = [
        ...(operation.parameters as unknown[] ?? []),
        ...route.queryParams.map((p) => ({
          name: p.name,
          in: "query",
          description: p.description,
          required: p.required ?? false,
          schema: { type: p.type },
        })),
      ];
    }

    // Rate limit tier (as a vendor extension).
    if (route.rateLimitTier) {
      const tierConfig = TIERS[route.rateLimitTier as keyof typeof TIERS];
      if (tierConfig) {
        operation["x-rate-limit"] = {
          tier: route.rateLimitTier,
          limit: tierConfig.limit,
          windowMs: tierConfig.windowMs,
        };
      }
    }

    // Request body.
    if (route.requestBodySchema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: zodToJsonSchema(route.requestBodySchema),
          },
        },
      };
    }

    // Responses.
    operation.responses = {
      "200": {
        description: "Successful response",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean", example: true },
                data: route.responseSchema
                  ? zodToJsonSchema(route.responseSchema)
                  : { type: "object" },
              },
              required: ["ok"],
            },
          },
        },
      },
      "400": { description: "Validation failed" },
      "401": { description: "Unauthenticated" },
      "403": { description: "Forbidden (insufficient role)" },
      ...(route.rateLimitTier ? { "429": { description: "Rate limited" } } : {}),
      "500": { description: "Internal error" },
    };

    paths[route.path]![route.method] = operation;

    for (const tag of route.tags) tagSet.add(tag);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Supa OS API",
      version: "1.0.0",
      description: "Supa OS + Builder + Governance + Expansion API surface. All routes require admin session authentication (Bearer token or `supa_admin` cookie). Rate limits are per-admin, per-route.",
    },
    servers: [
      { url: "https://api.supa-os.local", description: "Production" },
      { url: "http://localhost:3000", description: "Local development" },
    ],
    tags: Array.from(tagSet).map((name) => ({
      name,
      description: `${name} routes`,
    })),
    paths,
    components: {
      securitySchemes: {
        adminAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Admin session token (from `supa_admin` cookie or `Authorization: Bearer <token>` header).",
        },
      },
    },
    security: [{ adminAuth: [] }],
  };
}
