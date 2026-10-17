/**
 * @supa/design-onboarding — the 60-second path.
 *
 *   onboarding — 3-pick seed intent, template install + token
 *                substitution, first-edit coach (contextual, not
 *                tour-based), coach-mark op recording (resume
 *                across devices, never repeat), empty-canvas users
 *                get the archetype token table in the inspector.
 *   metrics    — time-to-first-edit/share, D7 return by path,
 *                coach dismissal rate (implicit signal for
 *                ai-quality channel of onboarding itself), A/B
 *                assignment sticky per account.
 *
 * Built entirely from existing machinery: design-marketplace
 * (template install), design-tokens (token substitution),
 * design-render (live archetype previews), design-model (ops).
 */

export * from "./onboarding.js";
export * from "./metrics.js";
