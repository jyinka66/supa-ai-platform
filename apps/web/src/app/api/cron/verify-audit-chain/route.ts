// Cron job: verify-audit-chain
// Triggered by a scheduled job (Vercel Cron / external scheduler).
// Protected by a CRON_SECRET header check (the secret is in env).

import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron/auth";

export async function POST(req: NextRequest) {
  // Verify the CRON_SECRET header.
  const secret = req.headers.get("authorization");
  if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await run();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[cron:verify-audit-chain] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}

async function run(): Promise<unknown> {
  // Delegate to the service function.
  switch (process.env.CRON_JOB ?? "verify-audit-chain") {
    case "verify-audit-chain": {
      const { verifyChain } = await import("@/lib/audit/service");
      const result = await verifyChain();
      if (!result.ok) {
        // ALERT + PAGE ON-CALL (the alerting is a separate concern —
        // this route returns the broken state; the monitoring stack alerts).
        console.error("[cron:verify-audit-chain] CHAIN BROKEN at seq:", result.brokenAt);
      }
      return result;
    }
    default:
      throw new Error(`unknown cron job: ${process.env.CRON_JOB ?? "unset"}`);
  }
}

export const dynamic = "force-dynamic";
