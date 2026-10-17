import { getSpMetadata } from "@/lib/sso/saml";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return new Response(getSpMetadata(), { headers: { "Content-Type": "application/xml" } });
}
