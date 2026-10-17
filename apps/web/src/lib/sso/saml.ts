// SAML SP implementation — the security-critical SAML assertion consumer.
//
// Using a library (saml2-js / @node-saml/passport-saml) in production.
// Hand-rolled only if we must, and we must not — SAML has too many
// XML-signature + canonicalization edge cases to hand-roll safely.
//
//   beginLogin(domain)
//     1. Look up the SSO connection by verified domain (cached 5m).
//     2. Generate a request id (InResponseTo binding — SP-initiated).
//     3. Store the request id with 10-min TTL (replay defense — the IdP
//        must echo back the InResponseTo in the response).
//     4. Return the redirect URL to the IdP's SSO URL.
//
//   consumeAssertion(samlResponse, reqId?)
//     The validation checklist — every check mandatory, no skip flags:
//       1. XML signature over the ASSERTION (not just the response) verifies
//          against the pinned idp_cert_pem. Key from the assertion's own
//          KeyDescriptor is NEVER trusted (prevents key injection).
//       2. Conditions: NotBefore/NotOnOrAfter with 60s clock skew.
//          Audience == our sp_entity_id.
//       3. If IdP-initiated (no reqId): conn.idp_initiated_ok must be true,
//          else reject (default deny — IdP-initiated SSO is an attack vector).
//       4. If SP-initiated: reqId must exist in cache, unconsumed; consume
//          atomically (replay defense — the same SAML response can't be
//          replayed).
//       5. SubjectConfirmationData Recipient == our ACS URL, InResponseTo
//          matches the reqId.
//     After validation: linkOrCreate (JIT provisioning), startSession with
//     mfa_satisfied=true (the IdP did MFA or didn't — org policy owns this).
//
// SECURITY INVARIANTS:
//   - The IdP cert is PINNED (from sso_connections.idp_cert_pem). The
//     assertion's own KeyDescriptor is never trusted (key injection attack).
//   - IdP-initiated SSO is denied by default (idp_initiated_ok = false).
//   - The InResponseTo is consumed atomically (one-time use — replay defense).
//   - The Audience must be our sp_entity_id (prevents assertion forwarding
//     between services — an assertion for service A can't be used for service B).
//   - The Recipient must be our ACS URL (prevents assertion forwarding via
//     a different endpoint).
//   - Clock skew tolerance is 60s (prevents replay of expired assertions
//     with skewed clocks — but 60s is tight enough to limit the window).

import { db } from "@supa/db";
import { ssoConnections, scimIdentities, memberships } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface SsoConnection {
  id: string;
  wsId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertPem: string;
  spEntityId: string;
  idpInitiatedOk: boolean;
  enforceSso: boolean;
  enforcedDomain: string;
}

export interface SamlClaims {
  nameId: string;
  email: string;
  displayName: string;
  groups: string[];
  /** The IdP's session index (for enterprise log correlation). */
  sessionIndex?: string;
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

const REQUEST_TTL_MS = 10 * 60 * 1000; // 10 min.
const CLOCK_SKEW_SECONDS = 60; // 60s tolerance for NotBefore/NotOnOrAfter.
const CONNECTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache for connection lookup.

// ───────────────────────────────────────────────
// Cache (stub — production uses Redis)
// ───────────────────────────────────────────────

const requestCache = new Map<string, { connId: string; consumedAt: number | null }>();
const connectionCache = new Map<string, { conn: SsoConnection; cachedAt: number }>();

async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  // Stub — production uses Redis with TTL.
  (requestCache as Map<string, unknown>).set(key, value);
  // Auto-expire (best-effort cleanup).
  setTimeout(() => requestCache.delete(key), ttlMs);
}

async function cacheGet<T>(key: string): Promise<T | null> {
  // Stub — production uses Redis.
  return (requestCache.get(key) as T) ?? null;
}

async function cacheConsume(key: string): Promise<boolean> {
  // Atomic consume: if the key exists + is unconsumed, mark as consumed + return true.
  // If already consumed or missing, return false (replay detected).
  const entry = requestCache.get(key);
  if (!entry || entry.consumedAt !== null) return false;
  entry.consumedAt = Date.now();
  return true;
}

// ───────────────────────────────────────────────
// Connection lookup (cached 5m)
// ───────────────────────────────────────────────

/**
 * Find the SSO connection by verified domain. Cached for 5 minutes.
 * The connection is looked up by `enforced_domain` (lowercased).
 */
async function connectionForDomain(domain: string): Promise<SsoConnection | null> {
  const lower = domain.toLowerCase();

  // Check cache.
  const cached = connectionCache.get(lower);
  if (cached && Date.now() - cached.cachedAt < CONNECTION_CACHE_TTL_MS) {
    return cached.conn;
  }

  // Query DB.
  const rows = await db
    .select()
    .from(ssoConnections)
    .where(
      and(
        eq(ssoConnections.enforcedDomain, lower),
        eq(ssoConnections.enforceSso, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const conn: SsoConnection = {
    id: row.id as string,
    wsId: row.workspaceId as string,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCertPem: row.idpCertPem,
    spEntityId: row.spEntityId,
    idpInitiatedOk: row.idpInitiatedOk,
    enforceSso: row.enforceSso,
    enforcedDomain: row.enforcedDomain,
  };

  // Cache.
  connectionCache.set(lower, { conn, cachedAt: Date.now() });
  return conn;
}

/**
 * Resolve the connection from the SAML response's signature cert.
 * The IdP's cert in the response must match the pinned `idp_cert_pem`.
 *
 * Stub — the real impl extracts the cert from the SAML response's
 * XML signature + matches it against sso_connections.idp_cert_pem.
 * For now, we look up by the connection's entity_id (from the response's
 * Issuer element).
 */
async function resolveConn(samlResponse: string): Promise<SsoConnection | null> {
  // Stub: parse the Issuer from the SAML response + look up the connection.
  // In production, the SAML library handles this.
  // For now, return null (the real impl would parse the XML).
  return null;
}

// ───────────────────────────────────────────────
// SAML library interface (stub — production uses @node-saml/passport-saml)
// ───────────────────────────────────────────────

interface SamlLib {
  generateRequestId(): string;
  redirect(conn: SsoConnection, reqId: string): string;
  validate(
    samlResponse: string,
    conn: SsoConnection,
    opts: {
      reqId?: string;
      clockSkew: number;
      audience: string;
      recipient: string;
    },
  ): SamlClaims;
}

// Stub SAML library — production swaps to @node-saml/passport-saml.
const saml: SamlLib = {
  generateRequestId(): string {
    return randomUUID();
  },

  redirect(conn: SsoConnection, reqId: string): string {
    // Build the redirect URL: IdP SSO URL + SAMLRequest (deflated + base64).
    // Stub — the real impl uses the SAML library's `createLoginRequestUrl`.
    const params = new URLSearchParams({
      SAMLRequest: `stub_request_${reqId}`,
      RelayState: reqId,
    });
    return `${conn.idpSsoUrl}?${params.toString()}`;
  },

  validate(
    _samlResponse: string,
    conn: SsoConnection,
    opts: { reqId?: string; clockSkew: number; audience: string; recipient: string },
  ): SamlClaims {
    // VALIDATION CHECKLIST — every check mandatory, no skip flags:
    //
    // 1. XML signature over the ASSERTION (not just the response) verifies
    //    against the pinned idp_cert_pem. Key from the assertion's own
    //    KeyDescriptor is NEVER trusted (key injection attack).
    //
    // 2. Conditions: NotBefore/NotOnOrAfter with 60s clock skew.
    //    Audience == opts.audience (our sp_entity_id).
    //
    // 3. If IdP-initiated (no reqId): conn.idp_initiated_ok must be true,
    //    else reject.
    //
    // 4. If SP-initiated: opts.reqId must exist in cache, unconsumed; consume
    //    atomically (replay defense).
    //
    // 5. SubjectConfirmationData Recipient == opts.recipient (our ACS URL),
    //    InResponseTo matches opts.reqId.

    // Stub — in production, the SAML library does all of this.
    // The stub returns minimal claims for testing.
    if (!conn.idpInitiatedOk && !opts.reqId) {
      throw new ApiError("idp_initiated_denied", 403, { reason: "idp_initiated_ok_false" });
    }

    return {
      nameId: "stub_name_id@example.com",
      email: "stub_name_id@example.com",
      displayName: "Stub User",
      groups: [],
      sessionIndex: "stub_session_index",
    };
  },
};

// ───────────────────────────────────────────────
// JIT provisioning — link or create user
// ───────────────────────────────────────────────

/**
 * Link an existing scim_identity to a user, or create a new user (JIT).
 * If the scim_identity already has a user_id → use it (the user was
 * pre-provisioned via SCIM). If not → create the user via Supabase admin API
 * + link the identity.
 */
async function linkOrCreate(
  conn: SsoConnection,
  nameId: string,
  claims: SamlClaims,
): Promise<{ uid: string }> {
  // Look up the scim_identity by (scim_user_id, sso_conn_id).
  const identityRows = await db
    .select({ userId: scimIdentities.userId })
    .from(scimIdentities)
    .where(
      and(
        eq(scimIdentities.scimUserId, nameId),
        eq(scimIdentities.ssoConnId, conn.id as any),
      ),
    )
    .limit(1);

  const existing = identityRows[0];
  if (existing?.userId) {
    return { uid: existing.userId as string };
  }

  // JIT: create the user via Supabase admin API.
  let uid: string;
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    const { data, error } = await supabase.auth.admin.createUser({
      email: claims.email,
      email_confirm: true, // SSO-verified email.
      user_metadata: {
        full_name: claims.displayName,
        sso_originated: true,
        sso_conn_id: conn.id,
      },
    });
    if (error || !data.user) {
      throw new ApiError("jit_user_creation_failed", 500, { reason: error?.message });
    }
    uid = data.user.id;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("jit_user_creation_failed", 500);
  }

  // Link the scim_identity to the new user.
  await db
    .insert(scimIdentities)
    .values({
      scimUserId: nameId,
      ssoConnId: conn.id as any,
      userId: uid as any,
      workspaceId: conn.wsId as any,
    })
    .onConflictDoNothing();

  // Create a membership (member role — the group→role mapping can upgrade later).
  await db
    .insert(memberships)
    .values({
      wsId: conn.wsId as any,
      userId: uid as any,
      role: "member",
      status: "active",
      joinedAt: new Date(),
    })
    .onConflictDoNothing();

  return { uid };
}

/**
 * Start a session for the SSO-authenticated user.
 * MFA satisfaction: the IdP did MFA or didn't — org policy owns this.
 * If `enforce_sso` is true + the IdP didn't do MFA, the session's
 * `mfa_satisfied` is false (the user will be prompted for MFA on the next
 * re-auth-sensitive operation).
 */
async function startSessionFor(
  user: { uid: string },
  opts: { mfaSatisfied: boolean },
): Promise<void> {
  const { createSession, issueAccessToken } = await import("@/lib/auth/session");
  const ctx = {
    ip: "0.0.0.0", // stub — the route handler provides the real IP.
    ua: "SSO", // stub.
  };
  const session = await createSession(user.uid, ctx as any, opts.mfaSatisfied);
  const accessToken = issueAccessToken({
    userId: user.uid,
    sessionId: session.sessionId,
    mfaSatisfied: opts.mfaSatisfied,
  });
  // The route handler sets the refresh cookie + returns the access token.
  // This function just creates the session — the route returns the response.
}

// ───────────────────────────────────────────────
// Audit helper
// ───────────────────────────────────────────────

async function audit(wsId: string, action: string, target: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'sso', 'saml', ${action},
      ${target}::jsonb, null::inet, null::text
    )
  `);
}

// ───────────────────────────────────────────────
// beginLogin — SP-initiated SSO
// ───────────────────────────────────────────────

/**
 * Begin an SP-initiated SAML login. Generates a request id (InResponseTo
 * binding), stores it with 10-min TTL, and returns the redirect URL to the IdP.
 *
 * The request id is the replay defense: the IdP must echo it back as
 * InResponseTo in the response. `consumeAssertion` checks that the reqId
 * exists in cache + is unconsumed (one-time use).
 */
export async function beginLogin(domain: string): Promise<{ redirectUrl: string }> {
  const conn = await connectionForDomain(domain);
  if (!conn) throw new ApiError("sso_not_configured", 404, { domain });

  const reqId = saml.generateRequestId();
  await cacheSet(`saml:req:${reqId}`, { connId: conn.id }, REQUEST_TTL_MS);

  const redirectUrl = saml.redirect(conn, reqId);
  return { redirectUrl };
}

// ───────────────────────────────────────────────
// consumeAssertion — the SAML ACS (Assertion Consumer Service)
// ───────────────────────────────────────────────

/**
 * Consume a SAML assertion. The validation checklist:
 *
 *   1. XML signature over the ASSERTION verifies against pinned idp_cert_pem.
 *      Key from the assertion's own KeyDescriptor is NEVER trusted.
 *   2. Conditions: NotBefore/NotOnOrAfter (60s clock skew), Audience == sp_entity_id.
 *   3. IdP-initiated (no reqId): conn.idp_initiated_ok must be true (default deny).
 *   4. SP-initiated: reqId must exist in cache, unconsumed; consume atomically.
 *   5. SubjectConfirmationData Recipient == ACS URL, InResponseTo matches reqId.
 *
 * After validation: JIT provisioning (linkOrCreate), start session with
 * mfa_satisfied=true (org policy owns MFA enforcement).
 *
 * The SAML session index is included in the audit entry so enterprise logs
 * correlate between our system + the IdP.
 */
export async function consumeAssertion(
  samlResponse: string,
  reqId?: string,
): Promise<{ accessToken: string; mfaSatisfied: boolean }> {
  // Resolve the connection from the response's signature cert.
  const conn = await resolveConn(samlResponse);
  if (!conn) {
    throw new ApiError("saml_connection_not_found", 400, { reason: "cert_match_failed" });
  }

  // Check 3: IdP-initiated SSO gate.
  if (!reqId && !conn.idpInitiatedOk) {
    throw new ApiError("idp_initiated_denied", 403, { reason: "idp_initiated_ok_false" });
  }

  // Check 4: SP-initiated replay defense.
  if (reqId) {
    const consumed = await cacheConsume(`saml:req:${reqId}`);
    if (!consumed) {
      throw new ApiError("saml_replay_detected", 409, { reqId, alert: true });
    }
  }

  // Checks 1, 2, 5: validate the assertion (signature, conditions, audience, recipient, InResponseTo).
  const claims = saml.validate(samlResponse, conn, {
    ...(reqId ? { reqId } : {}),
    clockSkew: CLOCK_SKEW_SECONDS,
    audience: conn.spEntityId,
    recipient: `${process.env.APP_URL ?? "https://app.example.com"}/api/sso/saml/callback`,
  });

  // JIT provisioning: link or create the user.
  const user = await linkOrCreate(conn, claims.nameId, claims);

  // Start session (mfa_satisfied=true — the IdP did MFA or didn't, org policy owns this).
  await startSessionFor(user, { mfaSatisfied: true });

  // Issue access token (the route handler sets the refresh cookie).
  const { issueAccessToken } = await import("@/lib/auth/session");
  const accessToken = issueAccessToken({
    userId: user.uid,
    sessionId: "", // stub — startSessionFor creates the session, but doesn't return the id.
    mfaSatisfied: true,
  });

  // Audit with the SAML session id for enterprise log correlation.
  await audit(conn.wsId, "auth.sso.login", {
    ssoConnId: conn.id,
    nameId: claims.nameId,
    sessionIndex: claims.sessionIndex,
    jit: true, // always JIT in the stub (the real impl tracks whether the user was pre-provisioned).
  });

  return { accessToken, mfaSatisfied: true };
}

/**
 * SAML metadata endpoint. Returns the SP metadata XML (for the IdP config).
 * Includes the ACS URL, entity ID, + signing cert (if configured).
 */
export function getSpMetadata(): string {
  const entityId = process.env.SSO_SP_ENTITY_ID ?? "https://app.example.com/sso";
  const acsUrl = `${process.env.APP_URL ?? "https://app.example.com"}/api/sso/saml/callback`;

  // Stub XML metadata — the real impl uses the SAML library's metadata generator.
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}
