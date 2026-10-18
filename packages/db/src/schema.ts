import { pgTable, text, timestamp, uuid, boolean, integer, pgEnum, uniqueIndex, index, jsonb, numeric, smallint, bigint, customType, inet } from "drizzle-orm/pg-core";

// bytea — binary data (Postgres). Drizzle 0.33 doesn't export a built-in
// bytea column; define it via customType. Used for: api_keys.hash (argon2id
// hash bytes), enterprise_audit_log.prev_hash/hash (sha256 hash chain),
// webhook_endpoints.secret (HMAC signing key).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer) {
    return value;
  },
  fromDriver(value: Buffer) {
    return value;
  },
});

export const workspaceRoleEnum = pgEnum("workspace_role", ["owner", "admin", "member", "viewer"]);
export const userRoleTypeEnum = pgEnum("user_role_type", ["individual", "business", "enterprise"]);
export const inviteStatusEnum = pgEnum("invite_status", ["pending", "accepted", "revoked"]);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().references(() => { throw new Error("see sql"); }), // users FK set in raw SQL (Drizzle can't reference auth schema)
    fullName: text("full_name"),
    avatarPath: text("avatar_path"),
    country: text("country"),
    timezone: text("timezone").default("UTC").notNull(),
    language: text("language").default("en").notNull(),
    roleType: userRoleTypeEnum("role_type").default("individual").notNull(),
    bio: text("bio"),
    company: text("company"),
    isVerified: boolean("is_verified").default(false).notNull(),
    onboardingStep: integer("onboarding_step").default(0).notNull(),
    onboardingComplete: boolean("onboarding_complete").default(false).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    workViewPrefs: jsonb("work_view_prefs").default({ view: "grid", sort: "newest", density: "comfortable" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    profiles_language_idx: index("profiles_language_idx").on(t.language),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    logoPath: text("logo_path"),
    country: text("country"),
    timezone: text("timezone").default("UTC").notNull(),
    defaultLanguage: text("default_language").default("en").notNull(),
    isPersonal: boolean("is_personal").default(false).notNull(),
    plan: text("plan").default("free").notNull(),
    seatLimit: integer("seat_limit").default(3).notNull(),
    billingOwnerId: uuid("billing_owner_id").notNull(),
    // Enterprise columns (migration 0029).
    kind: text("kind").notNull().default("team"),
    region: text("region").notNull().default("us-east"),
    ssoEnforced: boolean("sso_enforced").notNull().default(false),
    domainVerified: text("domain_verified"),
    settings: jsonb("settings").notNull().default({}),
    billing: jsonb("billing"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
    // migration 0031: hard-purge eligibility + billing cron columns.
    purgeAt: timestamp("purge_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    billingState: text("billing_state").notNull().default("active"),
    lockoutAt: timestamp("lockout_at", { withTimezone: true }),
    downgradeAt: timestamp("downgrade_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaces_slug_idx: index("workspaces_slug_idx").on(t.slug),
  }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: workspaceRoleEnum("role").default("member").notNull(),
    invitedBy: uuid("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspace_members_unique: uniqueIndex("workspace_members_unique").on(t.workspaceId, t.userId),
    workspace_members_user_idx: index("workspace_members_user_idx").on(t.userId),
  }),
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: workspaceRoleEnum("role").default("member").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 of signed token; raw token never stored
    invitedBy: uuid("invited_by").notNull(),
    status: inviteStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    resendCount: integer("resend_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    invites_workspace_idx: index("invites_workspace_idx").on(t.workspaceId),
    invites_email_idx: index("invites_email_idx").on(t.email),
  }),
);

export const userSessions = pgTable("user_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const deletionRequests = pgTable("deletion_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  purgeAt: timestamp("purge_at", { withTimezone: true }).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
});

// ============ CHAT CORE ============

export const conversationFolders = pgTable(
  "conversation_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversation_folders_user_name_unique: uniqueIndex("conversation_folders_user_name_unique").on(t.userId, t.name),
    idx_folders_user: index("idx_folders_user").on(t.userId),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    mode: text("mode").default("chat").notNull(),
    title: text("title"),
    titleAuto: boolean("title_auto").default(true).notNull(),
    languagePref: text("language_pref"),
    pinned: boolean("pinned").default(false).notNull(),
    folderId: uuid("folder_id").references(() => conversationFolders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_conv_workspace: index("idx_conv_workspace").on(t.workspaceId, t.updatedAt),
    idx_conv_user: index("idx_conv_user").on(t.userId, t.updatedAt),
    idx_conv_pinned: index("idx_conv_pinned").on(t.userId, t.pinned),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    parentMessageId: uuid("parent_message_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    version: integer("version").default(1).notNull(),
    languageDetected: text("language_detected"),
    promptVersion: text("prompt_version"),
    status: text("status").default("completed").notNull(),
    // migration 0031: GDPR erasure tombstone.
    authorErased: boolean("author_erased").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_msg_conv: index("idx_msg_conv").on(t.conversationId, t.createdAt),
    idx_msg_parent: index("idx_msg_parent").on(t.parentMessageId),
  }),
);

export const messageMeta = pgTable("message_meta", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyFirstTokenMs: integer("latency_first_token_ms"),
  latencyTotalMs: integer("latency_total_ms"),
  retries: integer("retries").default(0).notNull(),
  fallbackPath: jsonb("fallback_path").default([]).notNull(),
  idempotencyKey: text("idempotency_key").unique(),
  requestId: text("request_id"), // edge-generated UUID for traceability
});

export const messageFeedback = pgTable(
  "message_feedback",
  {
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    rating: smallint("rating").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    message_feedback_pk: uniqueIndex("message_feedback_pk").on(t.messageId, t.userId),
    idx_feedback_msg: index("idx_feedback_msg").on(t.messageId),
  }),
);

export const messageReports = pgTable(
  "message_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("open").notNull(),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_reports_status: index("idx_reports_status").on(t.status),
    idx_reports_message: index("idx_reports_message").on(t.messageId),
  }),
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    maxViews: integer("max_views"),
    viewCount: integer("view_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_share_conv: index("idx_share_conv").on(t.conversationId),
    idx_share_expires: index("idx_share_expires").on(t.expiresAt),
  }),
);

export const usageBudgets = pgTable(
  "usage_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    period: text("period").default("monthly").notNull(),
    costLimitUsd: numeric("cost_limit_usd", { precision: 10, scale: 2 }).notNull(),
    alertThreshold: numeric("alert_threshold", { precision: 3, scale: 2 }).default("0.80").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    usage_budgets_scope_unique: uniqueIndex("usage_budgets_scope_unique").on(t.scopeType, t.scopeId, t.period),
  }),
);

// ============ PROMPT A/B TESTING ============

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mode: text("mode").notNull(),
    language: text("language").default("en").notNull(),
    version: text("version").notNull(),
    system: text("system").notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    prompt_versions_mode_lang_version_unique: uniqueIndex("prompt_versions_mode_lang_version_unique").on(t.mode, t.language, t.version),
  }),
);

export const promptPromotions = pgTable(
  "prompt_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slot: text("slot").notNull(),
    winnerVersion: text("winner_version").notNull(),
    loserVersion: text("loser_version").notNull(),
    zScore: numeric("z_score", { precision: 10, scale: 6 }).notNull(),
    winnerApproval: numeric("winner_approval", { precision: 5, scale: 4 }),
    loserApproval: numeric("loser_approval", { precision: 5, scale: 4 }),
    winnerN: integer("winner_n"),
    loserN: integer("loser_n"),
    sampleSizes: jsonb("sample_sizes").default({}).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_prompt_promotions_slot: index("idx_prompt_promotions_slot").on(t.slot, t.decidedAt),
  }),
);

// ============ DEV HARNESS ============

export const mockFailures = pgTable("mock_failures", {
  provider: text("provider").primaryKey(),
  status: integer("status"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============ WORK ITEMS ============

export const workFolders = pgTable(
  "work_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    color: text("color"),
    path: text("path").notNull(), // ltree stored as text in Drizzle
    type: text("type").default("manual").notNull(), // 'manual' | 'smart'
    smartParams: jsonb("smart_params"), // set when type='smart'
    viewPrefs: jsonb("view_prefs"), // per-folder override
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_folders_workspace_parent_name_unique: uniqueIndex("work_folders_workspace_parent_name_unique").on(t.workspaceId, t.parentId, t.name),
  }),
);

export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    title: text("title").default("Untitled").notNull(),
    type: text("type").notNull(),
    status: text("status").default("active").notNull(),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedBy: uuid("trashed_by"),
    content: text("content"),
    contentFormat: text("content_format").default("markdown"),
    fileUrl: text("file_url"),
    fileSize: integer("file_size"),
    fileMime: text("file_mime"),
    thumbnailUrl: text("thumbnail_url"),
    metadata: jsonb("metadata").default({}).notNull(),
    folderId: uuid("folder_id").references(() => workFolders.id, { onDelete: "set null" }),
    favorite: boolean("favorite").default(false).notNull(),
    visibility: text("visibility").default("private").notNull(),
    linkToken: text("link_token").unique(),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    linkPasswordHash: text("link_password_hash"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    currentVersion: integer("current_version").default(1).notNull(),
    searchVector: text("search_vector"), // tsvector stored as text
    // migration 0031: GDPR erasure tombstone.
    creatorErased: boolean("creator_erased").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_items_ws_folder_idx: index("work_items_ws_folder_idx").on(t.workspaceId, t.folderId, t.updatedAt),
    work_items_ws_type_idx: index("work_items_ws_type_idx").on(t.workspaceId, t.type, t.updatedAt),
    work_items_owner_fav_idx: index("work_items_owner_fav_idx").on(t.ownerId),
  }),
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => ({
    tags_workspace_name_unique: uniqueIndex("tags_workspace_name_unique").on(t.workspaceId, t.name),
  }),
);

export const workItemTags = pgTable(
  "work_item_tags",
  {
    itemId: uuid("item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => ({
    work_item_tags_pk: uniqueIndex("work_item_tags_pk").on(t.itemId, t.tagId),
    idx_work_item_tags_tag: index("idx_work_item_tags_tag").on(t.tagId),
  }),
);

export const workItemVersions = pgTable(
  "work_item_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title"),
    content: text("content"),
    contentFormat: text("content_format"),
    metadata: jsonb("metadata"),
    storageKey: text("storage_key"), // file snapshot path (was file_url)
    source: text("source").default("edit").notNull(), // edit | restore | import | ai
    editedBy: uuid("edited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_item_versions_item_version_unique: uniqueIndex("work_item_versions_item_version_unique").on(t.itemId, t.version),
  }),
);

export const workItemLinks = pgTable(
  "work_item_links",
  {
    fromItemId: uuid("from_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    toItemId: uuid("to_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    kind: text("kind").default("related").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_item_links_pk: uniqueIndex("work_item_links_pk").on(t.fromItemId, t.toItemId, t.kind),
  }),
);

export const workItemShares = pgTable(
  "work_item_shares",
  {
    itemId: uuid("item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role").default("viewer").notNull(),
    sharedBy: uuid("shared_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_item_shares_pk: uniqueIndex("work_item_shares_pk").on(t.itemId, t.userId),
  }),
);

// ============ SAVED SEARCHES & HISTORY ============

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    params: jsonb("params").notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_saved_searches_workspace: index("idx_saved_searches_workspace").on(t.workspaceId, t.pinned, t.updatedAt),
    idx_saved_searches_owner: index("idx_saved_searches_owner").on(t.ownerId, t.createdAt),
  }),
);

export const searchHistory = pgTable(
  "search_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    filters: jsonb("filters"),
    resultCount: integer("result_count"),
    tier: text("tier"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_search_history_user: index("idx_search_history_user").on(t.userId, t.createdAt),
    idx_search_history_workspace: index("idx_search_history_workspace").on(t.workspaceId, t.createdAt),
  }),
);

export const workItemViews = pgTable(
  "work_item_views",
  {
    userId: uuid("user_id").notNull(),
    itemId: uuid("item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    work_item_views_pk: uniqueIndex("work_item_views_pk").on(t.userId, t.itemId),
    idx_work_item_views_user: index("idx_work_item_views_user").on(t.userId, t.viewedAt),
  }),
);

// ============ WORK SHARE LINKS + VIEWS ============

export const workShareLinks = pgTable(
  "work_share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => workItems.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => workFolders.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    createdBy: uuid("created_by").notNull(),
    role: text("role").default("view").notNull(),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxViews: integer("max_views"),
    viewCount: integer("view_count").default(0).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_work_share_links_ws: index("idx_work_share_links_ws").on(t.workspaceId),
    idx_work_share_links_token: index("idx_work_share_links_token").on(t.token),
    idx_work_share_links_item: index("idx_work_share_links_item").on(t.itemId),
    idx_work_share_links_folder: index("idx_work_share_links_folder").on(t.folderId),
  }),
);

export const workShareViews = pgTable(
  "work_share_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareLinkId: uuid("share_link_id").notNull().references(() => workShareLinks.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
    ipHash: text("ip_hash"),
    country: text("country"),
    userAgent: text("user_agent"),
    referrer: text("referrer"),
    durationMs: integer("duration_ms"),
  },
  (t) => ({
    idx_work_share_views_link: index("idx_work_share_views_link").on(t.shareLinkId, t.viewedAt),
  }),
);

// ============ EXPORT JOBS ============

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    format: text("format").notNull(),
    selection: jsonb("selection").notNull(),
    status: text("status").default("queued").notNull(),
    progress: integer("progress").default(0).notNull(),
    resultUrl: text("result_url"),
    resultSize: integer("result_size"),
    resultMime: text("result_mime"),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_export_jobs_user: index("idx_export_jobs_user").on(t.userId, t.createdAt),
    idx_export_jobs_status: index("idx_export_jobs_status").on(t.status, t.createdAt),
  }),
);

// ============ AUDIT LOG ============

export const auditLog = pgTable(
  "audit_log",
  {
    id: integer("id").primaryKey(), // bigint generated always as identity in SQL
    actorId: uuid("actor_id"),
    actorKind: text("actor_kind").default("user").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    workspaceId: uuid("workspace_id"),
    metadata: jsonb("metadata").default({}).notNull(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_audit_actor: index("idx_audit_actor").on(t.actorId, t.createdAt),
    idx_audit_target: index("idx_audit_target").on(t.targetType, t.targetId),
    idx_audit_workspace: index("idx_audit_workspace").on(t.workspaceId, t.createdAt),
    idx_audit_action: index("idx_audit_action").on(t.action, t.createdAt),
  }),
);

// ───────────────────────────────────────────────
// Business tables — money spine + CRM + invoicing
// ───────────────────────────────────────────────

// Enums
export const expenseStatusEnum = pgEnum("expense_status", ["draft", "recorded", "approved", "rejected", "reimbursed"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "issued", "partial", "paid", "voided"]);
export const customerStatusEnum = pgEnum("customer_status", ["active", "inactive", "archived"]);
export const activitySourceEnum = pgEnum("activity_source", ["manual", "system", "ai"]);

// Monetary facts — THE single source of truth for "an amount moved"
export const monetaryFacts = pgTable(
  "monetary_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    nativeAmountMinor: bigint("native_amount_minor", { mode: "bigint" }).notNull(),
    nativeCurrency: text("native_currency").notNull(),
    recordedRate: jsonb("recorded_rate"),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_monetary_facts_ws: index("idx_monetary_facts_ws").on(t.workspaceId, t.asOf),
    idx_monetary_facts_source: index("idx_monetary_facts_source").on(t.sourceId, t.kind),
    idx_monetary_facts_kind: index("idx_monetary_facts_kind").on(t.kind, t.asOf),
  }),
);

// Invoice sequence — atomic numbering per (workspace, profile, kind)
export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    kind: text("kind").notNull(),
    next: bigint("next", { mode: "bigint" }).notNull().default(2n),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_invoice_seq_pk: uniqueIndex("idx_invoice_seq_pk").on(t.workspaceId, t.profileId, t.kind),
  }),
);

// Invoices
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    customerId: uuid("customer_id"),
    number: text("number"),
    status: invoiceStatusEnum("status").default("draft").notNull(),
    lineItems: jsonb("line_items").default([]).notNull(),
    taxMode: text("tax_mode").default("per-line").notNull(),
    currency: text("currency").notNull(),
    totals: jsonb("totals").default({}).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    dueInDays: integer("due_in_days").default(30).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_invoices_ws_profile: index("idx_invoices_ws_profile").on(t.workspaceId, t.profileId),
    idx_invoices_status: index("idx_invoices_status").on(t.workspaceId, t.status),
    idx_invoices_customer: index("idx_invoices_customer").on(t.customerId),
    idx_invoices_number: uniqueIndex("idx_invoices_number").on(t.workspaceId, t.profileId, t.number),
  }),
);

// Credit notes
export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_credit_notes_invoice: index("idx_credit_notes_invoice").on(t.invoiceId),
    idx_credit_notes_ws_profile: index("idx_credit_notes_ws_profile").on(t.workspaceId, t.profileId),
  }),
);

// Customers
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    businessName: text("business_name"),
    emails: jsonb("emails").default([]).notNull(),
    phones: jsonb("phones").default([]).notNull(),
    addresses: jsonb("addresses").default([]).notNull(),
    currency: text("currency").default("NGN").notNull(),
    taxId: text("tax_id"),
    tags: jsonb("tags").default([]).notNull(),
    groups: jsonb("groups").default([]).notNull(),
    notes: text("notes").default("").notNull(),
    status: customerStatusEnum("status").default("active").notNull(),
    createdBy: uuid("created_by").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_customers_ws_status: index("idx_customers_ws_status").on(t.workspaceId, t.status),
    idx_customers_ws_name: index("idx_customers_ws_name").on(t.workspaceId, t.name),
  }),
);

// Activity facts — the timeline
export const activityFacts = pgTable(
  "activity_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    dealId: uuid("deal_id"),
    kind: text("kind").notNull(),
    refId: text("ref_id"),
    content: text("content"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actor: text("actor").notNull(),
    source: activitySourceEnum("source").default("manual").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_activity_customer: index("idx_activity_customer").on(t.customerId, t.occurredAt),
    idx_activity_deal: index("idx_activity_deal").on(t.dealId, t.occurredAt),
    idx_activity_ws_kind: index("idx_activity_ws_kind").on(t.workspaceId, t.kind, t.occurredAt),
  }),
);

// Merge records — for customer dedup
export const mergeRecords = pgTable(
  "merge_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    survivorId: uuid("survivor_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    mergedId: uuid("merged_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    fieldResolutions: jsonb("field_resolutions").default({}).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).defaultNow().notNull(),
    reversibleUntil: timestamp("reversible_until", { withTimezone: true }).notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (t) => ({
    idx_merge_survivor: index("idx_merge_survivor").on(t.survivorId),
    idx_merge_merged: index("idx_merge_merged").on(t.mergedId),
  }),
);

// Import batches — for CSV import undo
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdCustomerIds: jsonb("created_customer_ids").default([]).notNull(),
    duplicateCustomerIds: jsonb("duplicate_customer_ids").default([]).notNull(),
    summary: jsonb("summary").default({}).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    reversibleUntil: timestamp("reversible_until", { withTimezone: true }).notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (t) => ({
    idx_import_ws: index("idx_import_ws").on(t.workspaceId, t.importedAt),
  }),
);

// Deals — the pipeline
export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    valueMinor: bigint("value_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    expectedClose: timestamp("expected_close", { withTimezone: true }).notNull(),
    stageId: text("stage_id").default("new").notNull(),
    probability: numeric("probability"),
    source: text("source").default("manual").notNull(),
    owner: uuid("owner").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_deals_ws_stage: index("idx_deals_ws_stage").on(t.workspaceId, t.stageId),
    idx_deals_customer: index("idx_deals_customer").on(t.customerId),
    idx_deals_owner: index("idx_deals_owner").on(t.owner),
  }),
);

// Deal-invoice links — for the conversion loop
export const dealInvoiceLinks = pgTable(
  "deal_invoice_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    convertedAt: timestamp("converted_at", { withTimezone: true }).defaultNow().notNull(),
    convertedBy: uuid("converted_by").notNull(),
  },
  (t) => ({
    idx_deal_invoice_link: uniqueIndex("idx_deal_invoice_link").on(t.dealId, t.invoiceId),
  }),
);

// Expenses
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    merchant: text("merchant").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    category: text("category").notNull(),
    taxDeductible: boolean("tax_deductible").default(false).notNull(),
    taxRate: text("tax_rate"),
    receiptRef: text("receipt_ref"),
    recurringRuleId: uuid("recurring_rule_id"),
    recurringPeriodKey: text("recurring_period_key"),
    mileage: jsonb("mileage"),
    status: expenseStatusEnum("status").default("draft").notNull(),
    createdBy: uuid("created_by").notNull(),
    paidBy: text("paid_by").default("cash").notNull(),
    reimbursedAt: timestamp("reimbursed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_expenses_ws_profile: index("idx_expenses_ws_profile").on(t.workspaceId, t.profileId),
    idx_expenses_status: index("idx_expenses_status").on(t.workspaceId, t.status),
    idx_expenses_category: index("idx_expenses_category").on(t.workspaceId, t.category, t.date),
  }),
);

// Recurring expense rules
export const recurringExpenseRules = pgTable(
  "recurring_expense_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    merchant: text("merchant").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    category: text("category").notNull(),
    taxDeductible: boolean("tax_deductible").default(false).notNull(),
    taxRate: text("tax_rate"),
    frequency: text("frequency").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }),
    amountMode: text("amount_mode").default("fixed").notNull(),
    autoRecord: boolean("auto_record").default(false).notNull(),
    createdBy: uuid("created_by").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_recurring_rules_ws: index("idx_recurring_rules_ws").on(t.workspaceId, t.active),
  }),
);

// ───────────────────────────────────────────────
// Freelance marketplace tables — supa-board + escrow + work-packaging
// ───────────────────────────────────────────────

// Job status enum for freelance jobs
export const jobStatusEnum = pgEnum("job_status", ["captured", "proposing", "active", "delivered", "paid", "closed"]);

// Freelance jobs
export const freelanceJobs = pgTable(
  "freelance_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("supa"), // supa | external
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    discipline: text("discipline").notNull(),
    skills: jsonb("skills").default([]).notNull(),
    budgetMinor: bigint("budget_minor", { mode: "bigint" }).notNull(),
    budgetCurrency: text("budget_currency").notNull(),
    budgetType: text("budget_type").notNull().default("fixed"), // hourly | fixed
    deadline: timestamp("deadline", { withTimezone: true }),
    status: jobStatusEnum("status").default("captured").notNull(),
    clientRef: uuid("client_ref").notNull(),
    externalPlatform: text("external_platform"), // upwork | fiverr | direct | other
    externalUrl: text("external_url"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_freelance_jobs_ws: index("idx_freelance_jobs_ws").on(t.workspaceId, t.status),
    idx_freelance_jobs_client: index("idx_freelance_jobs_client").on(t.clientRef),
    idx_freelance_jobs_discipline: index("idx_freelance_jobs_discipline").on(t.discipline),
  }),
);

// Listings (public face of a supa-source job)
export const listingStatusEnum = pgEnum("listing_status", ["draft", "published", "closed"]);
export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => freelanceJobs.id, { onDelete: "cascade" }),
    status: listingStatusEnum("status").default("draft").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    budgetMinor: bigint("budget_minor", { mode: "bigint" }).notNull(),
    budgetCurrency: text("budget_currency").notNull(),
    budgetType: text("budget_type").notNull().default("fixed"),
    aiSummary: text("ai_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_listings_ws: index("idx_listings_ws").on(t.workspaceId, t.status),
    idx_listings_job: index("idx_listings_job").on(t.jobId),
  }),
);

// Applications
export const applicationStatusEnum = pgEnum("application_status", [
  "draft", "submitted", "shortlisted", "client_info_requested",
  "hired", "withdrawn", "rejected",
]);
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
    freelancerWsId: uuid("freelancer_ws_id").notNull(),
    coverLetter: text("cover_letter").notNull(),
    rateMinor: bigint("rate_minor", { mode: "bigint" }).notNull(),
    rateCurrency: text("rate_currency").notNull(),
    days: integer("days").notNull(),
    attachedWorkItemIds: jsonb("attached_work_item_ids").default([]).notNull(),
    proposalMeta: jsonb("proposal_meta").default({}).notNull(),
    status: applicationStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_applications_listing: index("idx_applications_listing").on(t.listingId, t.status),
    idx_applications_freelancer: index("idx_applications_freelancer").on(t.freelancerWsId, t.status),
    idx_applications_listing_freelancer: uniqueIndex("idx_applications_listing_freelancer").on(t.listingId, t.freelancerWsId),
  }),
);

// Contracts
export const contractStatusEnum = pgEnum("contract_status", ["draft", "active", "completed", "disputed", "cancelled"]);
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientWsId: uuid("client_ws_id").notNull(),
    freelancerWsId: uuid("freelancer_ws_id").notNull(),
    listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    jobId: uuid("job_id").notNull().references(() => freelanceJobs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    totalAmountMinor: bigint("total_amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    feeBps: integer("fee_bps").default(100).notNull(), // 1% default
    status: contractStatusEnum("status").default("draft").notNull(),
    autoReleaseDays: integer("auto_release_days"), // null = no auto-release
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_contracts_freelancer: index("idx_contracts_freelancer").on(t.freelancerWsId, t.status),
    idx_contracts_client: index("idx_contracts_client").on(t.clientWsId, t.status),
    idx_contracts_job: index("idx_contracts_job").on(t.jobId),
  }),
);

// Milestones
export const milestoneStatusEnum = pgEnum("milestone_status", [
  "pending", "active", "submitted", "changes_requested", "approved", "paid",
]);
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: milestoneStatusEnum("status").default("pending").notNull(),
    submissionNote: text("submission_note"),
    submissionAttachments: jsonb("submission_attachments").default([]),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    milestoneFactId: uuid("milestone_fact_id"), // FK to monetary_facts — the gate with teeth
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_milestones_contract: index("idx_milestones_contract").on(t.contractId, t.status),
  }),
);

// Reviews (double-blind, gated by completed-contract fact)
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    contractCompletedFactId: uuid("contract_completed_fact_id").notNull(), // FK gate — fake reviews are unrepresentable
    direction: text("direction").notNull(), // freelancer_to_client | client_to_freelancer
    reviewerWsId: uuid("reviewer_ws_id").notNull(),
    revieweeWsId: uuid("reviewee_ws_id").notNull(),
    rating: integer("rating").notNull(), // 1..5
    text: text("text"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    contractCompletedAt: timestamp("contract_completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_reviews_contract: index("idx_reviews_contract").on(t.contractId),
    idx_reviews_reviewer: index("idx_reviews_reviewer").on(t.reviewerWsId),
    idx_reviews_reviewee: index("idx_reviews_reviewee").on(t.revieweeWsId),
  }),
);

// Work samples (portfolio pieces)
export const sampleTierEnum = pgEnum("sample_tier", ["verified", "self_added"]);
export const workSamples = pgTable(
  "work_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    tier: sampleTierEnum("tier").notNull(),
    milestoneFactId: uuid("milestone_fact_id"), // nullable — required when tier=verified
    title: text("title").notNull(),
    narrative: text("narrative").notNull(),
    deliverableRefs: jsonb("deliverable_refs").default([]).notNull(),
    disciplines: jsonb("disciplines").default([]).notNull(),
    visibility: text("visibility").default("private").notNull(), // public | link_only | private
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_work_samples_ws: index("idx_work_samples_ws").on(t.workspaceId, t.visibility),
    idx_work_samples_milestone: index("idx_work_samples_milestone").on(t.milestoneFactId),
  }),
);

// Escrow ledger entries (append-only, double-entry)
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "escrow_funded", "escrow_released", "fee_collected",
  "payout_initiated", "payout_confirmed", "payout_failed",
  "refund_issued", "adjustment",
]);
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    type: ledgerEntryTypeEnum("type").notNull(),
    debitMinor: bigint("debit_minor", { mode: "bigint" }),
    debitCurrency: text("debit_currency"),
    creditMinor: bigint("credit_minor", { mode: "bigint" }),
    creditCurrency: text("credit_currency"),
    contraEntryId: uuid("contra_entry_id"),
    refType: text("ref_type").notNull(), // milestone | contract | case
    refId: uuid("ref_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_ledger_idempotency: uniqueIndex("idx_ledger_idempotency").on(t.idempotencyKey),
    idx_ledger_ws: index("idx_ledger_ws").on(t.workspaceId, t.type),
    idx_ledger_ref: index("idx_ledger_ref").on(t.refType, t.refId),
  }),
);

// Payouts
export const payoutStatusEnum = pgEnum("payout_status", ["in_transit", "confirmed", "failed"]);
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: payoutStatusEnum("status").default("in_transit").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    providerRef: text("provider_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_payouts_idempotency: uniqueIndex("idx_payouts_idempotency").on(t.idempotencyKey),
    idx_payouts_ws: index("idx_payouts_ws").on(t.workspaceId, t.status),
  }),
);

// ───────────────────────────────────────────────
// Agent infrastructure — agents, memory, runs, steps, approvals,
// budget entries, idempotency (migration 0026)
// ───────────────────────────────────────────────

// Enums
export const agentStatusEnum = pgEnum("agent_status_v2", ["draft", "active", "paused", "killed"]);
export const agentVisibilityEnum = pgEnum("agent_visibility", ["private", "shared"]);
export const memoryKindEnum = pgEnum("memory_kind", ["fact", "episode", "procedure", "preference"]);
export const memoryProvenanceEnum = pgEnum("memory_provenance", ["agent", "user", "template_seed"]);
export const runTriggerTypeEnum = pgEnum("run_trigger_type", ["manual", "schedule", "event", "webhook", "chain"]);
export const runStatusEnum = pgEnum("run_status_v2", ["queued", "running", "awaiting_approval", "done", "failed", "cancelled", "timeout", "approval_expired"]);
export const runStepKindEnum = pgEnum("run_step_kind", ["thought", "tool_call", "tool_result", "memory_read", "memory_write", "a2a", "error"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "rejected", "modified_approved", "expired", "cancelled"]);
export const budgetEntryKindEnum = pgEnum("budget_entry_kind", ["hold", "capture", "refund", "alert"]);

// Agents
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    persona: text("persona").notNull().default(""),
    goal: text("goal").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    toolGrants: text("tool_grants").array().notNull().default([]),
    approvalPolicy: jsonb("approval_policy").notNull().default({}),
    budget: jsonb("budget").notNull(),
    status: text("status").notNull().default("draft"),
    visibility: text("visibility").notNull().default("private"),
    locale: text("locale").notNull().default("en"),
    configVersion: integer("config_version").notNull().default(1),
    // migration 0027: concurrency cap (dispatcher Gate 3). Default 5.
    maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(5),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agents_ws_status: index("idx_agents_ws_status").on(t.workspaceId, t.status),
  }),
);

// Agent memory
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    redacted: boolean("redacted").notNull().default(false),
    provenance: text("provenance").notNull().default("agent"),
    confidence: numeric("confidence").notNull().default("0.5"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agent_memory_dedup: uniqueIndex("idx_agent_memory_dedup").on(t.agentId, t.kind, t.content),
    idx_agent_memory_agent_kind: index("idx_agent_memory_agent_kind").on(t.agentId, t.kind, t.expiresAt),
  }),
);

// Agent triggers — schedules, events, webhooks as first-class entities (migration 0027).
// Referenced by the dispatcher (Gate 2: triggers enabled?) + the kill switch
// (triggers-disable step, wired against this table).
export const agentTriggers = pgTable(
  "agent_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // manual | schedule | event | webhook
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agent_triggers_ws_agent_enabled: index("idx_agent_triggers_ws_agent_enabled").on(t.workspaceId, t.agentId, t.enabled),
    idx_agent_triggers_agent_kind_enabled: index("idx_agent_triggers_agent_kind_enabled").on(t.agentId, t.kind, t.enabled),
  }),
);

// Agent teams — the delegation graph (migration 0028).
// An edge (from_agent → to_agent, granted_tools[]) means from_agent delegates
// the ability to invoke those tools to to_agent. The executor's canInvoke
// checks grants ∩ grantor ∩ chain live per call; teamGraph renders the same
// intersection for the UI.
export const agentTeams = pgTable(
  "agent_teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    fromAgent: uuid("from_agent").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toAgent: uuid("to_agent").notNull().references(() => agents.id, { onDelete: "cascade" }),
    grantedTools: text("granted_tools").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agent_teams_ws: index("idx_agent_teams_ws").on(t.workspaceId),
    idx_agent_teams_from: index("idx_agent_teams_from").on(t.fromAgent),
    idx_agent_teams_to: index("idx_agent_teams_to").on(t.toAgent),
  }),
);

// Runs
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    triggerPayload: jsonb("trigger_payload").notNull().default({}),
    agentSnapshot: jsonb("agent_snapshot").notNull(),
    status: text("status").notNull().default("queued"),
    output: jsonb("output"),
    failureReason: text("failure_reason"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    usdMinor: integer("usd_minor").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(40),
    wallDeadline: timestamp("wall_deadline", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // migration 0027: 10-min dedup window for trigger fires (dispatcher idempotency).
    idempotencyKey: text("idempotency_key"),
    // migration 0027: a2a chain depth (carried from enqueueRun).
    chainDepth: integer("chain_depth").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    idx_runs_ws_agent: index("idx_runs_ws_agent").on(t.workspaceId, t.agentId, t.status, t.createdAt),
  }),
);

// Run steps
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    toolId: text("tool_id"),
    args: jsonb("args"),
    argsHash: text("args_hash"),
    resultRef: text("result_ref"),
    latencyMs: integer("latency_ms"),
    costTokens: integer("cost_tokens").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_run_steps_seq: uniqueIndex("idx_run_steps_seq").on(t.runId, t.seq),
  }),
);

// Approvals
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    toolId: text("tool_id").notNull(),
    args: jsonb("args").notNull(),
    contextSnapshot: jsonb("context_snapshot").notNull(),
    status: text("status").notNull().default("pending"),
    requestedByAgent: uuid("requested_by_agent").notNull().references(() => agents.id),
    decidedBy: uuid("decided_by"),
    decisionContext: jsonb("decision_context"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_approvals_ws_status: index("idx_approvals_ws_status").on(t.workspaceId, t.status, t.expiresAt),
  }),
);

// Budget entries
export const budgetEntries = pgTable(
  "budget_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    usdMinor: integer("usd_minor").notNull(),
    kind: text("kind").notNull(),
    periodDay: text("period_day").notNull(), // date as text for simplicity
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_budget_entries_agent: index("idx_budget_entries_agent").on(t.agentId, t.periodDay),
  }),
);

// Agent idempotency
export const agentIdempotency = pgTable(
  "agent_idempotency",
  {
    key: text("key").primaryKey(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    resultRef: text("result_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agent_idempotency_created: index("idx_agent_idempotency_created").on(t.createdAt),
  }),
);

// ───────────────────────────────────────────────
// Enterprise tenancy core (migration 0029).
// SSO, SCIM, API keys, hash-chained audit log, retention, webhooks.
// Every table carries ws_id + RLS (the tenancy rule).
// ───────────────────────────────────────────────

// Enterprise memberships (separate from workspace_members from 0001; carries SSO/SCIM/MFA state).
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),  // null until invite is accepted (invited by email).
    role: text("role").notNull().default("member"),
    customRoleId: uuid("custom_role_id"),
    status: text("status").notNull().default("active"),
    invitedBy: uuid("invited_by"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    invitedEmail: text("invited_email"),
    inviteToken: text("invite_token"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    suspendedBy: uuid("suspended_by"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"),
    seatId: uuid("seat_id"),
  },
  (t) => ({
    idx_memberships_user_status: index("idx_memberships_user_status").on(t.userId, t.status),
    idx_memberships_ws_status: index("idx_memberships_ws_status").on(t.wsId, t.status),
  }),
);

// Custom roles (Enterprise): named bundles of granular permissions.
export const customRoles = pgTable(
  "custom_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    perms: jsonb("perms").notNull(),
    builtin: boolean("builtin").notNull().default(false),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_custom_roles_ws: index("idx_custom_roles_ws").on(t.wsId),
  }),
);

// SSO configs — one per workspace (OIDC or SAML).
export const ssoConfigs = pgTable(
  "sso_configs",
  {
    wsId: uuid("ws_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    protocol: text("protocol").notNull(),
    provider: text("provider").notNull(),
    oidc: jsonb("oidc"),
    saml: jsonb("saml"),
    enforced: boolean("enforced").notNull().default(false),
    ownerBypass: boolean("owner_bypass").notNull().default(true),
    domainClaim: text("domain_claim"),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// SSO nonces — SAML replay defense.
export const ssoNonces = pgTable(
  "sso_nonces",
  {
    nonce: text("nonce").primaryKey(),
    wsId: uuid("ws_id").references(() => workspaces.id, { onDelete: "cascade" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_sso_nonces_consumed: index("idx_sso_nonces_consumed").on(t.consumedAt),
  }),
);

// SCIM tokens — bearer tokens for SCIM provisioning.
export const scimTokens = pgTable(
  "scim_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    idx_scim_tokens_ws_revoked: index("idx_scim_tokens_ws_revoked").on(t.wsId, t.revokedAt),
  }),
);

// SCIM groups — group → role mapping.
export const scimGroups = pgTable(
  "scim_groups",
  {
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    scimGroupId: text("scim_group_id").notNull(),
    displayName: text("display_name").notNull(),
    mappedRole: text("mapped_role"),
  },
);

// SCIM refs — maps IdP external IDs to local user IDs (migration 0030).
// The bridge between SCIM's externalId/id and memberships.user_id.
export const scimRefs = pgTable(
  "scim_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    scimExternalId: text("scim_external_id").notNull(),
    scimUserId: text("scim_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_scim_refs_ws_user: index("idx_scim_refs_ws_user").on(t.wsId, t.userId),
    idx_scim_refs_ws_external: index("idx_scim_refs_ws_external").on(t.wsId, t.scimExternalId),
    idx_scim_refs_ws_scim_user: index("idx_scim_refs_ws_scim_user").on(t.wsId, t.scimUserId),
  }),
);

// SCIM log — full request log for debugging + acceptance proof.
export const scimLog = pgTable(
  "scim_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    wsId: uuid("ws_id").references(() => workspaces.id, { onDelete: "cascade" }),
    op: text("op"),
    resource: text("resource"),
    requestId: text("request_id"),
    payload: jsonb("payload"),
    result: text("result"),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_scim_log_ws_ts: index("idx_scim_log_ws_ts").on(t.wsId, t.ts),
  }),
);

// API keys — workspace API keys (argon2id hashed, never reversible).
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: bytea("hash").notNull(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    rotatedFrom: uuid("rotated_from"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_api_keys_ws_revoked: index("idx_api_keys_ws_revoked").on(t.wsId, t.revokedAt),
    idx_api_keys_user: index("idx_api_keys_user").on(t.userId),
  }),
);

// Enterprise audit log — hash-chained, tamper-evident.
// Renamed from `audit_log` to avoid collision with migration 0011's audit_log.
export const enterpriseAuditLog = pgTable(
  "enterprise_audit_log",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    wsId: uuid("ws_id").references(() => workspaces.id, { onDelete: "cascade" }),
    id: uuid("id").notNull().defaultRandom(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    target: jsonb("target"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => ({
    idx_enterprise_audit_log_ws_ts_action: index("idx_enterprise_audit_log_ws_ts_action").on(t.wsId, t.ts, t.action),
  }),
);

// Retention policies — per-workspace data retention + legal hold.
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    wsId: uuid("ws_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    chatDays: integer("chat_days").default(365),
    workDays: integer("work_days").default(3650),
    auditDays: integer("audit_days").default(3650),
    legalHold: boolean("legal_hold").notNull().default(false),
    holdScope: jsonb("hold_scope"),
  },
);

// Webhook endpoints — per-workspace webhook targets.
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wsId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: bytea("secret").notNull(),
    events: text("events").array().notNull(),
    disabledUntil: timestamp("disabled_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_webhook_endpoints_ws: index("idx_webhook_endpoints_ws").on(t.wsId),
  }),
);

// Webhook deliveries — at-most-once per endpoint per event.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextRetry: timestamp("next_retry", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    responseCode: integer("response_code"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    idx_webhook_deliveries_status_retry: index("idx_webhook_deliveries_status_retry").on(t.status, t.nextRetry),
  }),
);

// Sessions — session security + device management (migration 0032).
// Refresh token rotation with reuse detection: a reused (rotated) refresh
// token nukes the entire family.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(), // web | mobile | sso
    ip: inet("ip"),
    userAgent: text("user_agent"),
    deviceHash: text("device_hash"),
    familyId: uuid("family_id").notNull().defaultRandom(),
    refreshTokenHash: text("refresh_token_hash"), // legacy (SHA-256) — kept for backward compat.
    tokenHash: text("token_hash"), // v2: argon2id of the refresh token.
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"), // v2: why the session was revoked.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // absolute cap: 30 days.
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull().defaultNow(), // v2: rolling 14-day idle.
    ssoOriginated: boolean("sso_originated").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deviceLabel: text("device_label"), // v2: human-readable device label.
    mfaSatisfied: boolean("mfa_satisfied").notNull().default(false), // v2: MFA was satisfied.
    rotatedTo: uuid("rotated_to"), // v2: the new session's id (reuse detection).
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_sessions_user_revoked: index("idx_sessions_user_revoked").on(t.userId, t.revokedAt),
    idx_sessions_user_kind_seen: index("idx_sessions_user_kind_seen").on(t.userId, t.kind, t.lastSeenAt),
    idx_sessions_family: index("idx_sessions_family").on(t.familyId),
  }),
);

// MFA recovery codes — 10 single-use, argon2id-hashed codes per user (migration 0038).
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    codeHash: text("code_hash").notNull().unique(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_mfa_recovery_codes_user: index("idx_mfa_recovery_codes_user").on(t.userId),
  }),
);

// Product-user TOTP factors (migration 0072); independent from admin MFA.
export const productMfaFactors = pgTable("product_mfa_factors", {
  userId: uuid("user_id").primaryKey(),
  totpSecretEncrypted: text("totp_secret_encrypted").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Files — file tree (dirs + files), content-hash dedup, soft delete (migration 0039).
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    isDir: boolean("is_dir").notNull().default(false),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    mime: text("mime"),
    contentHash: bytea("content_hash"),
    storageKey: text("storage_key"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idx_files_ws_parent: index("idx_files_ws_parent").on(t.workspaceId, t.parentId),
    idx_files_ws_deleted: index("idx_files_ws_deleted").on(t.workspaceId, t.deletedAt),
  }),
);

// File versions — version history (content-hash dedup).
export const fileVersions = pgTable(
  "file_versions",
  {
    fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentHash: bytea("content_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_file_versions_file_version: index("idx_file_versions_file_version").on(t.fileId, t.version),
  }),
);

// Webhooks v2 — HTTPS-only, admin-only RLS (migration 0040).
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: bytea("secret").notNull(),
    events: text("events").array().notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Webhook deliveries v2 — with ws_id for direct scoping (migration 0040).
export const webhookDeliveriesV2 = pgTable(
  "webhook_deliveries_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    attempt: integer("attempt").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Erased identities — view-level pseudonymization for GDPR erasure (migration 0041).
export const erasedIdentities = pgTable(
  "erased_identities",
  {
    oldId: uuid("old_id").primaryKey(),
    erasedAt: timestamp("erased_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// SSO connections v2 — SAML connection config linking IdP to one workspace (migration 0042).
export const ssoConnections = pgTable(
  "sso_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    idpEntityId: text("idp_entity_id").notNull(),
    idpSsoUrl: text("idp_sso_url").notNull(),
    idpCertPem: text("idp_cert_pem").notNull(),
    spEntityId: text("sp_entity_id").notNull(),
    idpInitiatedOk: boolean("idp_initiated_ok").notNull().default(false),
    enforceSso: boolean("enforce_sso").notNull().default(false),
    enforcedDomain: text("enforced_domain").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_sso_connections_ws: index("idx_sso_connections_ws").on(t.workspaceId),
  }),
);

// SCIM identities v2 — IdP user ↔ our user mapping, per connection (migration 0042).
export const scimIdentities = pgTable(
  "scim_identities",
  {
    scimUserId: text("scim_user_id").notNull(),
    ssoConnId: uuid("sso_conn_id").notNull().references(() => ssoConnections.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (t) => ({
    idx_scim_identities_ws: index("idx_scim_identities_ws").on(t.workspaceId),
    idx_scim_identities_user: index("idx_scim_identities_user").on(t.userId),
  }),
);

// Roles — custom roles as data (migration 0043).
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    permissions: text("permissions").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_roles_ws: index("idx_roles_ws").on(t.workspaceId),
  }),
);

// Share links v2 — token hashed, password argon2id, perm-scoped (migration 0044).
export const shareLinksV2 = pgTable(
  "share_links_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    passwordHash: text("password_hash"),
    perm: text("perm").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxViews: integer("max_views"),
    viewCount: integer("view_count").notNull().default(0),
    allowedEmail: text("allowed_email"),
    createdBy: uuid("created_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_share_links_ws_file: index("idx_share_links_ws_file").on(t.workspaceId, t.fileId),
  }),
);

// Share views v2 — view log for analytics + exhaustion tracking (migration 0044).
export const shareViewsV2 = pgTable(
  "share_views",
  {
    shareId: uuid("share_id").notNull().references(() => shareLinksV2.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
    ipHash: text("ip_hash").notNull(),
    ok: boolean("ok").notNull(),
  },
  (t) => ({
    idx_share_views_share: index("idx_share_views_share").on(t.shareId, t.viewedAt),
  }),
);

// Regions — data residency catalog (migration 0046).
// code PK, pg_dsn (per-region Supabase project), s3_bucket (per-region object storage).
// Seeded at deploy time; new regions require a migration. workspaces.region → regions(code) FK.
// Region is IMMUTABLE after workspace creation (forbid_region_change() trigger — defense-in-depth;
// RLS already blocks the UPDATE).
export const regions = pgTable(
  "regions",
  {
    code: text("code").primaryKey(),
    pgDsn: text("pg_dsn").notNull(),
    s3Bucket: text("s3_bucket").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Admin users — the control plane identity (migration 0047).
// Separate from product identity; links via FK to auth.users for authn only.
// Single source of truth for is_admin (no boolean on the product users table).
// global_system (not @tenant_table, not RLS'd — protected by its own authn).
export const adminUsers = pgTable(
  "admin_users",
  {
    userId: uuid("user_id").primaryKey(),
    role: text("role").notNull(),
    mfaSecret: text("mfa_secret"),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    hardwareKey: jsonb("hardware_key"),
    ipAllowlist: text("ip_allowlist").array(),
    invitedBy: uuid("invited_by"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    quarterlyReviewedAt: timestamp("quarterly_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Admin sessions — separate from product sessions (migration 0047).
// 8h hard cap, 30min sliding idle, MFA-gated, IP-bound, argon2id token hash.
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    ip: inet("ip").notNull(),
    userAgent: text("user_agent"),
    mfaOk: boolean("mfa_ok").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    idx_admin_sessions_admin: index("idx_admin_sessions_admin").on(t.adminId),
  }),
);

// Admin audit log — hash-chained, tamper-evident, insert-only (migration 0048).
// SEPARATE from enterprise_audit_log (the product audit). Records control-plane
// actions (admin invites, removals, role changes, MFA resets, session revocations,
// sensitive reads). Indefinite retention. justification required for sensitive ops.
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    seq: bigint("seq", { mode: "number" }), // bigserial — monotonic (gaps OK).
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    target: jsonb("target"),
    justification: text("justification"),
    diff: jsonb("diff"), // { old, new } for mutations.
    ip: inet("ip"),
    userAgent: text("user_agent"),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => ({
    idx_admin_audit_log_seq: index("idx_admin_audit_log_seq").on(t.seq),
    idx_admin_audit_log_actor: index("idx_admin_audit_log_actor").on(t.actorId, t.ts),
    idx_admin_audit_log_action_ts: index("idx_admin_audit_log_action_ts").on(t.action, t.ts),
  }),
);

// Feature flags — global control plane (migration 0049).
// global_system (not @tenant_table, not RLS'd). Single source of truth for
// feature toggles + kill switches. App reads (supa_app), admin writes (supa_system).
export const featureFlags = pgTable(
  "feature_flags",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull().default("feature"),
    enabled: boolean("enabled").notNull().default(false),
    rolloutPct: integer("rollout_pct").notNull().default(0),
    targets: jsonb("targets").notNull().default({}),
    description: text("description").notNull(),
    owner: text("owner").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_feature_flags_kill_switches: index("idx_feature_flags_kill_switches").on(t.key),
  }),
);

// Admin confirmations — 2nd-admin approval for kill_switch flips (migration 0050).
export const adminConfirmations = pgTable(
  "admin_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionType: text("action_type").notNull(),
    targetKey: text("target_key").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    approverId: uuid("approver_id"),
    patch: jsonb("patch").notNull(),
    phrase: text("phrase").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    idx_admin_confirmations_status_expires: index("idx_admin_confirmations_status_expires").on(t.status, t.expiresAt),
    idx_admin_confirmations_target: index("idx_admin_confirmations_target").on(t.actionType, t.targetKey),
  }),
);

// SLO definitions — the SLO contracts per service (migration 0051).
export const sloDefinitions = pgTable(
  "slo_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service: text("service").notNull(),
    sloName: text("slo_name").notNull(),
    description: text("description").notNull(),
    target: numeric("target").notNull(),
    targetUnit: text("target_unit").notNull(),
    windowDays: integer("window_days").notNull().default(30),
    alertThreshold: numeric("alert_threshold").notNull().default("0.5"),
    owner: text("owner").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_slo_definitions_service_name: index("idx_slo_definitions_service_name").on(t.service, t.sloName),
  }),
);

// SLO snapshots — periodic SLI vs SLO measurements (migration 0051).
export const sloSnapshots = pgTable(
  "slo_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sloId: uuid("slo_id").notNull().references(() => sloDefinitions.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).defaultNow().notNull(),
    sliValue: numeric("sli_value").notNull(),
    sliUnit: text("sli_unit").notNull(),
    errorBudgetRemaining: numeric("error_budget_remaining").notNull(),
    errorBudgetConsumed: numeric("error_budget_consumed").notNull(),
    sampleCount: integer("sample_count").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => ({
    idx_slo_snapshots_slo_time: index("idx_slo_snapshots_slo_time").on(t.sloId, t.snapshotAt),
    idx_slo_snapshots_time: index("idx_slo_snapshots_time").on(t.snapshotAt),
  }),
);

// Cost ledger — append-only cost events (migration 0051).
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    workspaceId: uuid("ws_id"),
    userId: uuid("user_id"),
    feature: text("feature").notNull(),
    provider: text("provider"),
    costUsd: numeric("cost_usd").notNull(),
    quantity: numeric("quantity"),
    quantityUnit: text("quantity_unit"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => ({
    idx_cost_ledger_ts: index("idx_cost_ledger_ts").on(t.ts),
    idx_cost_ledger_ws_feature: index("idx_cost_ledger_ws_feature").on(t.workspaceId, t.feature, t.ts),
    idx_cost_ledger_feature_ts: index("idx_cost_ledger_feature_ts").on(t.feature, t.ts),
  }),
);

// Locales — the locale registry (migration 0052).
export const locales = pgTable(
  "locales",
  {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    englishLabel: text("english_label").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull().default("planned"),
    reviewerId: uuid("reviewer_id"),
    completenessPct: numeric("completeness_pct").notNull().default("0"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Translation memory — reused translations (migration 0052).
export const translationMemory = pgTable(
  "translation_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceText: text("source_text").notNull(),
    sourceLocale: text("source_locale").notNull(),
    targetText: text("target_text").notNull(),
    targetLocale: text("target_locale").notNull(),
    matchType: text("match_type").notNull(),
    sourceContext: text("source_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_tm_source: index("idx_tm_source").on(t.sourceLocale, t.sourceText),
    idx_tm_target: index("idx_tm_target").on(t.targetLocale, t.targetText),
  }),
);

// Glossary — brand/legal/technical terms (migration 0052).
export const glossary = pgTable(
  "glossary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    term: text("term").notNull().unique(),
    category: text("category").notNull(),
    doNotTranslate: boolean("do_not_translate").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Glossary translations — per-locale approved translations (migration 0052).
export const glossaryTranslations = pgTable(
  "glossary_translations",
  {
    glossaryId: uuid("glossary_id").notNull(),
    locale: text("locale").notNull(),
    translation: text("translation").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => ({
    idx_glossary_translations_locale: index("idx_glossary_translations_locale").on(t.glossaryId, t.locale),
  }),
);

// Blog posts — localized blog articles (migration 0053).
export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("draft"),
    tags: text("tags").array().notNull().default([]),
    coverImage: text("cover_image"),
    canonicalUrl: text("canonical_url"),
    noindex: boolean("noindex").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_blog_posts_locale_status: index("idx_blog_posts_locale_status").on(t.locale, t.status, t.publishedAt),
  }),
);

// Help articles — help center (migration 0053).
export const helpArticles = pgTable(
  "help_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("draft"),
    views: integer("views").notNull().default(0),
    helpfulYes: integer("helpful_yes").notNull().default(0),
    helpfulNo: integer("helpful_no").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_help_articles_category_locale: index("idx_help_articles_category_locale").on(t.category, t.locale, t.status, t.sortOrder),
  }),
);

// Changelog entries — public changelog (migration 0053).
export const changelogEntries = pgTable(
  "changelog_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    version: text("version"),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    tags: text("tags").array().notNull().default([]),
    status: text("status").notNull().default("published"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_changelog_locale_published: index("idx_changelog_locale_published").on(t.locale, t.status, t.publishedAt),
  }),
);

// Legal documents — legal docs with versioning (migration 0053).
export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docType: text("doc_type").notNull(),
    jurisdiction: text("jurisdiction").notNull().default("global"),
    title: text("title").notNull(),
    description: text("description"),
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_legal_documents_type_jurisdiction: index("idx_legal_documents_type_jurisdiction").on(t.docType, t.jurisdiction),
  }),
);

// Legal versions — append-only version history (migration 0053).
export const legalVersions = pgTable(
  "legal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    version: text("version").notNull(),
    locale: text("locale").notNull(),
    body: text("body").notNull(),
    changelog: text("changelog"),
    status: text("status").notNull(),
    effectiveDate: timestamp("effective_date", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_legal_versions_doc: index("idx_legal_versions_doc").on(t.documentId, t.locale, t.status),
  }),
);

// Legal review — review workflow for new jurisdictions (migration 0053).
export const legalReview = pgTable(
  "legal_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    reviewerId: uuid("reviewer_id"),
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
);

// Backlinks — tracked backlinks (migration 0053).
export const backlinks = pgTable(
  "backlinks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    anchorText: text("anchor_text"),
    domainAuthority: numeric("domain_authority"),
    follow: boolean("follow").notNull().default(true),
    firstSeen: timestamp("first_seen", { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_backlinks_target: index("idx_backlinks_target").on(t.targetUrl),
    idx_backlinks_status: index("idx_backlinks_status").on(t.status, t.lastSeen),
  }),
);

// Rank tracking — keyword positions per locale (migration 0053).
export const rankTracking = pgTable(
  "rank_tracking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyword: text("keyword").notNull(),
    locale: text("locale").notNull(),
    url: text("url").notNull(),
    position: integer("position").notNull(),
    previousPosition: integer("previous_position"),
    searchVolume: integer("search_volume"),
    trackedAt: timestamp("tracked_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_rank_tracking_keyword: index("idx_rank_tracking_keyword").on(t.keyword, t.locale, t.trackedAt),
  }),
);

// Support tickets — with SLA tracking (migration 0054).
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id"),
    userId: uuid("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    userLocale: text("user_locale").notNull(),
    userPlan: text("user_plan").notNull().default("free"),
    userRegion: text("user_region"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    category: text("category"),
    severity: text("severity").notNull().default("normal"),
    status: text("status").notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    assignedTo: uuid("assigned_to"),
    slaDeadline: timestamp("sla_deadline", { withTimezone: true }).notNull(),
    slaBreached: boolean("sla_breached").notNull().default(false),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    triageResult: jsonb("triage_result"),
    csatScore: integer("csat_score"),
    csatAt: timestamp("csat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_support_tickets_status_priority: index("idx_support_tickets_status_priority").on(t.status, t.priority, t.createdAt),
    idx_support_tickets_sla: index("idx_support_tickets_sla").on(t.slaDeadline),
    idx_support_tickets_user: index("idx_support_tickets_user").on(t.userId, t.createdAt),
  }),
);

// Support macros — localized pre-written responses (migration 0054).
export const supportMacros = pgTable(
  "support_macros",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    active: boolean("active").notNull().default(true),
    usageCount: integer("usage_count").notNull().default(0),
    helpfulYes: integer("helpful_yes").notNull().default(0),
    helpfulNo: integer("helpful_no").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_support_macros_category_locale: index("idx_support_macros_category_locale").on(t.category, t.locale, t.active),
  }),
);

// CSAT surveys (migration 0054).
export const csatSurveys = pgTable(
  "csat_surveys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull(),
    userId: uuid("user_id").notNull(),
    score: integer("score").notNull(),
    comment: text("comment"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_csat_surveys_submitted: index("idx_csat_surveys_submitted").on(t.submittedAt),
  }),
);

// Regional config — per-region playbook template (migration 0054).
export const regionalConfig = pgTable(
  "regional_config",
  {
    regionCode: text("region_code").primaryKey(),
    displayName: text("display_name").notNull(),
    defaultLocale: text("default_locale").notNull(),
    defaultCurrency: text("default_currency").notNull(),
    defaultTimezone: text("default_timezone").notNull(),
    taxRule: text("tax_rule").notNull().default("standard"),
    taxRate: numeric("tax_rate").notNull().default("0"),
    legalJurisdiction: text("legal_jurisdiction").notNull().default("global"),
    supportHours: jsonb("support_hours").notNull().default({}),
    supportLanguages: text("support_languages").array().notNull().default([]),
    paymentMethods: text("payment_methods").array().notNull().default([]),
    dataResidency: text("data_residency").notNull().default("us-east"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Regional pricing — PPP (migration 0054).
export const regionalPricing = pgTable(
  "regional_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regionCode: text("region_code").notNull(),
    plan: text("plan").notNull(),
    priceUsd: numeric("price_usd").notNull(),
    localCurrency: text("local_currency").notNull(),
    localPrice: numeric("local_price").notNull(),
    pppFactor: numeric("ppp_factor").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_regional_pricing_region_plan: index("idx_regional_pricing_region_plan").on(t.regionCode, t.plan),
  }),
);

// Expansion tasks — onboarding pipeline tracker (migration 0055).
export const expansionTasks = pgTable(
  "expansion_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull().default("prioritized"),
    thresholdMet: boolean("threshold_met").notNull().default(false),
    usageThreshold: numeric("usage_threshold"),
    currentUsage: numeric("current_usage"),
    assignedTo: uuid("assigned_to"),
    checklist: jsonb("checklist").notNull().default({}),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    idx_expansion_tasks_status: index("idx_expansion_tasks_status").on(t.status, t.kind),
  }),
);

// PII redaction log — support data access audit trail (migration 0055).
export const piiRedactionLog = pgTable(
  "pii_redaction_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull(),
    accessedBy: uuid("accessed_by").notNull(),
    accessType: text("access_type").notNull(),
    fieldsAccessed: text("fields_accessed").array().notNull().default([]),
    justification: text("justification").notNull(),
    ip: inet("ip").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_pii_redaction_ticket: index("idx_pii_redaction_ticket").on(t.ticketId, t.createdAt),
    idx_pii_redaction_agent: index("idx_pii_redaction_agent").on(t.accessedBy, t.createdAt),
  }),
);

// Cookie consent — per-jurisdiction (migration 0055).
export const cookieConsent = pgTable(
  "cookie_consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id"),
    sessionId: text("session_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    consentGiven: boolean("consent_given").notNull().default(false),
    consentCategories: text("consent_categories").array().notNull().default([]),
    consentVersion: text("consent_version").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => ({
    idx_cookie_consent_session: index("idx_cookie_consent_session").on(t.sessionId),
  }),
);

// Automated reports — weekly/monthly/quarterly (migration 0056).
export const automatedReports = pgTable(
  "automated_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    period: text("period").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    reportData: jsonb("report_data").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    distributed: boolean("distributed").notNull().default(false),
    distributedAt: timestamp("distributed_at", { withTimezone: true }),
    distributedTo: text("distributed_to").array(),
  },
  (t) => ({
    idx_automated_reports_period: index("idx_automated_reports_period").on(t.period, t.periodStart),
  }),
);

// Anomaly alerts (migration 0056).
export const anomalyAlerts = pgTable(
  "anomaly_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: text("category").notNull(),
    metric: text("metric").notNull(),
    severity: text("severity").notNull(),
    expectedValue: numeric("expected_value"),
    actualValue: numeric("actual_value"),
    deviationPct: numeric("deviation_pct"),
    detail: text("detail").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolution: text("resolution"),
  },
  (t) => ({
    idx_anomaly_alerts_unresolved: index("idx_anomaly_alerts_unresolved").on(t.severity, t.detectedAt),
    idx_anomaly_alerts_category: index("idx_anomaly_alerts_category").on(t.category, t.detectedAt),
  }),
);

// Risk registry (migration 0056).
export const riskRegistry = pgTable(
  "risk_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    riskId: text("risk_id").notNull().unique(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    mitigation: text("mitigation").notNull(),
    mitigationStatus: text("mitigation_status").notNull(),
    owner: text("owner").notNull(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_risk_registry_category: index("idx_risk_registry_category").on(t.category),
    idx_risk_registry_status: index("idx_risk_registry_status").on(t.mitigationStatus),
  }),
);

// Tool registry — every capability is a typed tool (migration 0057).
export const toolRegistry = pgTable(
  "tool_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    inputSchema: jsonb("input_schema").notNull().default({}),
    outputSchema: jsonb("output_schema").notNull().default({}),
    version: text("version").notNull().default("1.0.0"),
    status: text("status").notNull().default("active"),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    billable: boolean("billable").notNull().default(false),
    pricePerCallUsd: numeric("price_per_call_usd").default("0"),
    rateLimitPerMin: integer("rate_limit_per_min"),
    autoRegistered: boolean("auto_registered").notNull().default(false),
    owner: text("owner").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_tool_registry_category: index("idx_tool_registry_category").on(t.category, t.status),
  }),
);

// Marketplace items — self-governing (migration 0057).
export const marketplaceItems = pgTable(
  "marketplace_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    authorOrgId: uuid("author_org_id"),
    authorName: text("author_name").notNull(),
    version: text("version").notNull().default("1.0.0"),
    status: text("status").notNull().default("draft"),
    reviewType: text("review_type").notNull(),
    reviewResult: jsonb("review_result"),
    ratingAvg: numeric("rating_avg").notNull().default("0"),
    ratingCount: integer("rating_count").notNull().default(0),
    installCount: integer("install_count").notNull().default(0),
    revenueSharePct: numeric("revenue_share_pct").notNull().default("70"),
    manifest: jsonb("manifest").notNull().default({}),
    tags: text("tags").array().notNull().default([]),
    takedownReason: text("takedown_reason"),
    takedownAt: timestamp("takedown_at", { withTimezone: true }),
    takedownBy: text("takedown_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => ({
    idx_marketplace_kind_status: index("idx_marketplace_kind_status").on(t.kind, t.status),
    idx_marketplace_author: index("idx_marketplace_author").on(t.authorOrgId),
  }),
);

// Developer orgs (migration 0057).
export const developerOrgs = pgTable(
  "developer_orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    ownerUserId: uuid("owner_user_id").notNull(),
    reputationScore: numeric("reputation_score").notNull().default("50"),
    verified: boolean("verified").notNull().default(false),
    totalRevenueUsd: numeric("total_revenue_usd").notNull().default("0"),
    payoutMethod: text("payout_method"),
    payoutAddress: text("payout_address"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Vertical editions (migration 0057).
export const verticalEditions = pgTable(
  "vertical_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    template: jsonb("template").notNull().default({}),
    status: text("status").notNull().default("template"),
    assembledAt: timestamp("assembled_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    complianceRules: jsonb("compliance_rules").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// Enterprise deployments (migration 0057).
export const enterpriseDeployments = pgTable(
  "enterprise_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("ws_id").notNull(),
    deploymentType: text("deployment_type").notNull(),
    region: text("region").notNull(),
    capacityTier: text("capacity_tier").notNull(),
    customDomain: text("custom_domain"),
    status: text("status").notNull().default("pending"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    lastUpgradeAt: timestamp("last_upgrade_at", { withTimezone: true }),
    infraConfig: jsonb("infra_config").notNull().default({}),
    upgradeSafetyGates: jsonb("upgrade_safety_gates").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_enterprise_deployments_ws: index("idx_enterprise_deployments_ws").on(t.workspaceId, t.status),
  }),
);

// Policy rules — policy as code (migration 0057).
export const policyRules = pgTable(
  "policy_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    rule: jsonb("rule").notNull(),
    version: text("version").notNull().default("1.0.0"),
    status: text("status").notNull().default("active"),
    scope: text("scope").notNull().default("global"),
    scopeFilter: jsonb("scope_filter").notNull().default({}),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_policy_rules_category_status: index("idx_policy_rules_category_status").on(t.category, t.status, t.priority),
  }),
);

// Connectors — declarative connector specs (migration 0058).
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    icon: text("icon"),
    category: text("category").notNull(),
    authType: text("auth_type").notNull(),
    authConfig: jsonb("auth_config").notNull().default({}),
    actions: jsonb("actions").notNull().default([]),
    triggers: jsonb("triggers").notNull().default([]),
    rateLimitPerMin: integer("rate_limit_per_min").default(60),
    errorMapping: jsonb("error_mapping").notNull().default({}),
    webhookConfig: jsonb("webhook_config"),
    isOfficial: boolean("is_official").notNull().default(false),
    publisherOrgId: uuid("publisher_org_id"),
    publisherName: text("publisher_name").notNull().default("Supa AI"),
    status: text("status").notNull().default("active"),
    currentVersion: text("current_version").notNull().default("1.0.0"),
    autoPublished: boolean("auto_published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_connectors_category: index("idx_connectors_category").on(t.category, t.status),
  }),
);

// Connector versions (migration 0058).
export const connectorVersions = pgTable(
  "connector_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id").notNull(),
    version: text("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    changelog: text("changelog"),
    status: text("status").notNull().default("active"),
    testResults: jsonb("test_results").notNull().default({}),
    autoPublished: boolean("auto_published").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_connector_versions_connector: index("idx_connector_versions_connector").on(t.connectorId, t.version),
  }),
);

// Tool fixtures — test suites (migration 0058).
export const toolFixtures = pgTable(
  "tool_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolKey: text("tool_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    input: jsonb("input").notNull(),
    expectedOutput: jsonb("expected_output"),
    tags: text("tags").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_tool_fixtures_tool: index("idx_tool_fixtures_tool").on(t.toolKey),
  }),
);

// Tool usage stats — analytics (migration 0058).
export const toolUsageStats = pgTable(
  "tool_usage_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolKey: text("tool_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    totalCalls: integer("total_calls").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    avgLatencyMs: numeric("avg_latency_ms"),
    p95LatencyMs: numeric("p95_latency_ms"),
    totalCostUsd: numeric("total_cost_usd").notNull().default("0"),
    uniqueCallers: integer("unique_callers").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_tool_usage_stats_tool: index("idx_tool_usage_stats_tool").on(t.toolKey, t.periodStart),
  }),
);

// Agent quality scores (migration 0058).
export const agentQualityScores = pgTable(
  "agent_quality_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketplaceItemId: uuid("marketplace_item_id").notNull(),
    reliabilityScore: numeric("reliability_score").notNull().default("0"),
    safetyScore: numeric("safety_score").notNull().default("0"),
    usefulnessScore: numeric("usefulness_score").notNull().default("0"),
    overallScore: numeric("overall_score").notNull().default("0"),
    testResults: jsonb("test_results").notNull().default({}),
    scoredAt: timestamp("scored_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_agent_quality_item: index("idx_agent_quality_item").on(t.marketplaceItemId, t.scoredAt),
  }),
);

// Template items — design/prompt/workflow/business templates (migration 0059).
export const templateItems = pgTable(
  "template_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    authorOrgId: uuid("author_org_id"),
    authorName: text("author_name").notNull(),
    version: text("version").notNull().default("1.0.0"),
    status: text("status").notNull().default("draft"),
    schemaValidated: boolean("schema_validated").notNull().default(false),
    renderTested: boolean("render_tested").notNull().default(false),
    safetyReviewed: boolean("safety_reviewed").notNull().default(false),
    autoCategory: text("auto_category"),
    industryTags: text("industry_tags").array().notNull().default([]),
    useCaseTags: text("use_case_tags").array().notNull().default([]),
    ratingAvg: numeric("rating_avg").notNull().default("0"),
    ratingCount: integer("rating_count").notNull().default(0),
    installCount: integer("install_count").notNull().default(0),
    revenueSharePct: numeric("revenue_share_pct").notNull().default("70"),
    isPremium: boolean("is_premium").notNull().default(false),
    priceUsd: numeric("price_usd").notNull().default("0"),
    content: jsonb("content").notNull().default({}),
    previewImage: text("preview_image"),
    takedownReason: text("takedown_reason"),
    takedownAt: timestamp("takedown_at", { withTimezone: true }),
    takedownBy: text("takedown_by"),
    featuredScore: numeric("featured_score").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => ({
    idx_template_items_kind_status: index("idx_template_items_kind_status").on(t.kind, t.status),
    idx_template_items_featured: index("idx_template_items_featured").on(t.featuredScore),
  }),
);

// Sandbox workspaces — isolated developer sandboxes (migration 0059).
export const sandboxWorkspaces = pgTable(
  "sandbox_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    developerOrgId: uuid("developer_org_id").notNull(),
    workspaceId: uuid("ws_id"),
    name: text("name").notNull(),
    apiKeyHash: text("api_key_hash").notNull(),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(100),
    monthlyBudgetUsd: numeric("monthly_budget_usd").notNull().default("10.0"),
    maxTools: integer("max_tools").notNull().default(50),
    maxAgents: integer("max_agents").notNull().default(10),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    convertedToPaidAt: timestamp("converted_to_paid_at", { withTimezone: true }),
    totalApiCalls: integer("total_api_calls").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_sandbox_workspaces_org: index("idx_sandbox_workspaces_org").on(t.developerOrgId, t.status),
  }),
);

// Embedded surfaces — white-label (migration 0059).
export const embeddedSurfaces = pgTable(
  "embedded_surfaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerOrgId: uuid("partner_org_id").notNull(),
    surfaceType: text("surface_type").notNull(),
    brandName: text("brand_name").notNull(),
    brandLogoUrl: text("brand_logo_url"),
    brandColors: jsonb("brand_colors").notNull().default({}),
    customDomain: text("custom_domain"),
    allowedOrigins: text("allowed_origins").array().notNull().default([]),
    embedMethod: text("embed_method").notNull().default("iframe"),
    versionPinned: text("version_pinned").notNull().default("latest"),
    autoUpdate: boolean("auto_update").notNull().default(false),
    revenueModel: text("revenue_model").notNull(),
    revenueConfig: jsonb("revenue_config").notNull().default({}),
    verified: boolean("verified").notNull().default(false),
    totalEmbeds: integer("total_embeds").notNull().default(0),
    totalRevenueUsd: numeric("total_revenue_usd").notNull().default("0"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_embedded_surfaces_partner: index("idx_embedded_surfaces_partner").on(t.partnerOrgId, t.status),
  }),
);

// Partner integrations — bidirectional (migration 0059).
export const partnerIntegrations = pgTable(
  "partner_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorKey: text("connector_key").notNull(),
    workspaceId: uuid("ws_id").notNull(),
    direction: text("direction").notNull(),
    oauthProvider: text("oauth_provider").notNull().default("nango"),
    oauthConnectionId: text("oauth_connection_id"),
    requestedScopes: text("requested_scopes").array().notNull().default([]),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    circuitOpen: boolean("circuit_open").notNull().default(false),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    totalCalls: integer("total_calls").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    avgLatencyMs: numeric("avg_latency_ms"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_partner_integrations_ws: index("idx_partner_integrations_ws").on(t.workspaceId, t.status),
    idx_partner_integrations_connector: index("idx_partner_integrations_connector").on(t.connectorKey, t.status),
  }),
);

// Partner tokens — encrypted OAuth tokens (migration 0059).
export const partnerTokens = pgTable(
  "partner_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idx_partner_tokens_integration: index("idx_partner_tokens_integration").on(t.integrationId),
  }),
);

// Regional playbooks (migration 0060).
export const regionalPlaybooks = pgTable("regional_playbooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  regionCode: text("region_code").notNull().unique(),
  displayName: text("display_name").notNull(),
  languages: text("languages").array().notNull().default([]),
  currencies: text("currencies").array().notNull().default([]),
  paymentMethods: text("payment_methods").array().notNull().default([]),
  taxRules: jsonb("tax_rules").notNull().default({}),
  complianceRules: jsonb("compliance_rules").notNull().default({}),
  infraConfig: jsonb("infra_config").notNull().default({}),
  contentConfig: jsonb("content_config").notNull().default({}),
  supportConfig: jsonb("support_config").notNull().default({}),
  status: text("status").notNull().default("template"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  usageThreshold: integer("usage_threshold").notNull().default(1000),
  currentUsage: integer("current_usage").notNull().default(0),
  thresholdMet: boolean("threshold_met").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_regional_playbooks_status: index("idx_regional_playbooks_status").on(t.status),
  }));

// Vertical configs (migration 0060).
export const verticalConfigs = pgTable("vertical_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  promptIds: text("prompt_ids").array().notNull().default([]),
  agentTemplates: jsonb("agent_templates").notNull().default([]),
  connectorKeys: text("connector_keys").array().notNull().default([]),
  templateSlugs: text("template_slugs").array().notNull().default([]),
  complianceRules: jsonb("compliance_rules").notNull().default({}),
  pricingConfig: jsonb("pricing_config").notNull().default({}),
  marketingConfig: jsonb("marketing_config").notNull().default({}),
  status: text("status").notNull().default("draft"),
  qaResults: jsonb("qa_results"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  totalWorkspaces: integer("total_workspaces").notNull().default(0),
  totalRevenueUsd: numeric("total_revenue_usd").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_vertical_configs_status: index("idx_vertical_configs_status").on(t.status),
  }));

// Enterprise licenses (migration 0060).
export const enterpriseLicenses = pgTable("enterprise_licenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  licenseKeyHash: text("license_key_hash").notNull().unique(),
  workspaceId: uuid("ws_id").notNull(),
  deploymentId: uuid("deployment_id"),
  edition: text("edition").notNull(),
  maxSeats: integer("max_seats").notNull().default(50),
  maxApiCallsPerDay: integer("max_api_calls_per_day").notNull().default(100000),
  features: text("features").array().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_enterprise_licenses_ws: index("idx_enterprise_licenses_ws").on(t.workspaceId, t.status),
  }));

// Enterprise SLAs (migration 0060).
export const enterpriseSlas = pgTable("enterprise_slas", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("ws_id").notNull(),
  uptimeTarget: numeric("uptime_target").notNull().default("0.9999"),
  responseTimeP95Ms: integer("response_time_p95_ms").notNull().default(300),
  supportResponseTimeHrs: integer("support_response_time_hrs").notNull().default(1),
  resolutionTimeHrs: integer("resolution_time_hrs").notNull().default(4),
  currentUptime: numeric("current_uptime").notNull().default("1.0"),
  currentP95Ms: integer("current_p95_ms"),
  lastIncidentAt: timestamp("last_incident_at", { withTimezone: true }),
  creditPolicy: jsonb("credit_policy").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_enterprise_slas_ws: index("idx_enterprise_slas_ws").on(t.workspaceId),
  }));

// Compliance evidence (migration 0060).
export const complianceEvidence = pgTable("compliance_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("ws_id"),
  framework: text("framework").notNull(),
  controlId: text("control_id").notNull(),
  evidenceType: text("evidence_type").notNull(),
  evidenceData: jsonb("evidence_data").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true }).defaultNow().notNull(),
  collectedBy: text("collected_by").notNull().default("system"),
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => ({
    idx_compliance_evidence_ws: index("idx_compliance_evidence_ws").on(t.workspaceId, t.framework),
    idx_compliance_evidence_framework: index("idx_compliance_evidence_framework").on(t.framework, t.controlId),
  }));

// Policy versions (migration 0061).
export const policyVersions = pgTable("policy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyKey: text("policy_key").notNull(),
  version: text("version").notNull(),
  ruleSnapshot: jsonb("rule_snapshot").notNull(),
  changelog: text("changelog"),
  committedBy: text("committed_by").notNull().default("system"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  status: text("status").notNull().default("committed"),
  simulationResults: jsonb("simulation_results"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_policy_versions_key: index("idx_policy_versions_key").on(t.policyKey, t.version),
  }));

// Policy evaluations (migration 0061).
export const policyEvaluations = pgTable("policy_evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyKey: text("policy_key"),
  category: text("category").notNull(),
  context: jsonb("context").notNull(),
  action: jsonb("action"),
  matched: boolean("matched").notNull().default(false),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  workspaceId: uuid("ws_id"),
  toolKey: text("tool_key"),
}, (t) => ({
    idx_policy_evaluations_time: index("idx_policy_evaluations_time").on(t.evaluatedAt),
    idx_policy_evaluations_category: index("idx_policy_evaluations_category").on(t.category, t.evaluatedAt),
  }));

// Governance actions (migration 0061).
export const governanceActions = pgTable("governance_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain").notNull(),
  actionType: text("action_type").notNull(),
  targetId: text("target_id").notNull(),
  targetType: text("target_type").notNull(),
  reason: text("reason").notNull(),
  automated: boolean("automated").notNull().default(true),
  reviewerId: uuid("reviewer_id"),
  status: text("status").notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({
    idx_governance_actions_domain: index("idx_governance_actions_domain").on(t.domain, t.status),
    idx_governance_actions_target: index("idx_governance_actions_target").on(t.targetType, t.targetId),
  }));

// Billing events (migration 0061).
export const billingEvents = pgTable("billing_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("ws_id"),
  userId: uuid("user_id"),
  feature: text("feature").notNull(),
  refKey: text("ref_key"),
  quantity: numeric("quantity").notNull().default("1"),
  unit: text("unit").notNull().default("call"),
  costUsd: numeric("cost_usd").notNull(),
  localCurrency: text("local_currency"),
  localCost: numeric("local_cost"),
  taxRate: numeric("tax_rate").default("0"),
  taxAmount: numeric("tax_amount").default("0"),
  totalWithTax: numeric("total_with_tax").default("0"),
  region: text("region"),
  metadata: jsonb("metadata").notNull().default({}),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_billing_events_ts: index("idx_billing_events_ts").on(t.ts),
    idx_billing_events_ws_feature: index("idx_billing_events_ws_feature").on(t.workspaceId, t.feature, t.ts),
    idx_billing_events_feature: index("idx_billing_events_feature").on(t.feature, t.ts),
  }));

// Scaling events (migration 0061).
export const scalingEvents = pgTable("scaling_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionType: text("action_type").notNull(),
  target: text("target").notNull(),
  reason: text("reason").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  costImpactUsd: numeric("cost_impact_usd"),
  automated: boolean("automated").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_scaling_events_type: index("idx_scaling_events_type").on(t.actionType, t.createdAt),
  }));

// Security scans (migration 0061).
export const securityScans = pgTable("security_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanType: text("scan_type").notNull(),
  target: text("target").notNull(),
  findings: jsonb("findings").notNull().default([]),
  severityMax: text("severity_max"),
  passed: boolean("passed").notNull().default(false),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({
    idx_security_scans_type: index("idx_security_scans_type").on(t.scanType, t.scannedAt),
    idx_security_scans_unresolved: index("idx_security_scans_unresolved").on(t.scanType),
  }));

// Governance decisions (migration 0062).
export const governanceDecisions = pgTable("governance_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  workspaceId: uuid("ws_id"),
  actorId: text("actor_id").notNull(),
  riskLevel: text("risk_level").notNull(),
  decision: text("decision").notNull(),
  policyKey: text("policy_key"),
  policyVersion: text("policy_version"),
  reasoning: jsonb("reasoning").notNull().default({}),
  decidedBy: text("decided_by").notNull().default("system"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  reversible: boolean("reversible").notNull().default(true),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversedBy: text("reversed_by"),
  appealable: boolean("appealable").notNull().default(true),
  appealedAt: timestamp("appealed_at", { withTimezone: true }),
  appealStatus: text("appeal_status"),
}, (t) => ({
    idx_gov_decisions_target: index("idx_gov_decisions_target").on(t.targetType, t.targetId),
    idx_gov_decisions_risk: index("idx_gov_decisions_risk").on(t.riskLevel, t.decision),
    idx_gov_decisions_ws: index("idx_gov_decisions_ws").on(t.workspaceId, t.decidedAt),
  }));

// Governance delegations (migration 0062).
export const governanceDelegations = pgTable("governance_delegations", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  delegatorId: text("delegator_id").notNull(),
  delegateeId: text("delegatee_id").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeFilter: jsonb("scope_filter").notNull().default({}),
  conditions: jsonb("conditions").notNull().default({}),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  reviewIntervalDays: integer("review_interval_days").notNull().default(90),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
}, (t) => ({
    idx_gov_delegations_delegatee: index("idx_gov_delegations_delegatee").on(t.delegateeId, t.status),
    idx_gov_delegations_action: index("idx_gov_delegations_action").on(t.actionType, t.status),
  }));

// Governance kill switches (migration 0062).
export const governanceKillSwitches = pgTable("governance_kill_switches", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  scopeType: text("scope_type").notNull(),
  scopeFilter: jsonb("scope_filter").notNull().default({}),
  description: text("description").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedBy: text("activated_by").notNull().default("system"),
  activationReason: text("activation_reason"),
  autoDeactivateAt: timestamp("auto_deactivate_at", { withTimezone: true }),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedBy: text("deactivated_by"),
  deactivationReason: text("deactivation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_kill_switches_active: index("idx_kill_switches_active").on(t.isActive, t.scopeType),
  }));

// Governance transparency log (migration 0062).
export const governanceTransparencyLog = pgTable("governance_transparency_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  workspaceId: uuid("ws_id"),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  decision: text("decision").notNull(),
  riskLevel: text("risk_level").notNull(),
  policyKey: text("policy_key"),
  reasoningSummary: text("reasoning_summary").notNull(),
  userVisible: boolean("user_visible").notNull().default(true),
  userMessage: text("user_message"),
  auditorVisible: boolean("auditor_visible").notNull().default(false),
  auditorEvidence: jsonb("auditor_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
    idx_transparency_user: index("idx_transparency_user").on(t.userId, t.createdAt),
    idx_transparency_ws: index("idx_transparency_ws").on(t.workspaceId, t.createdAt),
    idx_transparency_auditor: index("idx_transparency_auditor").on(t.auditorVisible, t.createdAt),
  }));
