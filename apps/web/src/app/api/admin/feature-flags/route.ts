import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listFlags, createFlag, type FlagKind, type FlagTargets } from "@/lib/feature-flags/service";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import { FlagError } from "@/lib/feature-flags/service";

/**
 * GET /api/admin/feature-flags
 *   List all feature flags (sorted by key). Owner-only.
 *
 * POST /api/admin/feature-flags
 *   Create a new feature flag. Owner-only.
 *
 * Auth: admin session with minRole="owner" (feature flags are control-plane
 * config — only owners can create/modify them).
 *
 * Body (POST):
 *   {
 *     "key":         "new_dashboard",        // lowercase, [a-z0-9_], max 64
 *     "kind":        "feature",              // 'feature' | 'kill_switch' (default 'feature')
 *     "enabled":     false,                  // default false
 *     "rolloutPct":  0,                      // 0-100 (default 0)
 *     "targets":     { "plans": ["pro"] },   // optional
 *     "description": "The new dashboard UI", // required
 *     "owner":       "team-frontend"         // required — who to page
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "key must be lowercase, [a-z0-9_], start with a letter, max 64 chars"),
  kind: z.enum(["feature", "kill_switch"]).default("feature"),
  enabled: z.boolean().default(false),
  rolloutPct: z.number().int().min(0).max(100).default(0),
  targets: z.object({
    plans: z.array(z.string()).optional(),
    workspaces: z.array(z.string().uuid()).optional(),
    users: z.array(z.string().uuid()).optional(),
  }).default({}),
  description: z.string().min(1).max(500),
  owner: z.string().min(1).max(200),
});

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const items = await listFlags();
    const res = NextResponse.json({ items }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/feature-flags");
  }
}

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const body = await req.json();
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const flag = await createFlag({
      key: parsed.data.key,
      kind: parsed.data.kind as FlagKind,
      enabled: parsed.data.enabled,
      rolloutPct: parsed.data.rolloutPct,
      targets: parsed.data.targets as FlagTargets,
      description: parsed.data.description,
      owner: parsed.data.owner,
    });

    const res = NextResponse.json(flag, { status: 201 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    if (err instanceof FlagError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }
    return errorResponse(err, "/api/admin/feature-flags");
  }
}
