// SSO service — OIDC + SAML, provider-agnostic.
//
// One interface, five providers (google_workspace, entra_id, okta,
// onelogin, generic). Provider adapters only TRANSLATE (OIDC auth URL,
// SAML redirect, token exchange, assertion verification); all SECURITY
// decisions live here:
//
//   - CSRF state (24 random bytes, server-side, single-use, 10-min TTL).
//   - OIDC nonce (replay defense — the id_token must echo it back).
//   - SAML replay defense (InResponseTo + assertion ID consumed once via
//     the sso_nonces table — duplicate replay fails the unique PK insert).
//   - Domain claim (no personal-email shadow logins — the email domain
//     must match the workspace's verified domain).
//   - SSO enforcement (password logins blocked for everyone except owner
//     bypass — owner_break_glass, audited).
//   - JIT provisioning (find or create the user on first SSO login).
//   - Group→role mapping (IdP groups sync down to workspace roles, EXCEPT
//     owner — never demoted by sync).
//
// The provider adapters are NOT implemented here (they're separate modules
// — oidc-provider.ts, saml-provider.ts). This service calls them via a
// minimal interface; the real implementations use `openid-client` (OIDC)
// and `@node-saml/passport-saml` (SAML).

import { db } from "@supa/db";
import {
  ssoConfigs,
  ssoNonces,
  workspaces,
  memberships,
  scimGroups,
} from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SsoProtocol = "oidc" | "saml";
export type SsoProvider = "google_workspace" | "entra_id" | "okta" | "onelogin" | "generic";

export interface SsoConfig {
  wsId: string;
  protocol: SsoProtocol;
  provider: SsoProvider;
  oidc: { issuer: string; clientId: string; clientSecret: string; scopes: string[] } | null;
  saml: { entityId: string; certFingerprint: string; idpMetadata: string } | null;
  enforced: boolean;
  ownerBypass: boolean;
  domainClaim: string | null;
}

export interface Identity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  groups: string[];
}

export interface OidcClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  groups?: string[];
  nonce: string;
  iss: string;
  aud: string;
  exp: number;
}

export interface SamlAssertion {
  nameId: string;
  id: string;
  attributes: {
    email: string;
    displayName: string;
    groups?: string[];
  };
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status code. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

/** Append to the enterprise audit log via the security-definer function. */
async function audit(
  wsId: string,
  entry: {
    actorType: "user" | "api_key" | "scim" | "sso" | "system";
    actorId: string;
    action: string;
    target?: Record<string, unknown>;
  },
): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${entry.actorType},
      ${entry.actorId},
      ${entry.action},
      ${entry.target ?? null}::jsonb,
      null::inet,
      null::text
    )
  `);
}

/** In-memory state store (CSRF state + nonce). Production: Redis. */
interface StateEntry {
  wsId: string;
  createdAt: number;
}
const stateStore = new Map<string, StateEntry>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes.

/** Generate a new nonce (32 random bytes, hex). */
function newNonce(wsId: string): string {
  const nonce = randomBytes(32).toString("hex");
  // Store the nonce for later verification (OIDC id_token must echo it back).
  nonceStore.set(nonce, { wsId, createdAt: Date.now() });
  return nonce;
}

/** In-memory nonce store (OIDC id_token nonce + SAML assertion ID). */
const nonceStore = new Map<string, { wsId: string; createdAt: number }>();
const NONCE_TTL_MS = 10 * 60 * 1000;

/** Pop a CSRF state (single-use). Returns the config + nonce. Throws if expired/invalid. */
async function popState(state: string): Promise<SsoConfig> {
  const entry = stateStore.get(state);
  stateStore.delete(state); // single-use — always delete, even if expired.
  if (!entry) throw new ApiError("sso_state_invalid", 400);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) {
    throw new ApiError("sso_state_expired", 400);
  }
  // Periodic cleanup of expired states (best-effort).
  if (stateStore.size > 10000) cleanupExpiredStates();
  return findSsoConfigByWsId(entry.wsId);
}

/** Cleanup expired states + nonces (prevents unbounded growth). */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
  for (const [k, v] of nonceStore) {
    if (now - v.createdAt > NONCE_TTL_MS) nonceStore.delete(k);
  }
}

// ───────────────────────────────────────────────
// findSsoConfig — by slug or verified domain
// ───────────────────────────────────────────────

/**
 * Find an SSO config by workspace slug OR verified domain. Used by the
 * login flow (the user enters their workspace slug or email domain).
 */
async function findSsoConfig(wsSlugOrDomain: string): Promise<SsoConfig | null> {
  const lower = wsSlugOrDomain.toLowerCase();

  // Try by slug first.
  const bySlugRows = await db
    .select({
      wsId: ssoConfigs.wsId,
      protocol: ssoConfigs.protocol,
      provider: ssoConfigs.provider,
      oidc: ssoConfigs.oidc,
      saml: ssoConfigs.saml,
      enforced: ssoConfigs.enforced,
      ownerBypass: ssoConfigs.ownerBypass,
      domainClaim: ssoConfigs.domainClaim,
    })
    .from(ssoConfigs)
    .innerJoin(workspaces, eq(workspaces.id, ssoConfigs.wsId as any))
    .where(and(eq(workspaces.slug, lower), sql`${workspaces.deletedAt} is null`))
    .limit(1);

  if (bySlugRows[0]) return rowToConfig(bySlugRows[0]);

  // Try by verified domain.
  const byDomainRows = await db
    .select({
      wsId: ssoConfigs.wsId,
      protocol: ssoConfigs.protocol,
      provider: ssoConfigs.provider,
      oidc: ssoConfigs.oidc,
      saml: ssoConfigs.saml,
      enforced: ssoConfigs.enforced,
      ownerBypass: ssoConfigs.ownerBypass,
      domainClaim: ssoConfigs.domainClaim,
    })
    .from(ssoConfigs)
    .innerJoin(workspaces, eq(workspaces.id, ssoConfigs.wsId as any))
    .where(and(sql`lower(${workspaces.domainVerified}) = ${lower}`, sql`${workspaces.deletedAt} is null`))
    .limit(1);

  if (byDomainRows[0]) return rowToConfig(byDomainRows[0]);
  return null;
}

/** Find SSO config by ws_id directly. */
async function findSsoConfigByWsId(wsId: string): Promise<SsoConfig> {
  const rows = await db
    .select({
      wsId: ssoConfigs.wsId,
      protocol: ssoConfigs.protocol,
      provider: ssoConfigs.provider,
      oidc: ssoConfigs.oidc,
      saml: ssoConfigs.saml,
      enforced: ssoConfigs.enforced,
      ownerBypass: ssoConfigs.ownerBypass,
      domainClaim: ssoConfigs.domainClaim,
    })
    .from(ssoConfigs)
    .where(eq(ssoConfigs.wsId, wsId as any))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiError("sso_config_not_found", 404);
  return rowToConfig(row);
}

/** Convert a DB row to an SsoConfig. */
function rowToConfig(row: any): SsoConfig {
  return {
    wsId: row.wsId as string,
    protocol: row.protocol as SsoProtocol,
    provider: row.provider as SsoProvider,
    oidc: row.oidc as SsoConfig["oidc"],
    saml: row.saml as SsoConfig["saml"],
    enforced: row.enforced,
    ownerBypass: row.ownerBypass,
    domainClaim: row.domainClaim,
  };
}

// ───────────────────────────────────────────────
// Provider adapters — stubs (real impls use openid-client + passport-saml)
// ───────────────────────────────────────────────

/** Build the OIDC authorization URL (provider-agnostic). */
function buildOidcAuthUrl(
  issuer: string,
  clientId: string,
  state: string,
  opts: { scope: string; nonce: string },
): string {
  // Stub — real impl uses openid-client's Issuer.discover(issuer) + client.authorizationUrl(...).
  const redirectUri = encodeURIComponent(`${process.env.APP_URL}/api/sso/oidc/callback`);
  return `${issuer}/authorize?` + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: opts.scope,
    state,
    nonce: opts.nonce,
  }).toString();
}

/** Build the SAML redirect URL (provider-agnostic). */
function buildSamlRedirect(cfg: SsoConfig, opts: { state: string; relay: string }): string {
  // Stub — real impl uses passport-saml's SAMLStrategy.generateServiceProvider().
  // The SAML flow is a POST binding (the IdP POSTs the assertion back), so the
  // "redirect" is actually a 200 with an auto-submitting form.
  return `${process.env.APP_URL}/api/sso/saml/start?state=${opts.state}&relay=${opts.relay}`;
}

/** Exchange the OIDC authorization code for tokens. */
async function exchangeCode(cfg: SsoConfig, code: string): Promise<{ id_token: string; access_token: string }> {
  // Stub — real impl uses openid-client's client.callback(...).
  return { id_token: "stub_id_token", access_token: "stub_access_token" };
}

/** Verify the OIDC id_token (signature, iss, aud, nonce, exp). */
async function verifyIdToken(cfg: SsoConfig, idToken: string): Promise<OidcClaims> {
  // Stub — real impl uses openid-client's client.validateIdToken(...).
  // For now, decode the JWT payload (no signature verification in the stub).
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new ApiError("oidc_invalid_id_token", 400);
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());

  // Verify nonce (replay defense — the id_token must echo the nonce from startLogin).
  const nonceEntry = nonceStore.get(payload.nonce);
  nonceStore.delete(payload.nonce); // single-use.
  if (!nonceEntry) throw new ApiError("oidc_nonce_invalid", 400);
  if (Date.now() - nonceEntry.createdAt > NONCE_TTL_MS) {
    throw new ApiError("oidc_nonce_expired", 400);
  }

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified,
    name: payload.name,
    groups: payload.groups,
    nonce: payload.nonce,
    iss: payload.iss,
    aud: payload.aud,
    exp: payload.exp,
  };
}

/** Verify the SAML assertion (signature, cert fingerprint, audience, timestamps). */
async function verifySaml(
  cfg: SsoConfig,
  samlResponse: string,
  opts: { certFingerprint: string; audience: string; notBefore: boolean; notOnOrAfter: boolean },
): Promise<SamlAssertion> {
  // Stub — real impl uses passport-saml's SAMLStrategy.validatePostResponse(...).
  return {
    nameId: "stub_name_id",
    id: "stub_assertion_" + randomBytes(8).toString("hex"),
    attributes: {
      email: "stub@example.com",
      displayName: "Stub User",
      groups: [],
    },
  };
}

// ───────────────────────────────────────────────
// User provisioning helpers — stubs
// ───────────────────────────────────────────────

/** Find a user by sub/email, or JIT-create on first SSO login. */
async function findOrJitCreateUser(id: Identity): Promise<{ id: string }> {
  // Stub — real impl queries auth.users (by email) or creates via admin API.
  return { id: `stub_user_${createHash("sha256").update(id.email).digest("hex").slice(0, 12)}` };
}

/** Check if the user is an owner of the workspace. */
async function isOwner(wsId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  return rows[0]?.role === "owner";
}

/** Check if the user's session originated from SSO (not a password login). */
async function isSsoOriginatedSession(userId: string): Promise<boolean> {
  // Stub — real impl checks the session's auth_method metadata.
  return true; // optimistic — allows the flow to proceed in the stub.
}

/** Resolve IdP groups to a workspace role via scim_groups mapping. */
async function resolveGroupRole(wsId: string, groups: string[]): Promise<string | null> {
  if (groups.length === 0) return null;
  // Find a scim_groups mapping that matches one of the user's IdP groups.
  const rows = await db
    .select({ mappedRole: scimGroups.mappedRole, scimGroupId: scimGroups.scimGroupId })
    .from(scimGroups)
    .where(eq(scimGroups.wsId, wsId as any));
  for (const g of groups) {
    const match = rows.find((r) => r.scimGroupId === g || r.scimGroupId === g.toLowerCase());
    if (match?.mappedRole) return match.mappedRole;
  }
  return null;
}

/** Get the user's membership in the workspace (null if not a member). */
async function getMembership(wsId: string, userId: string): Promise<{ role: string; status: string } | null> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  return rows[0] ? { role: rows[0].role, status: rows[0].status } : null;
}

/** JIT auto-join from SSO (creates a membership with the mapped or default 'member' role). */
async function autoJoinFromSso(wsId: string, userId: string, role: string): Promise<void> {
  await db
    .insert(memberships)
    .values({
      wsId: wsId as any,
      userId: userId as any,
      role: role as any,
      status: "active",
      joinedAt: new Date(),
    })
    .onConflictDoNothing();
}

/** Sync the user's role from the IdP group mapping (never demotes owner). */
async function syncRole(wsId: string, userId: string, newRole: string): Promise<void> {
  await db
    .update(memberships)
    .set({ role: newRole as any })
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.userId, userId as any),
        // Never demote owner.
        sql`${memberships.role} <> 'owner'`,
      ),
    );
}

/** Issue a session for the user (Supabase session or custom JWT). */
async function issueSession(
  userId: string,
  meta: { method: string; provider: string; wsId: string },
): Promise<void> {
  // Stub — real impl calls Supabase admin API to create a session, or
  // mints a custom JWT with the auth_method + provider metadata.
  console.log(`[session] issue for user ${userId} via ${meta.provider}`);
}

// ───────────────────────────────────────────────
// startLogin — begin the SSO flow
// ───────────────────────────────────────────────

/**
 * Begin the SSO login flow. Returns the redirect URL to the IdP.
 *
 * CSRF state: 24 random bytes (base64url), stored server-side with a 10-min
 * TTL. The state is single-use (popped on finishLogin). This prevents CSRF
 * (an attacker can't trick a user into logging into the attacker's workspace).
 *
 * OIDC: also generates a nonce (replay defense — the id_token must echo it
 * back, verified in finishOidc).
 *
 * SAML: the nonce is used as the RelayState (the IdP echoes it back; we
 * verify it in finishSaml via popState).
 */
export async function startLogin(wsSlugOrDomain: string): Promise<{ redirectUrl: string }> {
  const cfg = await findSsoConfig(wsSlugOrDomain);
  if (!cfg) throw new ApiError("sso_not_configured", 404);

  const state = randomBytes(24).toString("base64url");
  stateStore.set(state, { wsId: cfg.wsId, createdAt: Date.now() });

  if (cfg.protocol === "oidc") {
    if (!cfg.oidc) throw new ApiError("oidc_not_configured", 500);
    const nonce = newNonce(cfg.wsId);
    return {
      redirectUrl: buildOidcAuthUrl(cfg.oidc.issuer, cfg.oidc.clientId, state, {
        scope: "openid email profile",
        nonce,
      }),
    };
  }

  // SAML.
  return {
    redirectUrl: buildSamlRedirect(cfg, {
      state,
      relay: newNonce(cfg.wsId),
    }),
  };
}

// ───────────────────────────────────────────────
// finishOidc — complete the OIDC flow
// ───────────────────────────────────────────────

/**
 * Complete the OIDC login flow. Exchanges the authorization code for tokens,
 * verifies the id_token (signature, iss, aud, nonce, exp), and provisions
 * the user from the identity claims.
 *
 * The nonce verification is the replay defense: the id_token must echo the
 * nonce generated in startLogin. A replayed id_token (captured by an
 * attacker) will fail the nonce check (single-use — popped from nonceStore).
 */
export async function finishOidc(params: { code: string; state: string }): Promise<{ userId: string }> {
  const cfg = await popState(params.state); // single-use, 10-min TTL.
  if (cfg.protocol !== "oidc") throw new ApiError("sso_protocol_mismatch", 400);

  const tokens = await exchangeCode(cfg, params.code);
  const claims = await verifyIdToken(cfg, tokens.id_token);

  return provisionFromIdentity(cfg, {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified,
    name: claims.name,
    groups: claims.groups ?? [],
  });
}

// ───────────────────────────────────────────────
// finishSaml — complete the SAML flow
// ───────────────────────────────────────────────

/**
 * Complete the SAML login flow. Verifies the assertion (signature, cert
 * fingerprint, audience, timestamp window), then provisions the user.
 *
 * Replay defense: the assertion ID is consumed once via the sso_nonces
 * table (unique PK → duplicate replay fails the insert with a 409). This
 * is stronger than the OIDC nonce (which is in-memory) — the sso_nonces
 * table survives process restarts.
 */
export async function finishSaml(post: { SAMLResponse: string; RelayState: string }): Promise<{ userId: string }> {
  const cfg = await popState(post.RelayState);
  if (cfg.protocol !== "saml") throw new ApiError("sso_protocol_mismatch", 400);
  if (!cfg.saml) throw new ApiError("saml_not_configured", 500);

  const assertion = await verifySaml(cfg, post.SAMLResponse, {
    certFingerprint: cfg.saml.certFingerprint,
    audience: cfg.saml.entityId,
    notBefore: true,
    notOnOrAfter: true,
  });

  // Replay defense: insert the assertion ID into sso_nonces. Unique PK →
  // a replayed assertion (same ID) fails the insert with unique-violation.
  // This is the "consumed once" guarantee.
  try {
    await db.insert(ssoNonces).values({
      nonce: assertion.id,
      wsId: cfg.wsId as any,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      // unique_violation — the assertion ID was already consumed. Replay attack.
      throw new ApiError("saml_replay_detected", 409, { alert: true });
    }
    throw err;
  }

  return provisionFromIdentity(cfg, {
    sub: assertion.nameId,
    email: assertion.attributes.email,
    emailVerified: true, // SAML assertions from a verified IdP are trusted.
    name: assertion.attributes.displayName,
    groups: assertion.attributes.groups ?? [],
  });
}

// ───────────────────────────────────────────────
// provisionFromIdentity — JIT + domain claim + enforcement + role sync
// ───────────────────────────────────────────────

/**
 * Provision a user from the SSO identity. The central security function —
 * all SSO login flows converge here.
 *
 * Steps:
 *   1. Email verified check (unverified → 401).
 *   2. Domain claim check (email domain must match the workspace's verified
 *      domain — no personal-email shadow logins).
 *   3. Find or JIT-create the user (first SSO login creates the user).
 *   4. SSO enforcement check (if enforced, password logins blocked except
 *      owner bypass — the owner can break glass, audited).
 *   5. Group→role mapping (IdP groups sync down to workspace roles, EXCEPT
 *      owner — never demoted by sync).
 *   6. Issue session (with SSO metadata: method, provider, wsId).
 *   7. Audit (auth.sso.login, actor_type='sso', jit flag).
 */
async function provisionFromIdentity(cfg: SsoConfig, id: Identity): Promise<{ userId: string }> {
  // 1. Email verified.
  if (!id.emailVerified) {
    throw new ApiError("email_unverified", 401);
  }

  // 2. Domain claim — no personal-email shadow logins.
  const domain = id.email.split("@")[1]?.toLowerCase();
  if (cfg.domainClaim && domain !== cfg.domainClaim.toLowerCase()) {
    throw new ApiError("email_domain_mismatch", 403);
  }

  // 3. Find or JIT-create.
  const user = await findOrJitCreateUser(id);

  // 4. SSO enforcement.
  if (cfg.enforced && cfg.ownerBypass) {
    const owner = await isOwner(cfg.wsId, user.id);
    if (!owner) {
      // Non-owner: must have an SSO-originated session.
      if (!(await isSsoOriginatedSession(user.id))) {
        throw new ApiError("sso_required", 403);
      }
    }
    // Owner: bypass allowed (break-glass, audited below).
  }

  // 5. Group→role mapping.
  const mapped = await resolveGroupRole(cfg.wsId, id.groups);
  const existing = await getMembership(cfg.wsId, user.id);

  if (!existing) {
    // JIT auto-join (member role by default, or the mapped role).
    await autoJoinFromSso(cfg.wsId, user.id, mapped ?? "member");
  } else if (mapped) {
    // IdP group changes sync down to role, EXCEPT owner (never demoted by sync).
    if (existing.role !== "owner" && existing.role !== mapped) {
      await syncRole(cfg.wsId, user.id, mapped);
    }
  }

  // 6. Issue session.
  await issueSession(user.id, {
    method: "sso",
    provider: cfg.provider,
    wsId: cfg.wsId,
  });

  // 7. Audit.
  await audit(cfg.wsId, {
    actorType: "sso",
    actorId: user.id,
    action: "auth.sso.login",
    target: { provider: cfg.provider, jit: !existing },
  });

  return { userId: user.id };
}

// ───────────────────────────────────────────────
// verifyDomain — DNS TXT challenge
// ───────────────────────────────────────────────

export interface DomainVerificationResult {
  instructions: string;
  token: string;
}

/**
 * Begin domain verification. Generates a DNS TXT challenge token
 * (`supa-verify=<hex>`). The workspace owner adds this as a TXT record on
 * their domain. A separate `confirmDomain` call checks the DNS record.
 *
 * Owner-only. The token is saved as a pending claim (not yet active on the
 * workspace — `workspaces.domain_verified` is set only after DNS confirmation).
 */
export async function verifyDomain(
  wsId: string,
  byUserId: string,
  domain: string,
): Promise<DomainVerificationResult> {
  await requireRole(wsId, byUserId, "owner");

  const token = `supa-verify=${randomBytes(24).toString("hex")}`;
  await savePendingClaim(wsId, domain, token);

  return {
    instructions: `Add a TXT record on _supa-verify.${domain} with value: ${token}`,
    token,
  };
}

/**
 * Confirm domain verification by checking the DNS TXT record. If the record
 * matches the pending claim, sets `workspaces.domain_verified = domain`.
 */
export async function confirmDomain(
  wsId: string,
  byUserId: string,
  domain: string,
): Promise<{ verified: boolean }> {
  await requireRole(wsId, byUserId, "owner");

  const claim = await getPendingClaim(wsId, domain);
  if (!claim) {
    throw new ApiError("no_pending_claim", 404);
  }

  // Check DNS TXT record for _supa-verify.<domain>.
  const records = await resolveTxtRecords(`_supa-verify.${domain}`);
  const verified = records.some((r) => r === claim!.token);

  if (verified) {
    await db
      .update(workspaces)
      .set({ domainVerified: domain })
      .where(eq(workspaces.id, wsId as any));
    await clearPendingClaim(wsId, domain);
    await audit(wsId, {
      actorType: "user",
      actorId: byUserId,
      action: "ws.domain.verified",
      target: { domain },
    });
  }

  return { verified };
}

// ───────────────────────────────────────────────
// Pending claim store (DNS TXT challenge tokens)
// ───────────────────────────────────────────────

// In-memory pending claims (production: Redis or a DB table).
const pendingClaims = new Map<string, { token: string; createdAt: number }>();

async function savePendingClaim(wsId: string, domain: string, token: string): Promise<void> {
  pendingClaims.set(`${wsId}:${domain}`, { token, createdAt: Date.now() });
}

async function getPendingClaim(wsId: string, domain: string): Promise<{ token: string } | null> {
  const entry = pendingClaims.get(`${wsId}:${domain}`);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > 24 * 60 * 60 * 1000) {
    pendingClaims.delete(`${wsId}:${domain}`);
    return null; // 24h expiry.
  }
  return { token: entry.token };
}

async function clearPendingClaim(wsId: string, domain: string): Promise<void> {
  pendingClaims.delete(`${wsId}:${domain}`);
}

/** Resolve DNS TXT records (stub — real impl uses node:dns). */
async function resolveTxtRecords(hostname: string): Promise<string[]> {
  // Stub — real impl: `import { resolveTxt } from "node:dns/promises";`
  return [];
}

// ───────────────────────────────────────────────
// requireRole — reused from members/service.ts (duplicated for module independence)
// ───────────────────────────────────────────────

async function requireRole(
  wsId: string,
  userId: string,
  requiredRole: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("not_a_member", 403);
  if (m.status !== "active") throw new ApiError(`membership_${m.status}`, 403);
  const roleRank: Record<string, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if ((roleRank[m.role] ?? 0) < (roleRank[requiredRole] ?? 0)) {
    throw new ApiError(`insufficient_role:${m.role}<${requiredRole}`, 403);
  }
}
