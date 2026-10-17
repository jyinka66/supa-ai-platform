import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getSdkInfo, listAvailableSdkVersions, type SdkLanguage } from "@/lib/platform/developer-ecosystem";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req);
    const url = new URL(req.url);
    const lang = url.searchParams.get("lang") as SdkLanguage | undefined;

    if (lang) {
      const sdkInfo = await getSdkInfo(lang);
      const res = NextResponse.json(sdkInfo, { status: 200 });
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
      res.headers.set("X-Request-Id", rid);
      return res;
    }

    const [ts, py, versions] = await Promise.all([
      getSdkInfo("typescript"),
      getSdkInfo("python"),
      listAvailableSdkVersions(),
    ]);
    const res = NextResponse.json({ sdks: { typescript: ts, python: py }, versions }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/platform/developers");
  }
}
