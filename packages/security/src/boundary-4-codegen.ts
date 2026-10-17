/**
 * @supa/security/boundary-4-codegen
 * ----------------------------------------------------------------
 * Threat boundary 4: codegen & export path.
 *
 * Copy-as-code output is executed by users in their own apps —
 * treat it as untrusted-input-into-code.
 *
 *   - Doc text/assets interpolate into HTML/JSX with proper escaping
 *     (text → entities, asset URLs → validated same-origin or
 *     hashed asset URLs only); a doc named `<script>` must not
 *     break a generated page. Fuzzed corpus (io pass) feeds codegen
 *     XSS tests.
 *
 *   - The iframe self-validation harness renders generated snippets
 *     with sandboxed iframes — never executes user-influenced
 *     snippets with our origin's authority.
 *
 *   - Export artifacts (TTL 7d) served from assets-origin, behind
 *     caps; a shared export link is a signed URL, expiring.
 * ----------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Text → entities (HTML/JSX escaping)
// ───────────────────────────────────────────────

/**
 * The codegen path interpolates doc text into HTML/JSX. The doc is
 * attacker-influenced (a doc named `<script>` is a real attack vector
 * if text isn't escaped). Every interpolation point uses one of
 * these context-specific escapers — never a generic escape, because
 * HTML attribute context ≠ text content context ≠ JS string context.
 */
export function escapeHtmlText(s: string): string {
  // For HTML text content: &, <, >, ", '.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeHtmlAttr(s: string): string {
  // For HTML attribute values (quoted): same as text but stricter.
  return escapeHtmlText(s);
}

export function escapeJsString(s: string): string {
  // For interpolation inside a JS string literal: < / > / & / " / ' /
  // backslash / newline / line-separator / paragraph-separator.
  // We also escape `</` so an attacker closing a <script> tag from
  // inside a JS string can't break out.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/<\//g, "<\\/");
}

export function escapeUrlAttr(s: string): string {
  // For URL-valued attributes (href, src): we only allow same-origin
  // or validated asset URLs. Anything else is dropped.
  // The escaping prevents attribute-breakout (`" onclick=`).
  return escapeHtmlAttr(s);
}

// ───────────────────────────────────────────────
// Asset URL validation
// ───────────────────────────────────────────────

/**
 * Asset URLs in generated code must be either:
 *   (a) same-origin absolute paths (`/asset/:hash`), or
 *   (b) absolute URLs to assets-origin (`https://assets.<domain>/asset/:hash`).
 *
 * External URLs (https://attacker.com/x.png) are NOT permitted in
 * generated code — they'd leak the user's IP and could carry
 * tracking. The only exception is the user's own uploaded assets,
 * which are always content-hashed and served from assets-origin.
 */
export interface AssetUrlValidationOptions {
  /** Allowed assets-origin host (e.g., "assets.supa-ai.com"). */
  assetsOriginHost: string;
  /** Allowed app origin host (e.g., "supa-ai.com"). */
  appOriginHost: string;
}

export type AssetUrlKind = "same-origin-path" | "assets-origin" | "rejected";

export function validateAssetUrl(
  url: string,
  opts: AssetUrlValidationOptions,
): { kind: AssetUrlKind; reason?: string } {
  // Same-origin absolute path: /asset/<hash>
  if (url.startsWith("/asset/")) {
    if (!/^\/asset\/[0-9a-f]{64}$/.test(url)) {
      return { kind: "rejected", reason: "same-origin asset URL must be /asset/<sha256>" };
    }
    return { kind: "same-origin-path" };
  }
  // Absolute URL to assets-origin
  try {
    const u = new URL(url);
    if (u.host === opts.assetsOriginHost && u.protocol === "https:") {
      if (!/^\/asset\/[0-9a-f]{64}$/.test(u.pathname)) {
        return { kind: "rejected", reason: "assets-origin URL must be /asset/<sha256>" };
      }
      return { kind: "assets-origin" };
    }
    if (u.host === opts.appOriginHost && u.protocol === "https:") {
      if (/^\/asset\/[0-9a-f]{64}$/.test(u.pathname)) {
        return { kind: "same-origin-path" };
      }
    }
    return { kind: "rejected", reason: `host ${u.host} not in allowlist` };
  } catch {
    return { kind: "rejected", reason: "malformed URL" };
  }
}

// ───────────────────────────────────────────────
// HTML/JSX codegen interpolator
// ───────────────────────────────────────────────

/**
 * Safe interpolation of doc content into generated HTML/JSX.
 *
 * Every value interpolated into the template MUST go through one of
 * the context-specific escapers. The codegen template uses tagged
 * template literals so the developer can't accidentally forget:
 *
 *   const html = interpolateHtml(ctx);
 *   html`<div>${text("doc text")}</div>`            → text context
 *   html`<img src="${assetUrl("hash")} />`           → url context (validated)
 *   html`<a href="${link}">${label}</a>`             → attr + text context
 *
 * The tag is the only entry point; there is no `raw` interpolation.
 *
 * Why curry: a tagged template `f\`...\`` calls `f(strings, ...values)`.
 * There's no way to pass a third `ctx` argument through that call,
 * so the context must be supplied via closure.
 */
export type InterpolationValue =
  | { kind: "text"; value: string }
  | { kind: "attr"; value: string }
  | { kind: "url"; value: string }
  | { kind: "js"; value: string }
  | { kind: "asset-url"; value: string };

export interface CodegenContext {
  assetUrlOpts: AssetUrlValidationOptions;
}

/** Convenience constructors for the discriminated-union values. */
export const text = (value: string): InterpolationValue => ({ kind: "text", value });
export const attr = (value: string): InterpolationValue => ({ kind: "attr", value });
export const jsStr = (value: string): InterpolationValue => ({ kind: "js", value });
export const url = (value: string): InterpolationValue => ({ kind: "url", value });
export const assetUrl = (value: string): InterpolationValue => ({ kind: "asset-url", value });

/**
 * Create a tagged template function bound to the given context.
 * Use as: `interpolateHtml(ctx)\`<div>${text("...")}</div>\``.
 */
export function interpolateHtml(ctx: CodegenContext) {
  return (strings: readonly string[], ...values: InterpolationValue[]): string => {
    let out = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      switch (v.kind) {
        case "text":
          out += escapeHtmlText(v.value);
          break;
        case "attr":
          out += escapeHtmlAttr(v.value);
          break;
        case "js":
          out += escapeJsString(v.value);
          break;
        case "url": {
          const result = validateAssetUrl(v.value, ctx.assetUrlOpts);
          if (result.kind === "rejected") {
            out += "about:blank";
          } else {
            out += escapeUrlAttr(v.value);
          }
          break;
        }
        case "asset-url": {
          const result = validateAssetUrl(v.value, ctx.assetUrlOpts);
          if (result.kind === "rejected") {
            out += "about:blank";
          } else {
            out += escapeUrlAttr(v.value);
          }
          break;
        }
      }
      out += strings[i + 1] ?? "";
    }
    return out;
  };
}

// ───────────────────────────────────────────────
// Sandboxed iframe self-validation harness
// ───────────────────────────────────────────────

/**
 * The codegen path renders generated snippets in a sandboxed iframe
 * to self-validate (does the layout match the doc? does it throw?).
 * The iframe NEVER executes user-influenced snippets with our
 * origin's authority — it's a fully sandboxed, no-origin context.
 *
 * The contract is enforced by the iframe `sandbox` attribute: no
 * `allow-same-origin`, no `allow-scripts` of any origin-trusting
 * kind. The harness loads a tiny bootstrap that runs the snippet in
 * a Web Worker (no DOM access to our origin), measures the result,
 * and posts a message back.
 *
 * This module owns the harness config + the message-passing protocol.
 * The actual iframe is created by the codegen service.
 */

export const SANDBOX_IFRAME_ATTRS = [
  "sandbox",                              // no features
  // NOT included: allow-same-origin, allow-scripts, allow-top-navigation
].join(" ");

export const SANDBOX_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-eval'",             // Worker eval — but no DOM, no origin
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface SandboxValidationRequest {
  /** Generated HTML snippet (already escaped). */
  html: string;
  /** Expected layout assertions (selectors + bounds). */
  assertions: LayoutAssertion[];
  /** Timeout (ms) — snippet must complete validation within this. */
  timeoutMs: number;
}

export interface LayoutAssertion {
  /** CSS selector to query. */
  selector: string;
  /** Expected bounds { x, y, width, height } in px. */
  expected: { x: number; y: number; width: number; height: number };
  /** Tolerance in px (default 0). */
  tolerance?: number;
}

export interface SandboxValidationResult {
  ok: boolean;
  /** Which assertions failed (with actual vs expected). */
  failures: { selector: string; expected: unknown; actual: unknown }[];
  /** Console errors emitted by the snippet. */
  consoleErrors: string[];
  /** Whether the snippet threw. */
  threw: boolean;
  errorMessage?: string;
  /** Elapsed ms. */
  elapsedMs: number;
}

/**
 * Message protocol between the harness host and the sandboxed iframe.
 * The iframe posts a `sandbox:result` message back when validation
 * completes (or times out). The host listens for this message and
 * resolves the validation promise.
 */
export interface SandboxResultMessage {
  type: "sandbox:result";
  ok: boolean;
  failures: SandboxValidationResult["failures"];
  consoleErrors: string[];
  threw: boolean;
  errorMessage?: string;
  elapsedMs: number;
}

export function isSandboxResultMessage(data: unknown): data is SandboxResultMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "sandbox:result" &&
    typeof d.ok === "boolean" &&
    Array.isArray(d.failures) &&
    Array.isArray(d.consoleErrors) &&
    typeof d.threw === "boolean" &&
    typeof d.elapsedMs === "number"
  );
}

// ───────────────────────────────────────────────
// Signed export URLs (TTL 7d, behind caps)
// ───────────────────────────────────────────────

/**
 * Export artifacts live on assets-origin with a 7d TTL. A shared
 * export link is a signed URL — the signature is HMAC-SHA256 over
 * (assetHash, expires, grant), keyed by the EXPORT_URL_SECRET.
 *
 * The fetch path checks the signature AND the cap (the cap proves
 * the requester's account owns or was granted the export). Even
 * with a leaked signed URL, the cap check still gates the fetch —
 * defense in depth.
 */

export interface SignedExportUrlParams {
  /** Asset hash of the export artifact. */
  assetHash: string;
  /** Expiry (ms epoch). Max 7d from issue. */
  expires: number;
  /** Grant the URL confers (typically "read"). */
  grant: "read";
  /** Account the URL was issued to. */
  accountId: string;
  /** HMAC secret (from secrets manager). */
  secret: string;
}

export interface SignedExportUrl {
  /** Full URL: https://<assets-origin>/export/:assetHash?expires=&account=&sig= */
  url: string;
  /** Signature (hex). */
  signature: string;
  /** Expiry (ms epoch). */
  expires: number;
}

const MAX_EXPORT_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function signExportUrl(
  params: SignedExportUrlParams,
  assetsOriginHost: string,
  issuedAt: number = Date.now(),
): SignedExportUrl {
  if (params.expires - issuedAt > MAX_EXPORT_URL_TTL_MS) {
    throw new Error(
      `export URL TTL exceeds ${MAX_EXPORT_URL_TTL_MS}ms (7d) cap: expires=${params.expires} issuedAt=${issuedAt}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(params.assetHash)) {
    throw new Error(`invalid asset hash: ${params.assetHash}`);
  }
  const message = `${params.assetHash}|${params.expires}|${params.grant}|${params.accountId}`;
  const signature = createHmac("sha256", params.secret)
    .update(message)
    .digest("hex");
  const url = `https://${assetsOriginHost}/export/${params.assetHash}?expires=${params.expires}&account=${encodeURIComponent(params.accountId)}&sig=${signature}`;
  return { url, signature, expires: params.expires };
}

export interface VerifyExportUrlParams {
  assetHash: string;
  expires: number;
  grant: "read";
  accountId: string;
  signature: string;
  secret: string;
  now?: number;
}

export function verifyExportUrl(params: VerifyExportUrlParams): boolean {
  const now = params.now ?? Date.now();
  if (now >= params.expires) return false;
  const message = `${params.assetHash}|${params.expires}|${params.grant}|${params.accountId}`;
  const expected = createHmac("sha256", params.secret)
    .update(message)
    .digest("hex");
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(params.signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
