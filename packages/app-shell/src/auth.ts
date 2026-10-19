// ─────────────────────────────────────────────────────────────
// Auth seams: the shell never sees tokens.
//
// design-auth exposes:
//   getSession(), signInWith*(provider), onChange(cb)
// and an auth-gate component wraps routes.
//
// Ownership checks happen server-side (sync endpoint enforces);
// client-side roles only gate UI (hide edit chrome on view-only
// shares) — UI gating is UX, not security, and is commented as such
// so nobody "fixes" security by hiding buttons.
//
// Share links: /s/:token → read-only presentation or comment mode;
// comment mode = click page → threaded comment pins stored as a
// sidecar doc (never inside the DesignDoc — comments don't belong
// in design history and would pollute undo/fidelity).
// ─────────────────────────────────────────────────────────────

// ============ AUTH SESSION ============

export interface AuthSession {
  user: AuthUser;
  /** Access token (for API calls — the shell never logs this). */
  accessToken: string;
  /** When the token expires (epoch ms). */
  expiresAt: number;
  /** The auth provider used to sign in. */
  provider: "email" | "google" | "github" | "apple" | "magic-link";
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

// ============ AUTH PROVIDER INTERFACE ============

/**
 * The auth provider interface — the shell depends on this, not on
 * Supabase/Auth0/Cognito directly. The implementation is injected.
 *
 * The shell NEVER sees tokens directly — it calls getSession() and
 * passes the session to the sync transport, which handles auth headers.
 */
export interface AuthProvider {
  /** Returns the current session, or null if not authenticated. */
  getSession(): Promise<AuthSession | null>;
  /** Signs in with email + password. */
  signInWithEmail(email: string, password: string): Promise<AuthSession>;
  /** Signs in with an OAuth provider (redirect flow). */
  signInWithOAuth(provider: "google" | "github" | "apple"): Promise<void>;
  /** Sends a magic link to the email. */
  signInWithMagicLink(email: string): Promise<void>;
  /** Signs up with email + password. */
  signUp(email: string, password: string): Promise<AuthSession>;
  /** Signs out (clears session). */
  signOut(): Promise<void>;
  /** Subscribes to auth state changes. */
  onChange(handler: (session: AuthSession | null) => void): () => void;
  /** Refreshes the session (if the token is about to expire). */
  refreshSession(): Promise<AuthSession | null>;
}

// ============ AUTH GATE ============

export interface AuthGateResult {
  /** True if the user is authenticated. */
  authenticated: boolean;
  /** The session if authenticated, null otherwise. */
  session: AuthSession | null;
  /** True if the route is a public share link (no auth needed). */
  isShareLink: boolean;
  /** The share token if viewing a share link. */
  shareToken: string | null;
}

/**
 * Determines whether a route requires authentication.
 *
 * Share links (/s/:token) are public — no auth needed.
 * All other routes require a valid session.
 *
 * @example
 *   const gate = await checkAuthGate(authProvider, pathname);
 *   if (!gate.authenticated && !gate.isShareLink) {
 *     redirectTo("/login?next=" + encodeURIComponent(pathname));
 *   }
 */
export async function checkAuthGate(
  auth: AuthProvider,
  pathname: string,
): Promise<AuthGateResult> {
  // Check if this is a share link.
  const shareMatch = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/);
  if (shareMatch) {
    return {
      authenticated: false,
      session: null,
      isShareLink: true,
      shareToken: shareMatch[1] ?? "",
    };
  }

  // Check auth.
  const session = await auth.getSession();
  return {
    authenticated: session !== null,
    session,
    isShareLink: false,
    shareToken: null,
  };
}

// ============ ROLE-BASED UI GATING ============

export type DocRole = "owner" | "editor" | "commenter" | "viewer";

export interface DocAccess {
  role: DocRole;
  /** True if the user can edit the doc. */
  canEdit: boolean;
  /** True if the user can comment. */
  canComment: boolean;
  /** True if the user can share. */
  canShare: boolean;
  /** True if the user can export. */
  canExport: boolean;
}

/**
 * Derives access permissions from a role.
 *
 * IMPORTANT: These are UX gates only — hiding edit chrome on view-only
 * shares. Security is enforced server-side (the sync endpoint checks
 * ownership/permissions). Client-side role checks are convenience UX,
 * NOT security. Do not "fix" security by hiding buttons.
 *
 * @example
 *   const access = deriveAccess("viewer");
 *   if (access.canEdit) showToolbar();
 *   else showReadOnlyBanner();
 */
export function deriveAccess(role: DocRole): DocAccess {
  switch (role) {
    case "owner":
      return { role, canEdit: true, canComment: true, canShare: true, canExport: true };
    case "editor":
      return { role, canEdit: true, canComment: true, canShare: false, canExport: true };
    case "commenter":
      return { role, canEdit: false, canComment: true, canShare: false, canExport: true };
    case "viewer":
      return { role, canEdit: false, canComment: false, canShare: false, canExport: true };
  }
}

// ============ SHARE SESSION ============

export interface ShareSession {
  token: string;
  /** The doc being shared. */
  docId: string;
  /** The role granted by the share link. */
  role: DocRole;
  /** Whether a password is required. */
  requiresPassword: boolean;
  /** Whether the share link is for a single page or all pages. */
  pageScope: string;
}

/**
 * Fetches share session info from the server.
 * The server validates the token + returns the role + doc ID.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveShareSession(
  token: string,
  password?: string,
): Promise<ShareSession> {
  const res = await fetch(`/api/work/share/${token}`, {
    method: password ? "POST" : "GET",
    ...(password ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    } : {}),
  });

  if (!res.ok) {
    throw new Error(`share_resolve_failed: ${String(res.status)}`);
  }

  const payload: unknown = await res.json();
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error("share_resolve_invalid_response");
  }
  const data = payload.data;
  const roleValue = data.role;
  const role: DocRole = roleValue === "owner" || roleValue === "editor" || roleValue === "commenter" || roleValue === "viewer"
    ? roleValue
    : "viewer";
  const docId = typeof data.itemId === "string" ? data.itemId : typeof data.folderId === "string" ? data.folderId : "";
  return { token, docId, role, requiresPassword: data.requiresPassword === true, pageScope: "all" };
}

// ============ COMMENTS (sidecar — never in the DesignDoc) ============

export interface CommentPin {
  id: string;
  /** Page the comment is on. */
  pageId: string;
  /** Page-space position of the pin. */
  position: { x: number; y: number };
  /** The comment thread. */
  thread: CommentThread;
  /** Author of the first comment. */
  authorId: string;
  authorName: string;
  /** ISO timestamps. */
  createdAt: string;
  resolvedAt: string | null;
}

export interface CommentThread {
  comments: Array<{
    id: string;
    authorId: string;
    authorName: string;
    text: string;
    createdAt: string;
  }>;
}

/**
 * Comments are stored as a SIDECAR doc — never inside the DesignDoc.
 *
 * Rationale: comments don't belong in design history. If they were
 * DesignDoc nodes, they would pollute undo/fidelity and appear in
 * exports. Instead, they're stored separately (a per-doc comment
 * collection) and rendered as an overlay.
 *
 * @example
 *   const pins = await loadComments(docId);
 *   renderCommentPins(pins); // overlay layer
 */
export async function loadComments(docId: string): Promise<CommentPin[]> {
  const res = await fetch(`/api/docs/${docId}/comments`);
  if (!res.ok) {
    throw new Error(`loadComments: failed to fetch comments for doc ${docId} (${String(res.status)})`);
  }
  const json = (await res.json()) as { data?: CommentPin[] };
  return json.data ?? [];
}

export async function addComment(
  docId: string,
  pageId: string,
  position: { x: number; y: number },
  text: string,
): Promise<CommentPin> {
  const res = await fetch(`/api/docs/${docId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId, position, text }),
  });
  if (!res.ok) {
    throw new Error(`addComment: failed to post comment for doc ${docId} (${res.status})`);
  }
  const json = (await res.json()) as { data?: CommentPin };
  if (!json.data) {
    throw new Error(`addComment: server returned no comment`);
  }
  return json.data;
}

export async function resolveComment(docId: string, commentId: string): Promise<void> {
  const res = await fetch(`/api/docs/${docId}/comments/${commentId}/resolve`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(
      `resolveComment: failed to resolve comment ${commentId} for doc ${docId} (${res.status})`,
    );
  }
}
