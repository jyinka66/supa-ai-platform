/**
 * POST /api/templates/:id/publish
 *
 * Run the full publish gauntlet: tokens (no literals), a11y (contrast
 * per variant), perf (renders under budget at 800-layer-equivalent),
 * fonts (license complete), compat (op-schema version), provenance
 * (AI-assisted declared).
 *
 * Human review is sampling-based on top (5% default, like the AI
 * review queue): automated gates catch the measurable; a small
 * review queue catches the "technically passes, visually broken" tail.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";
import {
  runPublishGauntlet,
  type PublishGauntletOptions,
} from "@supa/design-marketplace/publish";
import type { TemplatePackage } from "@supa/design-marketplace/template-package";
import {
  RealTokensGate,
  RealA11yGate,
  RealPerfGate,
  RealFontsGate,
  RealCompatGate,
  RealProvenanceGate,
  DEFAULT_PERF_BUDGET,
} from "@supa/design-marketplace/gates";
import type { BoundNode, BoundValue } from "@supa/design-tokens/bindings";
import type { Token, TokenMap } from "@supa/design-tokens/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────
// Schemas
// ───────────────────────────────────────────────

const PublishBody = z.object({
  /** The full template package to publish (content-addressed). */
  package: z.unknown(),
  /** Override review sampling rate (0..1). Default 0.05. */
  reviewSamplingRate: z.number().min(0).max(1).optional(),
}).strict();

// ───────────────────────────────────────────────
// Package deserializer + extractors
// ───────────────────────────────────────────────

/**
 * Zod shape of a published TemplatePackage. Used by `deserializePackage`
 * to validate untrusted input before it touches the gauntlet.
 *
 * NOTE: `doc` and `tokens` are kept as `z.unknown()` — they're opaque to
 * this package and validated separately by `extractNodes`/`extractTokenMap`
 * and the doc/token validators in the install funnel.
 */
const TemplatePackageSchema = z.object({
  meta: z.object({
    id: z.string(),
    semver: z.string(),
    author: z.string(),
    license: z.string(),
    categories: z.array(z.string()),
    preview: z.object({
      thumbnails: z.array(z.string()),
      animatedPreview: z.string(),
    }),
    name: z.record(z.string(), z.string()),
    description: z.record(z.string(), z.string()),
    aiAssisted: z.boolean(),
    derivedFrom: z.string().optional(),
  }),
  doc: z.unknown(),
  tokens: z.unknown(),
  fonts: z.object({
    requirements: z.array(
      z.object({
        family: z.string(),
        subsets: z.array(z.object({ name: z.string(), hash: z.string() })),
        axes: z.array(
          z.object({
            name: z.string(),
            min: z.number(),
            max: z.number(),
            license: z.enum(["free", "commercial", "unknown"]),
            priceMicrocredits: z.number().optional(),
          }),
        ),
      }),
    ),
  }),
  aiManifest: z.object({ promptTemplateIds: z.array(z.string()) }).optional(),
  compat: z.object({
    minAppVersion: z.string(),
    opSchemaVersion: z.number(),
  }),
  packageHash: z.string(),
});

function deserializePackage(raw: unknown): TemplatePackage {
  // Validate the untrusted package against the TemplatePackage Zod schema
  // before it touches the gauntlet. A publish payload that fails this
  // check is malformed (or malicious) and should never reach the gates.
  const parsed = TemplatePackageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid template package: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  // TODO: verify packageHash matches sha-256 of canonical serialization.
  return parsed.data as TemplatePackage;
}

/**
 * Type guard for a BoundValue (ref or literal).
 * Used to defensively walk the untrusted doc snapshot.
 */
function isBoundValue(v: unknown): v is BoundValue {
  if (!v || typeof v !== "object") return false;
  const obj = v as { kind?: unknown; token?: unknown; value?: unknown };
  if (obj.kind === "ref" && typeof obj.token === "string") return true;
  if (obj.kind === "literal" && typeof obj.value === "string") return true;
  return false;
}

function extractNodes(pkg: TemplatePackage): BoundNode[] {
  // Walk pkg.doc.pages[].layers[] and project each layer's
  // fill/space/radius/textStyle into the BoundNode shape. The doc
  // already stores both ref and literal forms (design-model pass 1).
  //
  // Real impl: use design-model's typed walkers once the doc schema is
  // imported. Here we defensively type-narrow the opaque `doc` payload
  // so a malformed package surfaces violations instead of being silently
  // skipped (which would make the tokens gate pass vacuously).
  const nodes: BoundNode[] = [];
  const doc = pkg.doc as { pages?: { layers?: unknown[] }[] } | null;
  if (!doc?.pages) return nodes;
  for (const page of doc.pages) {
    if (!page || !Array.isArray(page.layers)) continue;
    for (const layer of page.layers) {
      if (!layer || typeof layer !== "object") continue;
      const l = layer as Record<string, unknown>;
      const id = typeof l.id === "string" ? l.id : "(unknown-layer)";
      const node: BoundNode = { id };
      if (isBoundValue(l.fill)) node.fill = l.fill;
      if (isBoundValue(l.space)) node.space = l.space;
      if (isBoundValue(l.radius)) node.radius = l.radius;
      if (isBoundValue(l.textStyle)) node.textStyle = l.textStyle;
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * Type guard for a Token (subset — id required).
 * Used to defensively deserialize the opaque `tokens` payload.
 */
function isTokenLike(v: unknown): v is Token {
  if (!v || typeof v !== "object") return false;
  const t = v as { id?: unknown; type?: unknown; value?: unknown; provenance?: unknown };
  return (
    typeof t.id === "string" &&
    typeof t.type === "string" &&
    typeof t.value === "object" && t.value !== null &&
    typeof t.provenance === "object" && t.provenance !== null
  );
}

function extractTokenMap(pkg: TemplatePackage): TokenMap {
  // Deserialize pkg.tokens into a TokenMap. The package may carry tokens
  // as either a live TokenMap (mapId + Map) or a plain JSON-serializable
  // shape (array of Token entries). We defensively accept both, validating
  // each entry's shape so the a11y gate runs against real tokens instead
  // of an empty stub.
  const raw = pkg.tokens;
  const empty: TokenMap = { mapId: "empty", tokens: new Map() };
  if (!raw || typeof raw !== "object") return empty;

  // Already a TokenMap-shaped object?
  const maybeMap = raw as { mapId?: unknown; tokens?: unknown };
  if (typeof maybeMap.mapId === "string" && maybeMap.tokens instanceof Map) {
    return { mapId: maybeMap.mapId, tokens: maybeMap.tokens as Map<string, Token> };
  }

  // Serialized as { tokens: Token[] } or a bare Token[]?
  const tokensArr: unknown[] = Array.isArray(maybeMap.tokens)
    ? maybeMap.tokens
    : Array.isArray(raw)
      ? raw
      : [];
  const map = new Map<string, Token>();
  for (const t of tokensArr) {
    if (isTokenLike(t)) {
      map.set(t.id, t);
    }
  }
  // TODO: full Token schema validation + cycle/ref resolution via
  // design-tokens' validateTokenMap before publishing.
  return { mapId: "deserialized", tokens: map };
}

function countNodes(pkg: TemplatePackage): number {
  // Count all layers across all pages. Defensively type-narrow the
  // opaque doc payload.
  const doc = pkg.doc as { pages?: { layers?: unknown[] }[] } | null;
  if (!doc?.pages) return 0;
  let count = 0;
  for (const page of doc.pages) {
    count += page.layers?.length ?? 0;
  }
  return count;
}

function measureRenderMs(pkg: TemplatePackage): number {
  // Real impl: render the doc at mid-tier profile and measure with
  // @supa/design-render's budget checker. Until that's wired, derive a
  // deterministic estimate from the node count so the perf gate is
  // non-vacuous — a bloated template won't silently pass.
  //
  // Heuristic: ~2ms baseline + 0.02ms per node. At the 800-node budget
  // cap this lands at ~18ms, which exceeds the 16ms frame budget and
  // trips the gate (matching the real impl's intent for max-size docs).
  // TODO: replace with @supa/design-render measurement.
  return 2 + countNodes(pkg) * 0.02;
}

// ───────────────────────────────────────────────
// Current version constants (real impl reads from build)
// ───────────────────────────────────────────────

const CURRENT_OP_SCHEMA_VERSION = 1;
const CURRENT_APP_VERSION = "0.1.0";

// ───────────────────────────────────────────────
// Route handler
// ───────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  const blocked = await guard(req, "default");
  if (blocked) return blocked;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 401;
    return problem("UNAUTHENTICATED", {
      status,
      message: "Authentication required.",
    });
  }

  let body;
  try {
    const json = await req.json();
    body = PublishBody.parse(json);
  } catch (err) {
    return problem("INVALID_BODY", {
      status: 400,
      message: "Request body failed validation.",
      details: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  let pkg: TemplatePackage;
  try {
    pkg = deserializePackage(body.package);
  } catch (err) {
    return problem("VALIDATION_FAILED", {
      status: 400,
      message: "Template package failed deserialization.",
      details: { err: err instanceof Error ? err.message : String(err) },
    });
  }
  if (pkg.meta.id !== ctx.params.id) {
    return problem("VALIDATION_FAILED", {
      status: 400,
      message: "Package id does not match route id.",
    });
  }

  // Wire real gate impls.
  const gauntletOpts: PublishGauntletOptions = {
    tokensGate: new RealTokensGate(extractNodes),
    a11yGate: new RealA11yGate(extractTokenMap, 3.0),
    perfGate: new RealPerfGate(countNodes, measureRenderMs, DEFAULT_PERF_BUDGET),
    fontsGate: new RealFontsGate(),
    compatGate: new RealCompatGate(CURRENT_OP_SCHEMA_VERSION, CURRENT_APP_VERSION),
    provenanceGate: new RealProvenanceGate(),
    reviewSamplingRate: body.reviewSamplingRate ?? 0.05,
  };

  const result = runPublishGauntlet(pkg, gauntletOpts);

  if (!result.ok) {
    await audit({
      actorId: user.id,
      actorKind: "user",
      action: "template.publish.failed",
      targetType: "share_link", // closest existing; real impl adds "template"
      targetId: pkg.meta.id,
      ip: ip(req),
      metadata: {
        failures: result.failures,
      },
    });
    return problem("VALIDATION_FAILED", {
      status: 422,
      message: "Template failed publish gauntlet.",
      details: { failures: result.failures },
    });
  }

  // Audit the publish. If human review is needed, the audit carries
  // the signal so the review queue can pick it up.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "template.publish",
    targetType: "share_link", // closest existing; real impl adds "template"
    targetId: pkg.meta.id,
    ip: ip(req),
    metadata: {
      semver: pkg.meta.semver,
      aiAssisted: pkg.meta.aiAssisted,
      needsHumanReview: result.needsHumanReview,
    },
  });

  return ok({
    templateId: pkg.meta.id,
    semver: pkg.meta.semver,
    needsHumanReview: result.needsHumanReview,
  });
}
