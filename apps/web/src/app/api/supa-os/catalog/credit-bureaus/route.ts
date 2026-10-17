// GET /api/supa-os/catalog/credit-bureaus
//
// Returns the credit bureau catalog — 6 licensed bureaus across US/UK/global
// (Experian, TransUnion, Equifax) and emerging markets (CRC Nigeria,
// Creditinfo, Metropol Kenya).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { CREDIT_BUREAUS } from "@/lib/supa-os/fintech-primitives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    bureaus: CREDIT_BUREAUS,
    total: CREDIT_BUREAUS.length,
    licensedCount: CREDIT_BUREAUS.filter((b) => b.licensed).length,
    realtimeCount: CREDIT_BUREAUS.filter((b) => b.supportsRealtime).length,
  });
});
