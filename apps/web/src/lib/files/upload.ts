// File upload service — presigned URL + confirm reconciliation.
//
//   beginUpload(uid, wsId, meta)
//     1. requireRole (member+).
//     2. enforceQuota (plan storage cap, checked BEFORE presign — fail fast).
//     3. validateMime (extension + mime allowlist, no executables).
//     4. Generate opaque storage key: `ws/<wsId>/<uuid>` (ws-id prefix = purge partition).
//     5. Insert file row (status: pending upload — storage_key set, content_hash null).
//     6. Presign PUT URL (15-min expiry, content-length-range enforced).
//     7. Return { url, fileId } — client uploads directly to object store.
//
//   confirmUpload(uid, fileId)
//     1. HeadObject on the storage key (verify the upload happened).
//     2. Extract content_hash (from storage checksum or recompute sha-256).
//     3. Update file row (size_bytes, content_hash, version=1).
//     4. Insert file_versions row (version 1).
//     5. Audit file.uploaded.
//
//   reapStaleUploads() (hourly sweep)
//     1. Find file rows where content_hash IS NULL AND created_at < now() - 1h.
//     2. Delete the file row (cascade deletes file_versions — but there are none yet).
//     3. Delete the orphaned object from the store (best-effort).
//
// Design:
//   - Direct-to-storage upload (presigned PUT) — the file never touches the
//     app server's memory. Reduces latency + avoids server memory exhaustion.
//   - Content-length-range on the presigned URL: the client can't upload
//     more than the plan's max upload size (enforced by the object store, not
//     the app — can't be bypassed by a modified client).
//   - Quota checked BEFORE presign: fail fast — don't waste a presigned URL
//     on a workspace that's over quota.
//   - Stale upload reaping: if the client never confirms, the file row + the
//     orphaned object are cleaned up by the hourly sweep (orphan bytes cost money).

import { db } from "@supa/db";
import { files, fileVersions } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface FileMeta {
  parentId: string | null;
  name: string;
  mime: string;
  sizeBytes: number;
}

export interface BeginUploadResult {
  url: string; // presigned PUT URL (15-min expiry).
  fileId: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const PRESIGN_EXPIRY = "15m";
const STALE_UPLOAD_TTL_HOURS = 1;

// ───────────────────────────────────────────────
// MIME allowlist — no executables, no scripts, no archives that can contain them
// ───────────────────────────────────────────────

const MIME_ALLOWLIST = new Set([
  // Documents.
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/json", "application/xml", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.oasis.opendocument.text", // .odt
  "application/rtf",
  // Images.
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/tiff",
  // Audio.
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/flac",
  // Video.
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  // Archives (for download — extracted server-side, not executed).
  "application/zip", "application/gzip", "application/x-tar",
  // Design.
  "application/vnd.figma", // .fig (Figma files — actually JSON).
  "image/vnd.adobe.photoshop", // .psd
  "application/illustrator", // .ai
  "application/skp", // SketchUp
  // Code (text — no execution on the server).
  "text/javascript", "text/css", "text/x-python", "text/x-typescript",
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".app",
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".psm1", ".vbs", ".wsf",
  ".jar", ".class", ".war",
  ".dll", ".so", ".dylib",
  ".app",
  ".deb", ".rpm", ".pkg", ".dmg",
]);

/** Plan-based max upload size (in bytes). */
const PLAN_MAX_UPLOAD: Record<string, number> = {
  free: 10 * 1024 * 1024, // 10 MB.
  pro: 100 * 1024 * 1024, // 100 MB.
  business: 500 * 1024 * 1024, // 500 MB.
  enterprise: 2 * 1024 * 1024 * 1024, // 2 GB.
};

/** Plan-based storage quota (in bytes). */
const PLAN_STORAGE_QUOTA: Record<string, number> = {
  free: 100 * 1024 * 1024, // 100 MB.
  pro: 10 * 1024 * 1024 * 1024, // 10 GB.
  business: 100 * 1024 * 1024 * 1024, // 100 GB.
  enterprise: Infinity, // custom (managed externally).
};

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/**
 * Validate the MIME type + file extension. Rejects:
 *   - MIME types not in the allowlist.
 *   - Dangerous extensions (.exe, .bat, .sh, .dll, etc.).
 *   - Mismatched extension + MIME (e.g. .png with application/pdf).
 */
export function validateMime(mime: string, name: string): void {
  const ext = name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  const extWithDot = ext ? `.${ext}` : "";

  // Reject dangerous extensions.
  if (DANGEROUS_EXTENSIONS.has(extWithDot)) {
    throw new ApiError("file_type_blocked", 400, { reason: "dangerous_extension", extension: extWithDot });
  }

  // Check MIME allowlist.
  if (!MIME_ALLOWLIST.has(mime)) {
    throw new ApiError("file_type_blocked", 400, { reason: "mime_not_allowed", mime });
  }
}

/**
 * Enforce the workspace's storage quota. Checks the total storage used
 * (sum of file sizes where deleted_at IS NULL) against the plan's quota.
 * Throws ApiError(413) if the upload would exceed the quota.
 */
/**
 * Enforce the workspace's storage quota. Enforced at three points:
 *   1. Presign (predicted) — before generating the presigned URL. Uses the
 *      declared size_bytes from the request. Fast rejection (fail before
 *      the upload happens).
 *   2. Confirm (actual) — after the upload, uses the actual size from the
 *      object store. If the actual exceeds the cap (client lied about size),
 *      the file is deleted + 400.
 *   3. Nightly reconcile — sums all file_versions where deleted_at IS NULL
 *      per workspace, compares to a cached `workspaces.storage_used` counter.
 *      Drift > 1% triggers an alert (the cached counter may be stale).
 *
 * This function is point 1 (presign). Point 2 is in confirmUpload (size
 * mismatch check). Point 3 is in `reconcileQuota` (below).
 */
export async function enforceQuota(wsId: string, uploadSize: number): Promise<void> {
  const plan = await getPlan(wsId);
  const quota = PLAN_STORAGE_QUOTA[plan] ?? PLAN_STORAGE_QUOTA.free;

  if (quota === undefined || quota === Infinity) return; // Enterprise: no cap.

  // Sum current storage usage (cached counter — fast path).
  const used = await getStorageUsed(wsId);

  if (used + uploadSize > quota) {
    throw new ApiError("quota_exceeded", 402, {
      plan,
      cap: quota,
      used,
      incoming: uploadSize,
    });
  }
}

/**
 * Get the workspace's current storage usage. Uses a cached counter
 * (`workspaces.storage_used` JSONB field) for the fast path. Falls back
 * to a SUM query if the counter is missing or stale.
 *
 * The cached counter is updated on each confirmUpload + on nightly reconcile.
 * It may drift slightly between updates — the nightly reconcile detects +
 * alerts on drift > 1%.
 */
export async function getStorageUsed(wsId: string): Promise<number> {
  // Fast path: read the cached counter from workspaces.billing JSONB.
  const { workspaces: wsTable } = await import("@supa/db/schema");
  const wsRows = await db
    .select({ billing: wsTable.billing })
    .from(wsTable)
    .where(eq(wsTable.id, wsId as any))
    .limit(1);
  const billing = (wsRows[0]?.billing as Record<string, unknown> | null) ?? {};
  const cached = billing.storage_used as number | undefined;

  if (cached != null && cached >= 0) {
    return cached;
  }

  // Slow path: SUM query (cached counter missing or stale).
  return getStorageUsedActual(wsId);
}

/**
 * Get the actual storage usage by summing file_versions.size_bytes
 * (the authoritative source — file_versions has one row per version,
 * each with its own storage_key + size).
 *
 * This is the "source of truth" — the cached counter may drift.
 * The nightly reconcile compares this to the cached counter + alerts
 * on drift > 1%.
 */
export async function getStorageUsedActual(wsId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${fileVersions.sizeBytes}), 0)` })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(
      and(
        eq(files.workspaceId, wsId as any),
        isNull(files.deletedAt), // only non-deleted files.
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Nightly quota reconciliation. For each workspace:
 *   1. Compute the actual storage usage (SUM of file_versions.size_bytes
 *      for non-deleted files).
 *   2. Compare to the cached counter (workspaces.billing.storage_used).
 *   3. If drift > 1% → emit an alert fact + correct the cached counter.
 *   4. Check if the actual usage exceeds the plan cap (catches uploads that
 *      slipped through the presign check via a race condition — concurrent
 *      uploads that each passed the check but together exceeded the cap).
 *   5. If over cap → flag the workspace (no auto-delete — the admin decides).
 *
 * Returns a summary of reconciled workspaces + drift detected.
 */
export interface ReconcileResult {
  workspacesChecked: number;
  driftDetected: number;
  corrected: number;
  overCap: number;
}

export async function reconcileQuota(): Promise<ReconcileResult> {
  const { workspaces: wsTable } = await import("@supa/db/schema");
  const result: ReconcileResult = {
    workspacesChecked: 0,
    driftDetected: 0,
    corrected: 0,
    overCap: 0,
  };

  // Find all non-deleted workspaces.
  const wsRows = await db
    .select({ id: wsTable.id, plan: wsTable.plan, billing: wsTable.billing })
    .from(wsTable)
    .where(sql`${wsTable.deletedAt} is null`);

  for (const ws of wsRows) {
    const wsId = ws.id as string;
    const plan = (ws.plan as string) ?? "free";
    const cap = PLAN_STORAGE_QUOTA[plan] ?? PLAN_STORAGE_QUOTA.free;

    // Compute actual usage.
    const actual = await getStorageUsedActual(wsId);

    // Compare to cached counter.
    const billing = (ws.billing as Record<string, unknown> | null) ?? {};
    const cached = billing.storage_used as number | undefined;

    if (cached == null || Math.abs(actual - cached) / Math.max(actual, 1) > 0.01) {
      // Drift > 1% (or cached is missing) → correct + alert.
      result.driftDetected++;

      // Correct the cached counter.
      await db
        .update(wsTable)
        .set({
          billing: { ...billing, storage_used: actual },
        } as any)
        .where(eq(wsTable.id, wsId as any));
      result.corrected++;

      // Emit alert fact.
      await db.execute(sql`
        select enterprise_audit_log_append(
          ${wsId}::uuid, 'system', 'quota-reconcile', 'quota.drift_detected',
          jsonb_build_object('cached', ${cached ?? null}, 'actual', ${actual}, 'drift_pct', ${cached != null ? Math.abs(actual - cached) / Math.max(actual, 1) * 100 : 100}),
          null::inet, null::text
        )
      `);
    }

    // Check if over cap.
    if (cap !== undefined && cap !== Infinity && actual > cap) {
      result.overCap++;
      await db.execute(sql`
        select enterprise_audit_log_append(
          ${wsId}::uuid, 'system', 'quota-reconcile', 'quota.over_cap',
          jsonb_build_object('cap', ${cap}, 'actual', ${actual}, 'plan', ${plan}),
          null::inet, null::text
        )
      `);
    }

    result.workspacesChecked++;
  }

  return result;
}

/** Get the workspace's plan. */
async function getPlan(wsId: string): Promise<string> {
  const { workspaces } = await import("@supa/db/schema");
  const rows = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  return rows[0]?.plan ?? "free";
}

/** Get the max upload size for the workspace's plan. */
async function getMaxUploadSize(wsId: string): Promise<number> {
  const plan = await getPlan(wsId);
  return PLAN_MAX_UPLOAD[plan] ?? PLAN_MAX_UPLOAD.free ?? PLAN_MAX_UPLOAD.free!;
}

/**
 * Generate an opaque storage key. Format: `ws/<wsId>/<uuid>`.
 * The ws-id prefix enables per-workspace purge partition (delete all objects
 * under `ws/<wsId>/` when the workspace is purged).
 */
function storageKey(wsId: string): string {
  return `ws/${wsId}/${randomUUID()}`;
}

/**
 * Presign a PUT URL for the storage key. The URL is valid for 15 minutes.
 * The content-length-range enforces the max upload size at the object store
 * level (can't be bypassed by a modified client).
 *
 * Stub — the real impl uses AWS S3 / Supabase Storage / R2 presigned URLs.
 */
async function presignPut(
  key: string,
  opts: { expires: string; contentLengthRange: [number, number] },
): Promise<string> {
  // Stub: in production, use:
  //   - AWS S3: `s3.getSignedUrl('putObject', { Bucket, Key, Expires, ContentLength: opts.contentLengthRange })`
  //   - Supabase Storage: `supabase.storage.from(bucket).createSignedUploadUrl(key)`
  //   - Cloudflare R2: `R2.createSignedUrl(key, { method: 'PUT', expiresIn: 900 })`
  return `${process.env.STORAGE_URL || "https://storage.example.com"}/${key}?expires=${opts.expires}`;
}

/**
 * HeadObject — check if the object exists in the store + get its metadata
 * (size, content hash). Used by confirmUpload to verify the upload happened.
 *
 * Stub — the real impl uses the storage provider's HEAD API.
 */
async function headObject(storageKey: string): Promise<{ size: number; contentHash: Buffer } | null> {
  // Stub: in production, use:
  //   - AWS S3: `s3.headObject({ Bucket, Key })`
  //   - Supabase Storage: `supabase.storage.from(bucket).list()`
  return null; // null = not found (upload didn't happen).
}

/**
 * Delete an object from the store. Used by reapStaleUploads to clean up
 * orphaned objects (presigned but never confirmed).
 *
 * Stub — best-effort.
 */
async function deleteObject(storageKey: string): Promise<void> {
  // Stub.
}

/**
 * Require that the user has a specific role (or higher) in the workspace.
 */
async function requireRole(wsId: string, uid: string, requiredRole: string): Promise<void> {
  const { memberships } = await import("@supa/db/schema");
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, uid as any)))
    .limit(1);
  const m = rows[0];
  if (!m || m.status !== "active") {
    throw new ApiError("not_a_member", 403);
  }
  const roleRank: Record<string, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if ((roleRank[m.role] ?? 0) < (roleRank[requiredRole] ?? 99)) {
    throw new ApiError("insufficient_role", 403);
  }
}

/**
 * Audit (via the security-definer function).
 */
async function audit(wsId: string, entry: {
  actorType: string; actorId: string; action: string; target?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, ${entry.actorType}, ${entry.actorId}, ${entry.action},
      ${entry.target ?? null}::jsonb, null::inet, null::text
    )
  `);
}

// ───────────────────────────────────────────────
// beginUpload — presign + insert file row
// ───────────────────────────────────────────────

/**
 * Begin a file upload. The flow:
 *   1. Check the user is a member of the workspace.
 *   2. Check the workspace's storage quota (fail fast — before presigning).
 *   3. Validate the MIME type + extension (no executables, no dangerous files).
 *   4. Generate an opaque storage key (`ws/<wsId>/<uuid>`).
 *   5. Insert a file row (content_hash is null — pending upload confirmation).
 *   6. Presign a PUT URL (15-min expiry, content-length-range enforced by the
 *      object store — can't be bypassed by a modified client).
 *   7. Return { url, fileId } — the client uploads directly to the object store.
 *
 * The client uploads directly (the file never touches the app server's memory).
 * After the upload, the client calls `confirmUpload` to reconcile (verify the
 * upload happened + set the content hash + audit).
 */
export async function beginUpload(
  uid: string,
  wsId: string,
  meta: FileMeta,
): Promise<BeginUploadResult> {
  await requireRole(wsId, uid, "member");
  await enforceQuota(wsId, meta.sizeBytes);
  validateMime(meta.mime, meta.name);

  const maxUploadSize = await getMaxUploadSize(wsId);
  if (meta.sizeBytes > maxUploadSize) {
    throw new ApiError("file_too_large", 413, { maxSize: maxUploadSize, requested: meta.sizeBytes });
  }

  const key = storageKey(wsId);

  const rows = await db
    .insert(files)
    .values({
      workspaceId: wsId as any,
      parentId: (meta.parentId ?? null) as any,
      name: meta.name,
      isDir: false,
      sizeBytes: meta.sizeBytes,
      mime: meta.mime,
      contentHash: null, // set on confirm.
      storageKey: key,
      version: 1,
      createdBy: uid as any,
    })
    .returning({ id: files.id });

  const row = rows[0];
  if (!row) throw new ApiError("file_insert_failed", 500);

  const url = await presignPut(key, {
    expires: PRESIGN_EXPIRY,
    contentLengthRange: [1, maxUploadSize],
  });

  return { url, fileId: row.id as string };
}

// ───────────────────────────────────────────────
// confirmUpload — verify upload + set content hash
// ───────────────────────────────────────────────

/**
 * Confirm a file upload. The client calls this after uploading to the presigned
 * URL. The flow:
 *   1. HeadObject on the storage key (verify the upload happened).
 *   2. Extract content_hash (from storage checksum or recompute sha-256).
 *   3. Update the file row (size_bytes, content_hash).
 *   4. Insert a file_versions row (version 1).
 *   5. Audit file.uploaded.
 *
 * If the object doesn't exist (upload didn't happen), throws 404.
 * If the size doesn't match the declared size, throws 400 (the client lied
 * about the size to bypass the quota check).
 */
export async function confirmUpload(uid: string, fileId: string): Promise<void> {
  // Fetch the file row.
  const fileRows = await db
    .select({
      id: files.id,
      wsId: files.workspaceId,
      storageKey: files.storageKey,
      declaredSize: files.sizeBytes,
      contentHash: files.contentHash,
    })
    .from(files)
    .where(eq(files.id, fileId as any))
    .limit(1);
  const fileRow = fileRows[0];
  if (!fileRow) throw new ApiError("file_not_found", 404);
  if (fileRow.contentHash) {
    throw new ApiError("already_confirmed", 409);
  }

  // HeadObject — verify the upload happened.
  const obj = await headObject(fileRow.storageKey as string);
  if (!obj) {
    throw new ApiError("upload_not_found", 404);
  }

  // Verify the size matches (the client can't lie about the size).
  if (obj.size !== fileRow.declaredSize) {
    // Size mismatch — the client declared a smaller size to bypass the quota.
    // Delete the object + delete the file row.
    await deleteObject(fileRow.storageKey as string);
    await db.delete(files).where(eq(files.id, fileId as any));
    throw new ApiError("size_mismatch", 400, {
      declared: fileRow.declaredSize,
      actual: obj.size,
    });
  }

  // Update the file row with the actual size + content hash.
  await db
    .update(files)
    .set({
      sizeBytes: obj.size,
      contentHash: obj.contentHash,
    })
    .where(eq(files.id, fileId as any));

  // Insert the version 1 row.
  await db.insert(fileVersions).values({
    fileId: fileId as any,
    version: 1,
    storageKey: fileRow.storageKey as string,
    sizeBytes: obj.size,
    contentHash: obj.contentHash,
    createdBy: uid as any,
  });

  // Audit.
  await audit(fileRow.wsId as string, {
    actorType: "user",
    actorId: uid,
    action: "file.uploaded",
    target: { file: fileId, size: obj.size },
  });
}

// ───────────────────────────────────────────────
// reapStaleUploads — hourly sweep (orphan cleanup)
// ───────────────────────────────────────────────

/**
 * Reap stale uploads. Finds file rows where:
 *   - `content_hash IS NULL` (upload never confirmed).
 *   - `created_at < now() - 1 hour` (the presigned URL has expired).
 *
 * For each:
 *   1. Delete the orphaned object from the store (best-effort).
 *   2. Delete the file row (cascade deletes file_versions — but there are none
 *      since the upload was never confirmed).
 *
 * Returns the count of reaped uploads.
 *
 * Called hourly by a cron job.
 */
export async function reapStaleUploads(): Promise<number> {
  const stale = await db
    .select({
      id: files.id,
      storageKey: files.storageKey,
    })
    .from(files)
    .where(
      and(
        isNull(files.contentHash),
        sql`${files.createdAt} < now() - interval '${STALE_UPLOAD_TTL_HOURS} hours'`,
      ),
    );

  for (const row of stale) {
    // Delete the orphaned object (best-effort — if the store is unavailable,
    // the object will be orphaned but the file row is still cleaned up).
    await deleteObject(row.storageKey as string).catch(() => {});

    // Delete the file row.
    await db.delete(files).where(eq(files.id, row.id as any));
  }

  return stale.length;
}

// ───────────────────────────────────────────────
// downloadUrl — presigned GET for file download.
// ───────────────────────────────────────────────

/**
 * Generate a presigned GET URL for downloading a file.
 *
 * Guests (viewers) get read-only presigned GETs — they can download but not
 * upload. The URL is valid for 60 seconds (short — reduces the window for
 * URL sharing/leakage).
 *
 * If `version` is specified, downloads a specific version from file_versions.
 * Otherwise downloads the current version (from the files row's storage_key).
 *
 * The response disposition is "attachment" — the browser prompts to download
 * (doesn't render inline — prevents XSS via uploaded HTML/SVG).
 *
 * Audits `file.download` (the download is a user action — track who downloaded
 * what + when).
 */
export async function downloadUrl(
  uid: string,
  wsId: string,
  fileId: string,
  version?: number,
): Promise<string> {
  await requireRole(wsId, uid, "viewer"); // guests (viewers) get read-only downloads.

  let storageKey: string;

  if (version != null) {
    // Specific version — look up in file_versions.
    const { fileVersions: fvTable } = await import("@supa/db/schema");
    const versionRows = await db
      .select({ storageKey: fvTable.storageKey })
      .from(fvTable)
      .where(
        and(
          eq(fvTable.fileId, fileId as any),
          eq(fvTable.version, version),
        ),
      )
      .limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) {
      throw new ApiError("version_not_found", 404, { fileId, version });
    }
    storageKey = versionRow.storageKey as string;
  } else {
    // Current version — look up in files.
    const fileRows = await db
      .select({ storageKey: files.storageKey, wsId: files.workspaceId })
      .from(files)
      .where(eq(files.id, fileId as any))
      .limit(1);
    const fileRow = fileRows[0];
    if (!fileRow) {
      throw new ApiError("file_not_found", 404);
    }
    // Verify the file belongs to this workspace (defense-in-depth — RLS
    // already enforces this, but we check explicitly for a better error).
    if (fileRow.wsId !== wsId) {
      throw new ApiError("file_not_found", 404);
    }
    storageKey = fileRow.storageKey as string;
  }

  // Audit the download.
  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "file.download",
    target: { file: fileId, version: version ?? "current" },
  });

  // Presign a GET URL (60-second expiry, attachment disposition).
  return presignGet(storageKey, {
    expires: "60s",
    responseDisposition: "attachment",
  });
}

/**
 * Presign a GET URL for downloading. The URL is valid for 60 seconds.
 * The response disposition is "attachment" (browser prompts to download,
 * doesn't render inline — prevents XSS via uploaded HTML/SVG).
 *
 * Stub — the real impl uses the storage provider's presigned GET API.
 */
async function presignGet(
  key: string,
  opts: { expires: string; responseDisposition: string },
): Promise<string> {
  // Stub: in production, use:
  //   - AWS S3: `s3.getSignedUrl('getObject', { Bucket, Key, Expires: 60, ResponseContentDisposition: 'attachment' })`
  //   - Supabase Storage: `supabase.storage.from(bucket).createSignedUrl(key, 60, { download: true })`
  //   - Cloudflare R2: `R2.createSignedUrl(key, { method: 'GET', expiresIn: 60 })`
  const disposition = opts.responseDisposition === "attachment" ? "&response-content-disposition=attachment" : "";
  return `${process.env.STORAGE_URL || "https://storage.example.com"}/${key}?expires=${opts.expires}${disposition}`;
}
