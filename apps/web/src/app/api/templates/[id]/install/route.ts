/**
 * POST /api/templates/:id/install
 *
 * Install a template = download package → validate (op invariants
 * re-run server-side on the snapshot — a template is untrusted
 * input, same funnel as user ops) → materialize a new doc from it.
 * No shared mutable template state: every install is a fork.
 *
 * Returns the new doc id + the forked doc/tokens + missing fonts
 * (listed honestly at install time, with license/price per axis).
 */

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";
import {
  installTemplate,
  type TemplatePackage,
  type InstallValidator,
  type FontManifest,
  type FontRequirement,
} from "@supa/design-marketplace/template-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────
// Stub package fetcher — real impl pulls from object storage
// ───────────────────────────────────────────────

/**
 * Thrown when template storage isn't wired. Surfaces as a 501 instead of
 * the silent 404 the previous `return null` stub produced.
 *
 * TODO: replace with a real fetch once object storage (S3 / R2 / Supabase
 * Storage) is wired. The real impl should GET the package by its
 * content-addressed hash and return null only when the template genuinely
 * doesn't exist (to map cleanly to the 404 below).
 */
class TemplateStorageNotConfiguredError extends Error {
  constructor(templateId: string) {
    super(`Template storage is not configured — cannot fetch template "${templateId}".`);
    this.name = "TemplateStorageNotConfiguredError";
  }
}

async function fetchPackage(templateId: string): Promise<TemplatePackage> {
  // Real impl: GET from object storage by templateId (content-addressed
  // hash). Returns null if not found.
  //
  // Until object storage is wired, throw a clear "not implemented" error
  // so the route surfaces 501 instead of silently 404ing on every install.
  throw new TemplateStorageNotConfiguredError(templateId);
}

// ───────────────────────────────────────────────
// Stub validators — real impls wire design-model's validateOp
// and design-tokens' validateTokenMap
// ───────────────────────────────────────────────

const validator: InstallValidator = {
  validateDoc(doc: unknown) {
    // Real impl: walk the doc, re-run design-model's validateOp on every
    // layer's invariants (parent exists, no cycles, finite coords, etc.).
    // A template is untrusted input — same funnel as user ops.
    if (!doc || typeof doc !== "object") {
      return { ok: false, violations: [{ layerId: "doc-root", kind: "schema", message: "doc is not an object" }] };
    }
    return { ok: true, violations: [] };
  },
  validateTokens(tokens: unknown) {
    // Real impl: call design-tokens' validateTokenMap, surface cycles
    // and unresolved refs.
    if (!tokens || typeof tokens !== "object") {
      return { ok: false, errors: [{ tokenId: "root", message: "tokens is not an object" }] };
    }
    return { ok: true, errors: [] };
  },
};

// ───────────────────────────────────────────────
// Stub font resolver — real impl checks design-fonts availability
// ───────────────────────────────────────────────

async function resolveFonts(manifest: FontManifest): Promise<{ missing: FontRequirement[] }> {
  // Real impl: check which font families + subsets are available locally
  // or via the fonts package. List missing fonts honestly with license
  // and price per axis — never silently substitute.
  return { missing: manifest.requirements.filter((r) => r.family === "unknown-family") };
}

// ───────────────────────────────────────────────
// Stub doc id generator — real impl uses ULID
// ───────────────────────────────────────────────

function generateDocId(): string {
  // Real impl: ULID from @supa/design-model/id
  return `doc-${Math.random().toString(36).slice(2, 14)}`;
}

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

  const templateId = ctx.params.id;
  let pkg: TemplatePackage;
  try {
    pkg = await fetchPackage(templateId);
  } catch (err) {
    if (err instanceof TemplateStorageNotConfiguredError) {
      // Surface as 501 — object storage isn't wired yet, so every install
      // fails the same way. This beats the old `return null` stub which
      // silently 404'd every request.
      return problem("NOT_IMPLEMENTED", {
        status: 501,
        message: "Template storage is not configured on this deployment.",
        details: { templateId },
      });
    }
    throw err;
  }

  // Install = fork + validate. The validator re-runs op invariants
  // server-side on the snapshot — a template is untrusted input,
  // same funnel as user ops.
  const result = await installTemplate(pkg, {
    validator,
    generateDocId,
    resolveFonts,
  });

  // If validation fails, refuse to materialize — never silently
  // persist garbage from a malicious template.
  if (!result.validation.ok) {
    await audit({
      actorId: user.id,
      actorKind: "user",
      action: "template.install.failed",
      targetType: "share_link", // closest existing target type; real impl adds "template"
      targetId: templateId,
      ip: ip(req),
      metadata: {
        invariantViolations: result.validation.invariantViolations,
        tokenErrors: result.validation.tokenErrors,
      },
    });
    return problem("VALIDATION_FAILED", {
      status: 422,
      message: "Template failed server-side validation.",
      details: {
        invariantViolations: result.validation.invariantViolations,
        tokenErrors: result.validation.tokenErrors,
      },
    });
  }

  // Audit the install — installs are a fork, so the new doc id is
  // recorded against the template id for lineage tracking.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "template.install",
    targetType: "share_link", // closest existing; real impl adds "template"
    targetId: templateId,
    ip: ip(req),
    metadata: {
      docId: result.docId,
      missingFonts: result.missingFonts.map((f: FontRequirement) => f.family),
    },
  });

  return ok({
    docId: result.docId,
    templateId,
    missingFonts: result.missingFonts,
  });
}
