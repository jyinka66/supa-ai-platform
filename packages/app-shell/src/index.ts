// @supa/app-shell — the application shell (routing + session management)
//
// Exports:
//   - workspace: entities, session state machine, routing
//   - sync-lifecycle: outbox, rebasing, presence
//   - auth: auth gate, share sessions, comments
//   - palette-registry: command palette aggregate
//   - pwa: service worker, background sync, offline detection

export * from "./workspace";
export {
  SyncLifecycle,
  computeRemoteSelections,
  renderRemoteSelections,
  type SyncTransport,
  type OutboundOp,
  type InboundOp,
  type LocalPresence,
  type PresenceUpdate,
  type RemoteSelectionRect,
} from "./sync-lifecycle";
export {
  checkAuthGate,
  deriveAccess,
  resolveShareSession,
  loadComments,
  addComment,
  resolveComment,
  type AuthProvider,
  type AuthSession,
  type AuthUser,
  type AuthGateResult,
  type DocRole,
  type DocAccess,
  type ShareSession,
  type CommentPin,
  type CommentThread,
} from "./auth";
export {
  searchPalette,
  recordCommandUsage,
  getRecentCommands,
  getVersionHistory,
  restoreVersion,
  setFeatureFlags,
  setCreditBalance,
  hasCredits,
  getCreditBalance,
  isFeatureEnabled,
  type PaletteCommand,
  type PaletteState,
  type VersionSnapshot,
} from "./palette-registry";
export {
  registerServiceWorker,
  applyServiceWorkerUpdate,
  registerBackgroundSync,
  onOnlineStatusChange,
  getIsOnline,
  SW_SOURCE,
} from "./pwa";
