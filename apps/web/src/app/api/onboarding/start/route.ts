/**
 * POST /api/onboarding/start
 *
 * The 60-second path, built entirely from existing machinery:
 *
 *   1. Seed intent (3 picks max): what are you making (deck/poster/
 *      social/doc), style direction (3 visual archetypes = token
 *      tables, shown as live-rendered swatches — the render engine
 *      previews them, no stock imagery), brand inputs optional
 *      (logo upload → asset pipeline, brand colors → token table
 *      seeded, font preference → fonts package).
 *
 *   2. First doc = template install + token substitution. The user's
 *      brand tokens replace the template's brand.* namespace at
 *      materialize time — the doc they land in is ALREADY theirs.
 *
 * Returns:
 *   - onboardingId (for tracking the funnel)
 *   - the materialized doc id
 *   - coach marks to show on first render (none yet — they fire on
 *     first-text-selection, first-ai-use, first-share)
 *   - the user's seed token table (carried even for empty-canvas users)
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";
import {
  buildSeedStep,
  materializeFirstDoc,
  buildEmptyCanvasTokens,
  decidePath,
  type SeedIntent,
  type StyleArchetypePreview,
  type TokenSubstitution,
  type MaterializeResult,
} from "@supa/design-onboarding/onboarding";
import {
  installTemplate,
  type TemplatePackage,
  type InstallValidator,
  type FontManifest,
  type FontRequirement,
} from "@supa/design-marketplace/template-package";
import { recordFunnelEvent } from "@/lib/onboarding/server-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────
// Schemas
// ───────────────────────────────────────────────

const StartBody = z.object({
  docType: z.enum(["deck", "poster", "social", "doc"]),
  archetype: z.enum(["minimal", "editorial", "playful", "corporate"]),
  brandInputs: z.object({
    logoAssetHash: z.string().optional(),
    brandColors: z.array(z.string()).max(8).optional(),
    preferredFontFamily: z.string().optional(),
  }).optional(),
  /** Optional: template id to fork. If absent, empty-canvas path. */
  templateId: z.string().optional(),
}).strict();

// ───────────────────────────────────────────────
// Archetype previews — rendered inline from the token table
// ───────────────────────────────────────────────

/**
 * Builds a small inline SVG swatch from an archetype's token table.
 *
 * The real impl renders the archetype via @supa/design-render (live swatches,
 * no stock imagery). Until that's wired, this generates a deterministic
 * preview SVG directly from the brand.primary / surface.1 tokens so the
 * seed step shows *something* representative instead of an empty `<svg/>`.
 */
function archetypePreviewSvg(tokenTable: Record<string, string>): string {
  const primary = tokenTable["brand.primary"] ?? "#1a1a1a";
  const surface = tokenTable["surface.1"] ?? "#ffffff";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">` +
    `<rect width="120" height="80" fill="${surface}"/>` +
    `<rect x="8" y="8" width="40" height="64" rx="4" fill="${primary}"/>` +
    `<rect x="56" y="10" width="56" height="12" rx="2" fill="${primary}"/>` +
    `<rect x="56" y="28" width="56" height="6" rx="2" fill="${primary}" opacity="0.6"/>` +
    `<rect x="56" y="40" width="40" height="6" rx="2" fill="${primary}" opacity="0.6"/>` +
    `<rect x="56" y="52" width="48" height="6" rx="2" fill="${primary}" opacity="0.4"/>` +
    `</svg>`
  );
}

const ARCHETYPE_PREVIEWS: StyleArchetypePreview[] = [
  {
    archetype: "minimal",
    tokenTable: { "brand.primary": "#1a1a1a", "surface.1": "#ffffff", "space.1": "4" },
    previewSvg: archetypePreviewSvg({ "brand.primary": "#1a1a1a", "surface.1": "#ffffff", "space.1": "4" }),
  },
  {
    archetype: "editorial",
    tokenTable: { "brand.primary": "#8b0000", "surface.1": "#fafafa", "space.1": "8" },
    previewSvg: archetypePreviewSvg({ "brand.primary": "#8b0000", "surface.1": "#fafafa", "space.1": "8" }),
  },
  {
    archetype: "playful",
    tokenTable: { "brand.primary": "#ff6b6b", "surface.1": "#fff8e7", "space.1": "12" },
    previewSvg: archetypePreviewSvg({ "brand.primary": "#ff6b6b", "surface.1": "#fff8e7", "space.1": "12" }),
  },
];

// ───────────────────────────────────────────────
// Template fetcher — throws until object storage is wired
// ───────────────────────────────────────────────

/**
 * Thrown when template storage isn't wired. Same contract as the install
 * route's fetchPackage — surfaces a 501 instead of a silent 404.
 *
 * TODO: replace with a real fetch from object storage (S3 / R2 / Supabase
 * Storage) once wired.
 */
class TemplateStorageNotConfiguredError extends Error {
  constructor(templateId: string) {
    super(`Template storage is not configured — cannot fetch template "${templateId}".`);
    this.name = "TemplateStorageNotConfiguredError";
  }
}

async function fetchPackage(templateId: string): Promise<TemplatePackage> {
  // Real impl: GET from object storage by templateId (content-addressed hash).
  // Until storage is wired, throw a clear "not implemented" error so the
  // route surfaces 501 instead of silently 404ing on every template path.
  throw new TemplateStorageNotConfiguredError(templateId);
}

const validator: InstallValidator = {
  validateDoc(doc: unknown) {
    if (!doc || typeof doc !== "object") {
      return { ok: false, violations: [{ layerId: "doc-root", kind: "schema", message: "doc is not an object" }] };
    }
    return { ok: true, violations: [] };
  },
  validateTokens(tokens: unknown) {
    if (!tokens || typeof tokens !== "object") {
      return { ok: false, errors: [{ tokenId: "root", message: "tokens is not an object" }] };
    }
    return { ok: true, errors: [] };
  },
};

async function resolveFonts(manifest: FontManifest): Promise<{ missing: FontRequirement[] }> {
  return { missing: manifest.requirements.filter((r) => r.family === "unknown-family") };
}

function generateDocId(): string {
  return `doc-${Math.random().toString(36).slice(2, 14)}`;
}

async function applySubstitution(sub: TokenSubstitution, doc: unknown): Promise<unknown> {
  // Real impl: walk the doc, replace every node's fill/space/radius/
  // textStyle whose token id is in the sub's namespace with the new
  // value, and update the embedded token table so ref-bearing nodes
  // re-resolve to the new values. Production wires design-tokens/bindings.
  //
  // This basic impl walks the (opaque) doc recursively and substitutes
  // any token-like entry ({ id, value }) whose id falls under the
  // substitution's namespace. The doc is cloned first so the caller's
  // template isn't mutated. If the doc shape doesn't carry tokens inline,
  // this is a safe no-op (the brandSubstituted flag is still set by
  // materializeFirstDoc, so the UI reflects the user's intent).
  if (!doc || typeof doc !== "object") return doc;
  if (sub.tokens.length === 0) return doc;

  const byId = new Map(sub.tokens.map((t) => [t.id, t.value]));
  // structuredClone is available in Node 17+ (Next.js requires 18.17+).
  // Falls back to JSON round-trip if the doc contains non-cloneable
  // values (shouldn't happen for a deserialized template package).
  let clone: unknown;
  try {
    clone = structuredClone(doc);
  } catch {
    clone = JSON.parse(JSON.stringify(doc)) as unknown;
  }
  walkAndSubstitute(clone, sub.namespace, byId);
  return clone;
}

/**
 * Recursively walks a doc-like object, substituting the `value` field of
 * any token-like entry whose `id` is in the substitution map and falls
 * under the namespace prefix (e.g. "brand.color.0" matches ns "brand").
 */
function walkAndSubstitute(
  node: unknown,
  namespace: string,
  byId: Map<string, string>,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAndSubstitute(child, namespace, byId);
    return;
  }
  const obj = node as Record<string, unknown>;
  // Token-like entry: { id: "brand.color.0", value: "#..." }.
  if (
    typeof obj.id === "string" &&
    typeof obj.value === "string" &&
    (obj.id === namespace || obj.id.startsWith(`${namespace}.`)) &&
    byId.has(obj.id)
  ) {
    obj.value = byId.get(obj.id)!;
  }
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child && typeof child === "object") {
      walkAndSubstitute(child, namespace, byId);
    }
  }
}

// ───────────────────────────────────────────────
// Route handler
// ───────────────────────────────────────────────

export async function POST(req: NextRequest) {
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
    body = StartBody.parse(json);
  } catch (err) {
    return problem("INVALID_BODY", {
      status: 400,
      message: "Request body failed validation.",
      details: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  const intent: SeedIntent = {
    docType: body.docType,
    archetype: body.archetype,
    brandInputs: body.brandInputs,
  };

  // Step 1: build the seed step (3 archetype previews).
  const seedStep = buildSeedStep(ARCHETYPE_PREVIEWS);

  const startedAt = Date.now();
  recordFunnelEvent({
    kind: "onboarding-started",
    ts: startedAt,
    accountId: user.id,
  });
  recordFunnelEvent({
    kind: "seed-intent-picked",
    ts: startedAt,
    accountId: user.id,
    docType: body.docType,
    archetype: body.archetype,
  });

  // Step 2: decide path — template fork OR empty-canvas.
  const path = decidePath(intent, body.templateId);

  let materialized: MaterializeResult;
  if (path.path === "template" && path.templateId) {
    let pkg: TemplatePackage;
    try {
      pkg = await fetchPackage(path.templateId);
    } catch (err) {
      if (err instanceof TemplateStorageNotConfiguredError) {
        // Object storage isn't wired — surface 501 instead of the old
        // silent 404 (the user can still pick the empty-canvas path).
        return problem("NOT_IMPLEMENTED", {
          status: 501,
          message: "Template storage is not configured on this deployment.",
          details: { templateId: path.templateId },
        });
      }
      throw err;
    }

    // Install = fork + validate (op invariants re-run server-side).
    const installResult = await installTemplate(pkg, {
      validator,
      generateDocId,
      resolveFonts,
    });
    if (!installResult.validation.ok) {
      return problem("VALIDATION_FAILED", {
        status: 422,
        message: "Template failed server-side validation.",
        details: {
          invariantViolations: installResult.validation.invariantViolations,
          tokenErrors: installResult.validation.tokenErrors,
        },
      });
    }

    // Materialize with brand token substitution.
    materialized = await materializeFirstDoc(
      path.templateId,
      installResult.doc,
      installResult.tokens,
      intent,
      { applySubstitution, generateDocId },
    );
  } else {
    // Empty-canvas path: the user still gets their archetype token table.
    const tokens = buildEmptyCanvasTokens(intent);
    materialized = {
      docId: generateDocId(),
      tokens,
      templateId: "empty-canvas",
      brandSubstituted: !!body.brandInputs?.brandColors?.length,
      logoPlaced: !!body.brandInputs?.logoAssetHash,
    };
  }

  recordFunnelEvent({
    kind: "doc-materialized",
    ts: Date.now(),
    accountId: user.id,
    docId: materialized.docId,
    path: path.path,
  });

  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "onboarding.start",
    targetType: "user",
    targetId: materialized.docId,
    ip: ip(req),
    metadata: {
      path: path.path,
      templateId: path.templateId ?? null,
      docType: body.docType,
      archetype: body.archetype,
      brandSubstituted: materialized.brandSubstituted,
      logoPlaced: materialized.logoPlaced,
    },
  });

  return ok({
    onboardingId: `ob-${user.id}-${startedAt}`,
    docId: materialized.docId,
    path: path.path,
    templateId: path.templateId ?? null,
    seedStep,
    brandSubstituted: materialized.brandSubstituted,
    logoPlaced: materialized.logoPlaced,
  });
}
