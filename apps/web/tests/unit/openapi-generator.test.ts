/**
 * Tests for the OpenAPI spec generator.
 *
 * Verifies:
 *   1. The spec is valid OpenAPI 3.1.
 *   2. All routes in the registry are emitted in the paths object.
 *   3. Each route has the right HTTP method + summary + tags.
 *   4. Rate-limited routes have the x-rate-limit vendor extension.
 *   5. Auth requirement is reflected in the security field.
 */

import { describe, it, expect } from "vitest";
import { generateOpenApiSpec, ROUTE_REGISTRY } from "@/lib/openapi/generator";

describe("OpenAPI spec — top-level shape", () => {
  const spec = generateOpenApiSpec();

  it("is OpenAPI 3.1.0", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  it("has a title, version, and description", () => {
    expect(spec.info.title).toBe("Supa OS API");
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.info.description.length).toBeGreaterThan(50);
  });

  it("has at least 2 servers (prod + local dev)", () => {
    expect(spec.servers.length).toBeGreaterThanOrEqual(2);
    expect(spec.servers.some((s) => s.url.includes("localhost"))).toBe(true);
  });

  it("has the adminAuth security scheme", () => {
    expect(spec.components.securitySchemes).toHaveProperty("adminAuth");
    const scheme = spec.components.securitySchemes.adminAuth as { type: string; scheme: string };
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
  });

  it("applies adminAuth globally as the default security requirement", () => {
    expect(spec.security).toEqual([{ adminAuth: [] }]);
  });
});

describe("OpenAPI spec — paths coverage", () => {
  const spec = generateOpenApiSpec();

  it("emits every route from the registry as a path entry", () => {
    for (const route of ROUTE_REGISTRY) {
      expect(spec.paths).toHaveProperty(route.path);
      expect(spec.paths[route.path]).toHaveProperty(route.method);
    }
  });

  it("each path operation has a summary + tags + responses", () => {
    for (const route of ROUTE_REGISTRY) {
      const operation = spec.paths[route.path]![route.method] as {
        summary: string;
        tags: string[];
        responses: Record<string, unknown>;
      };
      expect(operation.summary).toBe(route.summary);
      expect(operation.tags).toEqual(route.tags);
      expect(operation.responses["200"]).toBeDefined();
      expect(operation.responses["400"]).toBeDefined();
      expect(operation.responses["401"]).toBeDefined();
      expect(operation.responses["500"]).toBeDefined();
    }
  });

  it("rate-limited routes have a 429 response + x-rate-limit extension", () => {
    for (const route of ROUTE_REGISTRY) {
      if (!route.rateLimitTier) continue;
      const operation = spec.paths[route.path]![route.method] as {
        responses: Record<string, unknown>;
        "x-rate-limit"?: { tier: string; limit: number; windowMs: number };
      };
      expect(operation.responses["429"]).toBeDefined();
      expect(operation["x-rate-limit"]).toBeDefined();
      expect(operation["x-rate-limit"]!.tier).toBe(route.rateLimitTier);
      expect(operation["x-rate-limit"]!.limit).toBeGreaterThan(0);
    }
  });

  it("non-rate-limited routes don't have a 429 response", () => {
    for (const route of ROUTE_REGISTRY) {
      if (route.rateLimitTier) continue;
      const operation = spec.paths[route.path]![route.method] as {
        responses: Record<string, unknown>;
      };
      expect(operation.responses["429"]).toBeUndefined();
    }
  });

  it("routes with path params have parameter definitions", () => {
    for (const route of ROUTE_REGISTRY) {
      if (!route.pathParams || route.pathParams.length === 0) continue;
      const operation = spec.paths[route.path]![route.method] as {
        parameters: Array<{ name: string; in: string; required: boolean }>;
      };
      expect(operation.parameters).toBeDefined();
      for (const pathParam of route.pathParams) {
        const found = operation.parameters.find((p) => p.name === pathParam.name);
        expect(found).toBeDefined();
        expect(found!.in).toBe("path");
        expect(found!.required).toBe(true);
      }
    }
  });
});

describe("OpenAPI spec — tags", () => {
  const spec = generateOpenApiSpec();

  it("includes all tags referenced by routes", () => {
    const tagNames = new Set(spec.tags.map((t) => t.name));
    for (const route of ROUTE_REGISTRY) {
      for (const tag of route.tags) {
        expect(tagNames.has(tag)).toBe(true);
      }
    }
  });

  it("includes the 4 main namespace tags (Supa OS, Builder, Governance, Expansion)", () => {
    const tagNames = spec.tags.map((t) => t.name);
    expect(tagNames).toContain("Supa OS");
    expect(tagNames).toContain("Builder");
    expect(tagNames).toContain("Governance");
    expect(tagNames).toContain("Expansion");
  });
});

describe("OpenAPI spec — registry coverage", () => {
  it("covers at least 30 routes across the 4 namespaces", () => {
    expect(ROUTE_REGISTRY.length).toBeGreaterThanOrEqual(30);
  });

  it("covers all 4 namespaces (Supa OS, Builder, Governance, Expansion)", () => {
    const namespaces = new Set<string>();
    for (const route of ROUTE_REGISTRY) {
      // The first tag is the namespace.
      namespaces.add(route.tags[0]!);
    }
    expect(namespaces.has("Supa OS")).toBe(true);
    expect(namespaces.has("Builder")).toBe(true);
    expect(namespaces.has("Governance")).toBe(true);
    expect(namespaces.has("Expansion")).toBe(true);
  });
});
