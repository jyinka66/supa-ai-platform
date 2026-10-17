import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listDecisions, type RiskLevel, type GovernanceDecision } from "@/lib/governance/decision-engine";
import { listKillSwitches, activateKillSwitch, deactivateKillSwitch } from "@/lib/governance/kill-switches";
import { verifyPrinciples, getPrincipleSummary } from "@/lib/governance/principles";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const url = new URL(req.url);
    const targetType = url.searchParams.get("targetType") ?? undefined;
    const riskLevel = url.searchParams.get("riskLevel") as RiskLevel | undefined;
    const decision = url.searchParams.get("decision") as GovernanceDecision | undefined;
    const wsId = url.searchParams.get("wsId") ?? undefined;

    const [decisions, killSwitches, principles] = await Promise.all([
      listDecisions({ ...(targetType ? { targetType } : {}), ...(riskLevel ? { riskLevel } : {}), ...(decision ? { decision } : {}), ...(wsId ? { wsId } : {}) }),
      listKillSwitches({ activeOnly: url.searchParams.get("activeOnly") === "true" }),
      Promise.resolve({ checks: verifyPrinciples(), summary: getPrincipleSummary() }),
    ]);

    const res = NextResponse.json({ decisions, killSwitches, principles }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/governance/decisions");
  }
}

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const body = await req.json();

    // Activate or deactivate a kill switch.
    if (body.action === "activate_kill_switch") {
      await activateKillSwitch({ key: body.key, reason: body.reason, autoDeactivateInHours: body.autoDeactivateInHours });
    } else if (body.action === "deactivate_kill_switch") {
      const ctx = await requireAdminSession(req, "owner");
      await deactivateKillSwitch({ key: body.key, deactivatedBy: ctx.adminId, reason: body.reason });
    }

    const res = NextResponse.json({ ok: true }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/governance/decisions");
  }
}
