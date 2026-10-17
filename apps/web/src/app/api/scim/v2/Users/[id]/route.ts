import { NextRequest } from "next/server";
import { handleScimPatch, handleScimDelete } from "@/lib/scim/routes-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleScimPatch(req, id);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleScimDelete(req, id);
}
