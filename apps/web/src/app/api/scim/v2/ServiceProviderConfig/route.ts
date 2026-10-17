import { serviceProviderConfig } from "@/lib/scim/routes-v2";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return serviceProviderConfig(); }
