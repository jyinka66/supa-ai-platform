import { z } from "zod";
import { MODES } from "@/lib/prompts";
import { LOCALES } from "@/lib/i18n/config";

/**
 * Shared Zod schemas for request body validation.
 *
 * Every schema uses `.strict()` to reject unknown keys — prevents
 * surprise-field injection (e.g. a client sending `{"role": "admin"}`
 * alongside a chat request shouldn't silently override anything).
 *
 * Every schema is exported so route handlers can import + reuse:
 *
 *   import { chatRequestSchema } from "@/lib/schemas";
 *   const result = await parseBody(req, chatRequestSchema);
 */

// ============ CHAT ============

export const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    content: z.string().min(1).max(32_000), // matches MAX_BODY_BYTES — single message can fill the body
    mode: z.enum(MODES), // matches the prompt library: chat/write/rewrite/summarize/translate/code/image/document/plan
    language: z.enum(LOCALES), // all 10 supported locales
    parentId: z.string().uuid().nullable().optional(),
    idempotencyKey: z.string().min(8).max(128),
    needsVision: z.boolean().optional(),
    userOverride: z.string().optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatCompleteSchema = z
  .object({
    conversationId: z.string().uuid(),
    content: z.string().min(1).max(32_000),
    mode: z.enum(MODES),
    language: z.enum(LOCALES),
    parentId: z.string().uuid().nullable().optional(),
    idempotencyKey: z.string().min(8).max(128),
    userOverride: z.string().optional(),
  })
  .strict();

// ============ FEEDBACK ============

export const feedbackSchema = z
  .object({
    messageId: z.string().uuid(),
    rating: z.union([z.literal(1), z.literal(-1)]),
    comment: z.string().max(1_000).optional(),
  })
  .strict();

// ============ SHARE LINKS ============

export const shareCreateSchema = z
  .object({
    conversationId: z.string().uuid(),
    expiresInDays: z.number().int().min(1).max(90).default(30),
    maxViews: z.number().int().min(1).max(10_000).nullable().default(null),
  })
  .strict();

// ============ CONVERSATIONS ============

export const conversationCreateSchema = z
  .object({
    workspaceId: z.string().uuid(),
    mode: z.enum(MODES).default("chat"),
    title: z.string().min(1).max(200).optional(),
    languagePref: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    folderId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const conversationPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    folderId: z.string().uuid().nullable().optional(),
  })
  .strict();

// ============ WORKSPACES ============

export const workspaceCreateSchema = z
  .object({
    name: z.string().min(2).max(80),
    slug: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/, "slug must be lowercase letters, digits, hyphens"),
  })
  .strict();

export const workspacePatchSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    slug: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/)
      .optional(),
    logo_path: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    timezone: z.string().optional(),
    default_language: z.string().optional(),
    plan: z.string().optional(),
    seat_limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

// ============ INVITES ============

export const inviteCreateSchema = z
  .object({
    workspaceId: z.string().uuid(),
    email: z.string().email().max(254),
    role: z.enum(["admin", "member", "viewer"]).default("member"),
  })
  .strict();

export const inviteAcceptSchema = z
  .object({
    token: z.string().min(1).max(512),
  })
  .strict();

// ============ AUTH ============

export const signupSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(12).max(128),
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

// ============ SESSIONS ============

export const sessionRevokeAllSchema = z
  .object({
    revoke_all: z.boolean(),
  })
  .strict();

// ============ ACCOUNT DELETION ============

export const deletionRequestSchema = z
  .object({
    reason: z.enum(["user_request", "gdpr"]).default("user_request"),
  })
  .strict();

// ============ USAGE BUDGETS ============

export const budgetCreateSchema = z
  .object({
    scopeType: z.enum(["user", "workspace"]),
    scopeId: z.string().uuid(),
    period: z.enum(["daily", "weekly", "monthly", "yearly"]).default("monthly"),
    costLimitUsd: z.number().min(0).max(100_000),
    alertThreshold: z.number().min(0).max(1).default(0.8),
  })
  .strict();
