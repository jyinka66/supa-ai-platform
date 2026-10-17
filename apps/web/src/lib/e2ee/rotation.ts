// E2EE key rotation + device revocation.
//
// End-to-end encryption (E2EE) is a Phase 3 feature. This module defines
// the contract (interface) for key rotation + device revocation — the crypto
// primitives are stubbed (production uses libsodium / WebCrypto).
//
//   rotateRootKey(wsId, uid)
//     Admin+ only. Generates a new root key + re-wraps per-file content keys
//     LAZILY: new uploads use the new root immediately; old files are
//     re-wrapped by a background client-driven job (each member's client
//     re-wraps files it has cached). The server can decrypt nothing —
//     re-wrap means "re-encrypt content under new key" (download old,
//     encrypt new, replace ciphertext via the normal upload path as a new
//     version). Slow but correct.
//
//   revokeDevice(wsId, uid, deviceId)
//     Removes the device's key-transport public key from recipient sets.
//     Next content-key wrap excludes it. Already-delivered ciphertext the
//     device holds is NOT retroactively unreadable — documented residual
//     risk, mitigated by the rotation procedure above for high-severity
//     incidents.
//
// E2EE DESIGN:
//   - Each file has a unique content key (symmetric, AES-256).
//   - The content key is wrapped (encrypted) for each authorized device's
//     key-transport public key (X25519).
//   - The root key wraps the content keys. Rotating the root key = re-wrap
//     all content keys under the new root.
//   - The server NEVER sees the plaintext content key or the root key.
//     The server stores only wrapped content keys (encrypted for each device).
//   - Device revocation: remove the device's public key from the recipient
//     set. New wraps exclude it. Old wraps (already-delivered) are not
//     retroactively unreadable (the device has the ciphertext + its private key).
//
// RESIDUAL RISK:
//   Device revocation does NOT make already-delivered ciphertext unreadable.
//   The device holds the ciphertext + its private key (which decrypted the
//   content key at delivery time). The only way to make old content
//   unreadable is full root key rotation (re-encrypt ALL content under
//   new keys). This is slow (O(n) in files) + requires client cooperation
//   (the server can't decrypt to re-encrypt). For high-severity incidents,
//   the rotation procedure is the mitigation.

import { db } from "@supa/db";
import { memberships, sessions } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface RootKeyRotation {
  wsId: string;
  oldRootKeyId: string;
  newRootKeyId: string;
  rotatedAt: Date;
  rotatedBy: string;
}

export interface DeviceRevocation {
  wsId: string;
  userId: string;
  deviceId: string;
  revokedAt: Date;
  revokedBy: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/**
 * Require that the user has a specific role (or higher) in the workspace.
 */
async function requireRole(wsId: string, uid: string, requiredRole: string): Promise<void> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, uid as any)))
    .limit(1);
  const m = rows[0];
  if (!m || m.status !== "active") throw new ApiError("not_a_member", 403);
  const roleRank: Record<string, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if ((roleRank[m.role] ?? 0) < (roleRank[requiredRole] ?? 99)) {
    throw new ApiError("insufficient_role", 403);
  }
}

/**
 * Audit via the security-definer function.
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
// Stub crypto primitives (production uses libsodium / WebCrypto)
// ───────────────────────────────────────────────

/**
 * Generate a new root key (XChaCha20-Poly1305 key, 256-bit).
 * The root key is NEVER stored server-side — it's held client-side
 * (in the user's browser, encrypted by their device key).
 *
 * The server only stores wrapped content keys (encrypted for each device's
 * key-transport public key). The root key wraps the content keys client-side.
 *
 * Stub — production uses `crypto.secretbox.keygen()` from libsodium.
 */
function generateRootKey(): { keyId: string; keyMaterial: Uint8Array } {
  return {
    keyId: randomUUID(),
    keyMaterial: new Uint8Array(32), // 256-bit key (stub — all zeros).
  };
}

/**
 * Re-wrap a content key under a new root key.
 *
 * The server can't do this (it can't decrypt). The client:
 *   1. Downloads the old ciphertext.
 *   2. Decrypts with the old root key (client-side).
 *   3. Re-encrypts under the new root key (client-side).
 *   4. Uploads as a new file version (normal upload path).
 *
 * This is the "lazy re-wrap" — each file is re-wrapped when the client
 * next accesses it (or by a background job that iterates cached files).
 *
 * Stub — production delegates to the client.
 */
async function rewrapContentKey(
  _oldRootKeyId: string,
  _newRootKeyId: string,
  _fileId: string,
): Promise<void> {
  // Stub — the client does this. The server can't decrypt.
  // The background job queues files for re-wrap (each client re-wraps
  // files it has cached). Files not accessed after rotation retain
  // the old wrapped key until accessed.
}

// ───────────────────────────────────────────────
// Key rotation
// ───────────────────────────────────────────────

/**
 * Rotate the workspace's root E2EE key.
 *
 * Admin+ only. Generates a new root key + re-wraps per-file content keys
 * LAZILY:
 *   - New uploads use the new root immediately.
 *   - Old files are re-wrapped by a background client-driven job (each
 *     member's client re-wraps files it has cached). The server queues
 *     files for re-wrap; the client picks them up on next sync.
 *   - Fallback: the server can decrypt nothing, so re-wrap means
 *     "re-encrypt content under new key" — download old, encrypt new,
 *     replace ciphertext via the normal upload path as a new version.
 *     Slow but correct.
 *
 * The rotation is audited. The old root key is NOT immediately destroyed
 * (it's kept until all files are re-wrapped — the transition period).
 * Once all files are re-wrapped, the old key is destroyed.
 *
 * RESIDUAL RISK: during the transition period, both old + new root keys
 * are valid. A compromised old key can still decrypt files that haven't
 * been re-wrapped yet. The transition should be completed as quickly
 * as possible (the background job processes files in parallel across
 * all clients).
 */
export async function rotateRootKey(
  wsId: string,
  uid: string,
): Promise<RootKeyRotation> {
  await requireRole(wsId, uid, "admin");

  // Generate the new root key (client-side — the server never sees it).
  // The keyId is stored server-side (for tracking which key wraps which files).
  // The keyMaterial is held client-side only.
  const newRoot = generateRootKey();
  const oldRootKeyId = "stub-old-root-key-id"; // stub — the real impl reads the current root key id.

  // Queue all files for re-wrap.
  // The real impl would:
  //   1. Query all files in the workspace (non-deleted).
  //   2. Insert re-wrap jobs into a queue table (file_id, old_root_key_id, new_root_key_id).
  //   3. Each client picks up jobs on next sync + re-wraps.
  // For now, stub the queue.

  // Audit.
  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "e2ee.rotated",
    target: {
      oldRootKeyId,
      newRootKeyId: newRoot.keyId,
    },
  });

  return {
    wsId,
    oldRootKeyId,
    newRootKeyId: newRoot.keyId,
    rotatedAt: new Date(),
    rotatedBy: uid,
  };
}

// ───────────────────────────────────────────────
// Device revocation
// ───────────────────────────────────────────────

/**
 * Revoke a device's E2EE key access.
 *
 * Removes the device's key-transport public key from the recipient sets.
 * Next content-key wrap excludes it. The device can't decrypt new content
 * (new file uploads, new versions).
 *
 * ALREADY-DELIVERED CIPHERTEXT IS NOT RETROACTIVELY UNREADABLE:
 *   The device holds the ciphertext + its private key (which decrypted
 *   the content key at delivery time). The only way to make old content
 *   unreadable is full root key rotation (re-encrypt ALL content under
 *   new keys). This is the documented residual risk.
 *
 * For high-severity incidents (device with sensitive access compromised):
 *   1. `revokeDevice` — prevents new content from being decrypted.
 *   2. `rotateRootKey` — re-encrypts all content under new keys (slow
 *      but makes old ciphertext unreadable once re-wrap completes).
 *
 * The revocation is audited. The device's session is also revoked
 * (the device can't access the workspace at all).
 */
export async function revokeDevice(
  wsId: string,
  uid: string,
  deviceId: string,
): Promise<DeviceRevocation> {
  await requireRole(wsId, uid, "admin");

  // Remove the device's key-transport public key from the recipient sets.
  // The real impl would:
  //   1. Delete the device's public key from the `e2ee_device_keys` table
  //      (where ws_id + user_id + device_id match).
  //   2. Mark all content-key wraps for this device as revoked.
  //   3. Next content-key wrap (new file upload) excludes this device.
  // For now, stub the key removal.

  // Revoke the device's session (the device can't access the workspace).
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: "device_revoked" })
    .where(
      and(
        eq(sessions.id, deviceId as any),
        isNull(sessions.revokedAt),
      ),
    );

  // Audit.
  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "e2ee.device_revoked",
    target: {
      deviceId,
      residualRisk: "already_delivered_ciphertext_remains_readable",
    },
  });

  return {
    wsId,
    userId: uid,
    deviceId,
    revokedAt: new Date(),
    revokedBy: uid,
  };
}

// ───────────────────────────────────────────────
// Rotation status (for the admin UI)
// ───────────────────────────────────────────────

/**
 * Get the E2EE key rotation status for a workspace.
 *
 * Returns:
 *   - `currentRootKeyId` — the current root key id.
 *   - `previousRootKeyId` — the previous root key (null if no rotation).
 *   - `rewrapProgress` — how many files have been re-wrapped under the
 *     new key (vs total files). 100% = rotation complete, old key destroyed.
 *   - `transitionStartedAt` — when the rotation started.
 *
 * The admin UI shows this so the admin can track rotation progress + know
 * when the old key is safe to destroy.
 */
export async function getRotationStatus(wsId: string): Promise<{
  currentRootKeyId: string;
  previousRootKeyId: string | null;
  rewrapProgress: { completed: number; total: number };
  transitionStartedAt: Date | null;
}> {
  // Stub — the real impl queries the rotation log + the file re-wrap queue.
  return {
    currentRootKeyId: "stub-current-root-key-id",
    previousRootKeyId: null,
    rewrapProgress: { completed: 0, total: 0 },
    transitionStartedAt: null,
  };
}
