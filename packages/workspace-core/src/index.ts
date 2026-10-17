/**
 * @supa/workspace-core — the tenancy spine.
 *
 *   workspace    — WorkspaceId branded type, WorkspaceScope (required
 *                  first param for every repository), roles
 *                  (owner/member/viewer), lint rule contract (no raw
 *                  DB access outside repositories), cross-tenant
 *                  isolation property-test contract.
 *   profile     — BusinessProfile (currency/tax defaults/invoice
 *                  prefix/numbering/bank details/branding/payment
 *                  terms). Switching profile = scoped context
 *                  switch, same workspace.
 *   capabilities — can(user, action, resource) — the single authority
 *                  for "is this account allowed to do this thing?".
 *                  Closed action taxonomy + role-action matrix (no
 *                  default-allow).
 *   repository  — Repository base interface, scoped() helper for
 *                  capability check + repository call, isolation
 *                  test harness.
 *
 * The rule: every table, every query, every export carries
 * workspace_id, and the rule is structural, not habitual.
 */

export * from "./workspace.js";
export * from "./profile.js";
export * from "./capabilities.js";
export * from "./repository.js";
