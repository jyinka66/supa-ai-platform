// GET /api/supa-os/catalog/kyc-providers
//
// Returns the African KYC providers catalog (Persona, Onfido, Sumsub, Jumio,
// Veriff, Mono, BVN Verify, NIP Verification) — used by fintech builds.
//
// Auth: admin session (read_only).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { AFRICAN_KYC_PROVIDERS } from "@/lib/supa-os/fintech-engine";
import { KYC_PROVIDERS } from "@/lib/supa-os/fintech-primitives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    providers: KYC_PROVIDERS,
    africanProviders: AFRICAN_KYC_PROVIDERS,
    total: KYC_PROVIDERS.length + AFRICAN_KYC_PROVIDERS.length,
  });
});
