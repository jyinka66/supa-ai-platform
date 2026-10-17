// Presign a read (GET) URL for a file backing a share link.
//
// Two dispositions:
//   - "view"       → inline (browser renders — images, PDFs, video).
//   - "download"   → attachment (browser prompts to download).
//
// Expiry: 15 minutes. Short enough to limit URL leakage (the URL is bearer
// — anyone with it can read the file for its lifetime), long enough for the
// viewer to actually load the file (large files take time).
//
// The storage key is looked up via the ShareLinkRow passed in (already
// joined in by-token.ts). No DB hit here — pure presign.
//
// SECURITY: the presigned URL's signature binds the storage_key, so a viewer
// cannot mutate the URL to access a different file. The content-disposition
// is set at presign time (response-content-disposition query param) — the
// object store enforces it; the viewer cannot override it via URL params
// (S3/R2/Supabase Storage strip/ignore client-supplied response-* params).
//
// Stub: the real impl uses the storage provider's presigned GET API.
// (This is the same stub as files/upload.ts's presignGet — consolidated here
//  so the share flow + the upload/download flow share one storage adapter.
//  TODO: extract a shared `lib/storage/client.ts` once a real provider is
//  wired — S3/R2/Supabase Storage.)

import type { ShareLinkRow } from "./by-token";

const PRESIGN_EXPIRY_SECONDS = 15 * 60; // 15 minutes.

export interface PresignOpts {
  /** "attachment" forces download; "inline" lets the browser render. */
  disposition?: "attachment" | "inline";
}

/**
 * Presign a GET URL for the file backing the share link.
 *
 * Returns the URL + the file ID (the caller includes fileId in the response
 * so the client can render the file metadata if it wants).
 *
 * `d15min` is the spec's duration constant — we use seconds internally.
 */
export async function presignRead(
  link: ShareLinkRow,
  opts?: PresignOpts,
): Promise<{ url: string; fileId: string }> {
  const disposition = opts?.disposition ?? "inline";
  return presignGet(link.storageKey as string, {
    expiresSeconds: PRESIGN_EXPIRY_SECONDS,
    responseDisposition: disposition,
    fileName: link.fileName,
  }).then((url) => ({ url, fileId: link.fileId }));
}

/**
 * Presign a GET URL.
 *
 * Stub — in production, use one of:
 *   - AWS S3: `s3.getSignedUrl("getObject", { Bucket, Key, Expires,
 *       ResponseContentDisposition: "attachment; filename=..." })`
 *   - Supabase Storage: `supabase.storage.from(bucket).createSignedUrl(key,
 *       900, { download: disposition === "attachment" ? fileName : false })`
 *   - Cloudflare R2: `R2.createSignedUrl(key, { method: "GET", expiresIn: 900 })`
 *
 * The content-disposition is bound into the signature — clients cannot
 * override it via URL params.
 */
async function presignGet(
  key: string,
  opts: {
    expiresSeconds: number;
    responseDisposition: "attachment" | "inline";
    fileName: string;
  },
): Promise<string> {
  const base = process.env.STORAGE_URL || "https://storage.example.com";
  const params = new URLSearchParams({
    expires: String(opts.expiresSeconds),
    "response-content-disposition":
      opts.responseDisposition === "attachment"
        ? `attachment; filename="${encodeURIComponent(opts.fileName)}"`
        : "inline",
  });
  return `${base}/${key}?${params.toString()}`;
}
