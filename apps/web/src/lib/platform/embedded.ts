// Embedded Supa AI — white-label provisioning + embeddable surfaces.
//
// The spec (14.2.6): "White-label provisioning — partners configure branding,
// domain, and settings in a self-serve portal. Embeddable surfaces — chat,
// design, agents embeddable via iframe or SDK."

import { db } from "@supa/db";
import { embeddedSurfaces } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SurfaceType = "chat" | "design" | "agents" | "full_app";
export type EmbedMethod = "iframe" | "sdk";
export type RevenueModel = "revenue_share" | "per_seat" | "usage_based";
export type SurfaceStatus = "pending" | "active" | "suspended" | "terminated";

export interface EmbeddedSurface {
  id: string;
  partnerOrgId: string;
  surfaceType: SurfaceType;
  brandName: string;
  brandLogoUrl: string | null;
  brandColors: Record<string, string>;
  customDomain: string | null;
  allowedOrigins: string[];
  embedMethod: EmbedMethod;
  versionPinned: string;
  autoUpdate: boolean;
  revenueModel: RevenueModel;
  revenueConfig: Record<string, unknown>;
  verified: boolean;
  totalEmbeds: number;
  totalRevenueUsd: number;
  status: SurfaceStatus;
  createdAt: Date;
}

export interface ProvisionSurfaceInput {
  partnerOrgId: string;
  surfaceType: SurfaceType;
  brandName: string;
  brandLogoUrl?: string;
  brandColors?: Record<string, string>;
  customDomain?: string;
  allowedOrigins: string[];
  embedMethod?: EmbedMethod;
  revenueModel: RevenueModel;
  revenueConfig: Record<string, unknown>;
}

// ───────────────────────────────────────────────
// provisionSurface — self-serve white-label provisioning.
// ───────────────────────────────────────────────

export async function provisionSurface(input: ProvisionSurfaceInput): Promise<EmbeddedSurface> {
  // Automated compliance checks (stub — would verify domain ownership, SSL, etc.).
  const verified = await runComplianceChecks(input);

  const rows = await db
    .insert(embeddedSurfaces)
    .values({
      partnerOrgId: input.partnerOrgId as any,
      surfaceType: input.surfaceType,
      brandName: input.brandName,
      ...(input.brandLogoUrl ? { brandLogoUrl: input.brandLogoUrl } : {}),
      brandColors: input.brandColors ?? { primary: "#3B82F6", accent: "#8B5CF6" },
      ...(input.customDomain ? { customDomain: input.customDomain } : {}),
      allowedOrigins: input.allowedOrigins,
      embedMethod: input.embedMethod ?? "iframe",
      revenueModel: input.revenueModel,
      revenueConfig: input.revenueConfig,
      verified,
      status: verified ? "active" : "pending",
    })
    .returning({ id: embeddedSurfaces.id });

  const id = rows[0]?.id as string;
  if (!id) throw new Error("surface_insert_failed");

  await adminAudit({
    actor: "system",
    action: "embedded.surface.provisioned",
    target: { surfaceId: id, partnerOrgId: input.partnerOrgId, surfaceType: input.surfaceType, verified },
    justification: `Embedded surface provisioned for ${input.brandName}`,
  });

  return (await getSurface(id))!;
}

// ───────────────────────────────────────────────
// runComplianceChecks — automated verification.
// ───────────────────────────────────────────────

async function runComplianceChecks(input: ProvisionSurfaceInput): Promise<boolean> {
  // STUB: the real impl would:
  //   1. Verify domain ownership (DNS TXT record or HTML meta tag).
  //   2. Check SSL certificate validity.
  //   3. Verify origin allowlist domains are valid + owned.
  //   4. Check partner org reputation.
  //   5. Scan the brand for trademark conflicts.
  return true; // auto-verified for now.
}

// ───────────────────────────────────────────────
// verifyOrigin — check if an origin is allowed for a surface.
// ───────────────────────────────────────────────

export function isOriginAllowed(surface: EmbeddedSurface, origin: string): boolean {
  return surface.allowedOrigins.includes(origin);
}

// ───────────────────────────────────────────────
// recordEmbed — track embed usage + revenue.
// ───────────────────────────────────────────────

export async function recordEmbed(surfaceId: string, revenueUsd?: number): Promise<void> {
  await db.execute(sql`
    update embedded_surfaces
       set total_embeds = total_embeds + 1,
           ${revenueUsd != null ? sql`total_revenue_usd = total_revenue_usd + ${revenueUsd},` : sql``}
           updated_at = now()
     where id = ${surfaceId}::uuid
  `);
}

// ───────────────────────────────────────────────
// updateVersion — pin/update the embedded version.
// ───────────────────────────────────────────────

export async function updateVersion(surfaceId: string, version: string, autoUpdate?: boolean): Promise<void> {
  await db
    .update(embeddedSurfaces)
    .set({
      versionPinned: version,
      ...(autoUpdate !== undefined ? { autoUpdate } : {}),
      updatedAt: new Date(),
    })
    .where(eq(embeddedSurfaces.id, surfaceId as any));
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getSurface(id: string): Promise<EmbeddedSurface | null> {
  const rows = await db.select().from(embeddedSurfaces).where(eq(embeddedSurfaces.id, id as any)).limit(1);
  return mapRow(rows[0]);
}

export async function listSurfaces(partnerOrgId: string): Promise<EmbeddedSurface[]> {
  const rows = await db
    .select()
    .from(embeddedSurfaces)
    .where(eq(embeddedSurfaces.partnerOrgId, partnerOrgId as any))
    .orderBy(embeddedSurfaces.createdAt);

  return rows.map(mapRow).filter((s): s is EmbeddedSurface => s !== null);
}

function mapRow(row: Record<string, unknown> | undefined): EmbeddedSurface | null {
  if (!row) return null;
  return {
    id: row.id as string,
    partnerOrgId: row.partnerOrgId as string,
    surfaceType: row.surfaceType as SurfaceType,
    brandName: row.brandName as string,
    brandLogoUrl: (row.brandLogoUrl as string | null) ?? null,
    brandColors: (row.brandColors as Record<string, string>) ?? {},
    customDomain: (row.customDomain as string | null) ?? null,
    allowedOrigins: (row.allowedOrigins as string[]) ?? [],
    embedMethod: row.embedMethod as EmbedMethod,
    versionPinned: row.versionPinned as string,
    autoUpdate: row.autoUpdate as boolean,
    revenueModel: row.revenueModel as RevenueModel,
    revenueConfig: (row.revenueConfig as Record<string, unknown>) ?? {},
    verified: row.verified as boolean,
    totalEmbeds: row.totalEmbeds as number,
    totalRevenueUsd: Number(row.totalRevenueUsd ?? 0),
    status: row.status as SurfaceStatus,
    createdAt: row.createdAt as Date,
  };
}
