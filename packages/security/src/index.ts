/**
 * @supa/security — authz model + five threat boundaries.
 *
 *   primitives          — capability model (cap = subject + resource +
 *                          grants + via + expires); single resolver;
 *                          per-op-batch check.
 *   share-links         — 128-bit token, hashed at rest, optional
 *                          password + expiry, revocable; per-doc scope
 *                          (never per-project).
 *   boundary-1-sync     — client ↔ sync hub: server-side op validation,
 *                          rate limits, subscribe-time authz, cap
 *                          re-validation on rev-grant expiry.
 *   boundary-2-assets   — assets across accounts: per-account caps,
 *                          dedupe oracle defense, SVG strict parser,
 *                          image-bomb defenses, EXIF strip confirmation,
 *                          separate-origin CSP headers.
 *   boundary-3-ai       — AI prompt injection: constrained-op output
 *                          gate, untrusted-text delimiters, no tool-
 *                          calling, server-side template versioning.
 *   boundary-4-codegen  — codegen & export path: text→entities escaping,
 *                          asset URL validation, sandboxed iframe
 *                          self-validation harness, signed export URLs.
 *   boundary-5-platform — platform seams: multi-tenant account_id
 *                          scoping (lint rule), SSRF egress proxy,
 *                          secrets manager contract, supply chain gates,
 *                          abuse soft-degrade.
 *
 * The package is imported by sync-hub, ai-gateway, asset fetch,
 * codegen service, and export job — every place a request touches
 * a resource.
 */

export * from "./primitives.js";
export * from "./share-links.js";
export * from "./boundary-1-sync.js";
export * from "./boundary-2-assets.js";
export * from "./boundary-3-ai.js";
export * from "./boundary-4-codegen.js";
export * from "./boundary-5-platform.js";
