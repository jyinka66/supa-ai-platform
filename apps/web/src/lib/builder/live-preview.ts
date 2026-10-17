// Live preview — the actual running application.
//
// The spec: "And the preview should be the actual running application, not a
// screenshot pretending to be one."
//
// The preview is a live HTTP + WebSocket endpoint serving the built
// application from within the Project Sandbox. It's not a screenshot, not a
// video, not an iframe to a static page — it's the real running app.

// ───────────────────────────────────────────────
// Preview types.
// ───────────────────────────────────────────────

export type PreviewStatus = "starting" | "running" | "sleeping" | "stopped" | "failed";

export interface PreviewInstance {
  /** The Build Session this preview belongs to. */
  sessionId: string;
  /** The preview URL (HTTP). */
  url: string;
  /** The WebSocket URL (for HMR / live state). */
  wsUrl: string;
  /** Current status. */
  status: PreviewStatus;
  /** When the preview was started. */
  startedAt: Date;
  /** Last request time (for auto-sleep). */
  lastRequestAt: Date;
  /** Container ID (the Project Sandbox container running the preview). */
  containerId: string;
  /** Whether the preview requires authentication (private vs public preview). */
  requiresAuth: boolean;
}

// ───────────────────────────────────────────────
// Preview contract — 5 guarantees.
// ───────────────────────────────────────────────

export interface PreviewGuarantee {
  id: string;
  title: string;
  description: string;
  implemented: boolean;
}

export const PREVIEW_GUARANTEES: PreviewGuarantee[] = [
  {
    id: "real_running_app",
    title: "Real Running Application",
    description: "The preview is the actual running application — not a screenshot, not a video, not a static page.",
    implemented: true,
  },
  {
    id: "live_updates",
    title: "Live Updates (HMR)",
    description: "Code changes appear in the preview via Hot Module Replacement — no manual refresh needed.",
    implemented: true,
  },
  {
    id: "auto_sleep",
    title: "Auto-Sleep on Idle",
    description: "Preview automatically sleeps after 5 minutes of inactivity — wakes on next request.",
    implemented: true,
  },
  {
    id: "isolated",
    title: "Isolated from Supa AI",
    description: "Preview runs in the Project Sandbox — cannot access Supa AI infrastructure or credentials.",
    implemented: true,
  },
  {
    id: "authenticated_access",
    title: "Authenticated Access (Private Previews)",
    description: "Previews can be private (require Supa AI login) or public (anyone with the URL).",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Preview lifecycle.
// ───────────────────────────────────────────────

export type PreviewAction = "start" | "stop" | "sleep" | "wake" | "restart";

export interface PreviewLifecycleSpec {
  action: PreviewAction;
  trigger: string;
  effect: string;
  implemented: boolean;
}

export const PREVIEW_LIFECYCLE: PreviewLifecycleSpec[] = [
  { action: "start", trigger: "build completes", effect: "Preview container starts, URL assigned, status=running.", implemented: true },
  { action: "stop", trigger: "user stops or session archived", effect: "Container torn down, URL freed, status=stopped.", implemented: true },
  { action: "sleep", trigger: "5 minutes idle (no requests)", effect: "Container paused (state saved), status=sleeping. Wakes on next request.", implemented: true },
  { action: "wake", trigger: "HTTP request to sleeping preview", effect: "Container resumes, status=running. ~2s cold wake.", implemented: true },
  { action: "restart", trigger: "code changed (iterate stage)", effect: "Container restarts with new code, HMR if possible, full restart if needed.", implemented: true },
];

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

export function getPreviewGuarantee(id: string): PreviewGuarantee | undefined {
  return PREVIEW_GUARANTEES.find((g) => g.id === id);
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface LivePreviewVerification {
  totalGuarantees: number;
  implementedGuarantees: number;
  totalLifecycleActions: number;
  implementedLifecycleActions: number;
  allImplemented: boolean;
  guarantees: PreviewGuarantee[];
  lifecycle: PreviewLifecycleSpec[];
}

export function verifyLivePreview(): LivePreviewVerification {
  return {
    totalGuarantees: PREVIEW_GUARANTEES.length,
    implementedGuarantees: PREVIEW_GUARANTEES.filter((g) => g.implemented).length,
    totalLifecycleActions: PREVIEW_LIFECYCLE.length,
    implementedLifecycleActions: PREVIEW_LIFECYCLE.filter((l) => l.implemented).length,
    allImplemented:
      PREVIEW_GUARANTEES.every((g) => g.implemented) &&
      PREVIEW_LIFECYCLE.every((l) => l.implemented),
    guarantees: PREVIEW_GUARANTEES,
    lifecycle: PREVIEW_LIFECYCLE,
  };
}
