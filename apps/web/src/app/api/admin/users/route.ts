import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { db } from "@supa/db";
import { adminUsers } from "@supa/db/schema";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import type { AdminRole } from "@/lib/admin/auth";

/**
 * GET /api/admin/users
 *
 * List all admins (owner-only). For the admin management UI — shows who has
 * control-plane access, their role, MFA status, last review, revoked state.
 *
 * Query params:
 *   ?status=active|revoked|pending  — filter by admin state (default: all)
 *   ?role=owner|senior|standard|support|read_only  — filter by role
 *
 * Response 200:
 *   {
 *     "items": [
 *       {
 *         "userId": "...",
 *         "role": "owner",
 *         "mfaEnrolled": true,
 *         "acceptedAt": "...",
 *         "revokedAt": null,
 *         "quarterlyReviewedAt": "...",
 *         "invitedAt": "...",
 *         "daysSinceReview": 45
 *       }
 *     ]
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AdminListRow {
  userId: string;
  role: AdminRole;
  mfaEnrolled: boolean;
  ipAllowlist: string[] | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  quarterlyReviewedAt: Date | null;
  invitedAt: Date | null;
  daysSinceReview: number | null;
}

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status"); // active|revoked|pending
    const roleFilter = url.searchParams.get("role");

    // Build the WHERE clause.
    const conditions = [];
    if (statusFilter === "active") {
      conditions.push(isNull(adminUsers.revokedAt), isNotNull(adminUsers.acceptedAt));
    } else if (statusFilter === "revoked") {
      conditions.push(isNotNull(adminUsers.revokedAt));
    } else if (statusFilter === "pending") {
      conditions.push(isNull(adminUsers.revokedAt), isNull(adminUsers.acceptedAt));
    }
    if (roleFilter && ["owner", "senior", "standard", "support", "read_only"].includes(roleFilter)) {
      conditions.push(eq(adminUsers.role, roleFilter));
    }

    const rows = await db
      .select({
        userId: adminUsers.userId,
        role: adminUsers.role,
        mfaEnrolled: adminUsers.mfaEnrolled,
        ipAllowlist: adminUsers.ipAllowlist,
        acceptedAt: adminUsers.acceptedAt,
        revokedAt: adminUsers.revokedAt,
        quarterlyReviewedAt: adminUsers.quarterlyReviewedAt,
        invitedAt: adminUsers.invitedAt,
      })
      .from(adminUsers)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(adminUsers.createdAt));

    const now = Date.now();
    const items: AdminListRow[] = rows.map((r) => {
      const reviewedAt = r.quarterlyReviewedAt;
      const daysSinceReview = reviewedAt
        ? Math.floor((now - reviewedAt.getTime()) / 86400000)
        : null;
      return {
        userId: r.userId as string,
        role: r.role as AdminRole,
        mfaEnrolled: r.mfaEnrolled,
        ipAllowlist: r.ipAllowlist ?? null,
        acceptedAt: r.acceptedAt,
        revokedAt: r.revokedAt,
        quarterlyReviewedAt: reviewedAt,
        invitedAt: r.invitedAt,
        daysSinceReview,
      };
    });

    const res = NextResponse.json({ items }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/users");
  }
}
