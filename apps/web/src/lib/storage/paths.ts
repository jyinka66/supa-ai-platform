/**
 * Storage layout for work item files.
 *
 * Path structure:
 *   {workspace_id}/{item_id}/
 *     original.{ext}        — never mutated (immutable)
 *     thumb_320.webp        — generated async (thumbnail, 320px wide)
 *     thumb_1024.webp        — generated async (preview, 1024px wide)
 *     exports/{hash}.pdf    — cached generated exports (keyed by content hash)
 *
 * Design principles:
 *   1. Files are keyed by (workspace_id, item_id) — never by user, so
 *      ownership transfers don't require file moves.
 *   2. Originals are immutable — edits create new versions
 *      (work_item_versions table), never overwrite the original.
 *   3. Thumbnails are always WebP (smaller + better quality than JPEG/PNG).
 *   4. Exports are content-addressed ({hash}.pdf) so the same export
 *      isn't regenerated.
 *
 * Storage backend: Supabase Storage (S3-compatible). In dev, uses the
 * local Supabase storage container.
 */

/**
 * Returns the storage path for a work item's original file.
 *
 * @example
 *   originalPath("ws-123", "item-456", "pdf")
 *   // → "ws-123/item-456/original.pdf"
 */
export function originalPath(
  workspaceId: string,
  itemId: string,
  extension: string,
): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return `${workspaceId}/${itemId}/original.${safeExt}`;
}

/**
 * Returns the storage path for a work item's thumbnail.
 *
 * @example
 *   thumbnailPath("ws-123", "item-456", 320)
 *   // → "ws-123/item-456/thumb_320.webp"
 */
export function thumbnailPath(
  workspaceId: string,
  itemId: string,
  size: 320 | 1024,
): string {
  return `${workspaceId}/${itemId}/thumb_${size}.webp`;
}

/**
 * Returns the storage path for a cached export.
 *
 * @example
 *   exportPath("ws-123", "item-456", "abc123def456")
 *   // → "ws-123/item-456/exports/abc123def456.pdf"
 */
export function exportPath(
  workspaceId: string,
  itemId: string,
  contentHash: string,
  format: "pdf" | "png" | "svg" = "pdf",
): string {
  const safeHash = contentHash.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return `${workspaceId}/${itemId}/exports/${safeHash}.${format}`;
}

/**
 * Returns the storage bucket name.
 *
 * In Supabase Storage, buckets are top-level containers. We use a single
 * "work-items" bucket and partition by path (workspace_id/item_id/...).
 */
export const STORAGE_BUCKET = "work-items";

/**
 * Max file size per upload (50 MB).
 * Larger files should use direct-to-S3 uploads with presigned URLs.
 */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Allowed MIME types for uploads.
 * Add to this list as new upload types are supported.
 */
export const ALLOWED_MIME_TYPES = [
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  // Code
  "text/javascript",
  "text/typescript",
  "text/html",
  "text/css",
  "application/x-yaml",
] as const;

/**
 * Validates that a MIME type is allowed for upload.
 */
export function isAllowedMimeType(mime: string): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Extracts the file extension from a filename or MIME type.
 */
export function fileExtension(filename: string, mime?: string): string {
  const fromName = filename.split(".").pop();
  if (fromName && fromName.length > 0 && fromName.length <= 5) {
    return fromName;
  }
  if (mime) {
    const mimeToExt: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "application/pdf": "pdf",
      "text/plain": "txt",
      "text/markdown": "md",
      "text/csv": "csv",
      "application/json": "json",
      "text/javascript": "js",
      "text/typescript": "ts",
      "text/html": "html",
      "text/css": "css",
      "application/x-yaml": "yaml",
    };
    return mimeToExt[mime] ?? "bin";
  }
  return "bin";
}
