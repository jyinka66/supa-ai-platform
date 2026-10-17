import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { supabaseServer } from "@/lib/supabase/server";
import { STORAGE_BUCKET, MAX_FILE_SIZE_BYTES, isAllowedMimeType, fileExtension, originalPath } from "@/lib/storage/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().min(1).max(MAX_FILE_SIZE_BYTES),
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid().optional(), // for replace-file; omit for new uploads
}).strict();

/**
 * POST /api/uploads/sign
 *
 * Returns a presigned upload URL for direct-to-storage uploads.
 *
 * The client uploads the file directly to Supabase Storage using the
 * presigned URL — the server never handles the file bytes.
 *
 * Flow:
 *   1. Client: POST /api/uploads/sign { filename, mimeType, size, workspaceId, itemId? }
 *   2. Server: validates, generates presigned URL, returns { url, path, token }
 *   3. Client: PUT file to the presigned URL
 *   4. Client: POST /api/work/items or PATCH /api/work/items/:id with { fileUrl: path }
 *
 * Rate-limited at `default` tier.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown;
  try { body = await req.json(); } catch { return problem(400, "invalid_json"); }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return problem(400, "invalid_request", parsed.error.issues[0]?.message);

  const { filename, mimeType, size, workspaceId } = parsed.data;

  // Validate MIME type.
  if (!isAllowedMimeType(mimeType)) {
    return problem(400, "invalid_mime_type", `MIME type "${mimeType}" is not allowed.`);
  }

  // Validate size (already checked by Zod, but double-check).
  if (size > MAX_FILE_SIZE_BYTES) {
    return problem(413, "payload_too_large", undefined, {
      maxBytes: MAX_FILE_SIZE_BYTES,
    });
  }

  // Generate the storage path.
  const itemId = parsed.data.itemId ?? crypto.randomUUID();
  const ext = fileExtension(filename, mimeType);
  const path = originalPath(workspaceId, itemId, ext);

  // Create a presigned upload URL via Supabase Storage.
  const supabase = await supabaseServer();
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    return problem(500, "upload_sign_failed", error?.message);
  }

  return ok({
    uploadUrl: data.signedUrl,
    path,
    token: data.token,
    itemId,
    filename,
    mimeType,
    size,
    expiresInSeconds: 3600, // 1 hour
  });
}
