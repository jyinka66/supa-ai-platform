import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import {
  getFlag,
  updateFlag,
  deleteFlag,
  setFlag,
  isConfirmationRequired,
  FlagError,
  type FlagKind,
  type FlagTargets,
  type UpdateFlagInput,
} from "@/lib/feature-flags/service";
import { ConfirmationRequiredError, ConfirmationError } from "@/lib/admin/confirmation";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/feature-flags/:key
 *   Get a single feature flag. Owner-only.
 *
 * PATCH /api/admin/feature-flags/:key
 *   Update a feature flag. Owner-only. Uses setFlag (confirmation-gated for
 *   kill_switches). The body must include `justification` (why the change
 *   was made — for the audit log) + optionally `typedPhrase` + `confirmationId`
 *   (for kill_switch 2nd-admin approval).
 *
 *   For kill_switches:
 *     1st call (no confirmationId) → 202 { confirmationRequired, confirmationId, phrase }
 *     2nd admin calls POST /confirm → approves
 *     1st admin re-calls PATCH with confirmationId → 200 (applied)
 *
 * DELETE /api/admin/feature-flags/:key
 *   Delete a feature flag. Owner-only. (Use PATCH enabled=false for a
 *   temporary disable — DELETE is for permanent removal.)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  kind: z.enum(["feature", "kill_switch"]).optional(),
  enabled: z.boolean().optional(),
  rolloutPct: z.number().int().min(0).max(100).optional(),
  targets: z.object({
    plans: z.array(z.string()).optional(),
    workspaces: z.array(z.string().uuid()).optional(),
    users: z.array(z.string().uuid()).optional(),
  }).optional(),
  description: z.string().min(1).max(500).optional(),
  owner: z.string().min(1).max(200).optional(),
  // setFlag fields:
  justification: z.string().min(1).max(1000),
  typedPhrase: z.string().optional(),
  confirmationId: z.string().uuid().optional(),
}).refine((d) => {
  // At least one patch field must be present (not just justification/phrase/confirmationId).
  const patchFields = ["kind", "enabled", "rolloutPct", "targets", "description", "owner"];
  return patchFields.some((f) => (d as Record<string, unknown>)[f] !== undefined);
}, { message: "empty_patch" });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rid = requestId(req);
  const { key } = await params;
  try {
    await requireAdminSession(req, "owner");
    const flag = await getFlag(key);
    if (!flag) {
      return NextResponse.json({ error: "flag_not_found" }, { status: 404 });
    }
    const res = NextResponse.json(flag, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/api/admin/feature-flags/${key}`);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rid = requestId(req);
  const { key } = await params;
  try {
    const ctx = await requireAdminSession(req, "owner");

    const body = await req.json();
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Extract the patch fields (everything except justification/phrase/confirmationId).
    const patch: UpdateFlagInput = {};
    if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind as FlagKind;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.rolloutPct !== undefined) patch.rolloutPct = parsed.data.rolloutPct;
    if (parsed.data.targets !== undefined) patch.targets = parsed.data.targets as FlagTargets;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.owner !== undefined) patch.owner = parsed.data.owner;

    // Use setFlag (confirmation-gated for kill_switches + audited with diff).
    const result = await setFlag(
      { adminId: ctx.adminId, role: ctx.role, sessionId: ctx.sessionId, ip: ctx.ip },
      key,
      patch,
      parsed.data.justification,
      {
        ...(parsed.data.typedPhrase ? { typedPhrase: parsed.data.typedPhrase } : {}),
        ...(parsed.data.confirmationId ? { confirmationId: parsed.data.confirmationId } : {}),
      },
    );

    const res = NextResponse.json(
      { flag: result.flag, auditSeq: result.auditSeq },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    // Confirmation required (kill_switch 2nd-admin) → 202.
    if (err instanceof ConfirmationRequiredError) {
      return NextResponse.json(
        {
          confirmationRequired: true,
          confirmationId: err.confirmationId,
          phrase: err.phrase,
          message: "2nd-admin approval required for kill_switch changes.",
        },
        { status: 202 },
      );
    }
    if (err instanceof ConfirmationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof FlagError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/feature-flags/${key}`);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const rid = requestId(req);
  const { key } = await params;
  try {
    await requireAdminSession(req, "owner");
    await deleteFlag(key);
    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof FlagError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err, `/api/admin/feature-flags/${key}`);
  }
}
