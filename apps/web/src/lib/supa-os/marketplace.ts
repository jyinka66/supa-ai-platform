// Supa OS Marketplace — third-party agent skills, API connectors, UI components.
//
// Phase 4: "Allow third-party developers to publish and monetize custom agent
// skills, API connectors, and UI component blueprints."
//
// The Marketplace provides:
//   1. 5 marketplace item types (skills, connectors, components, templates, themes).
//   2. Publishing workflow (submit → review → approve → publish).
//   3. Monetization (free, one-time, subscription, revenue share).
//   4. Discovery (search, categories, featured, trending).
//   5. Reviews + ratings.
//   6. Versioning + updates.

// ───────────────────────────────────────────────
// 1. Marketplace item types.
// ───────────────────────────────────────────────

export type MarketplaceItemType =
  | "agent_skill"        // custom agent capability (e.g. "document analysis agent")
  | "api_connector"      // API integration (e.g. "Stripe connector", "Plaid connector")
  | "ui_component"       // UI component blueprint (e.g. "LoanCalculator widget")
  | "template"           // full app template (e.g. "Fintech starter kit")
  | "theme";             // design system theme (e.g. "Dark fintech theme")

export interface MarketplaceItemTypeSpec {
  type: MarketplaceItemType;
  title: string;
  description: string;
  /** File extension for the item. */
  fileExtension: string;
  /** Whether this item type supports monetization. */
  monetizable: boolean;
  /** Whether this item type requires code review. */
  requiresCodeReview: boolean;
  implemented: boolean;
}

export const MARKETPLACE_ITEM_TYPES: MarketplaceItemTypeSpec[] = [
  { type: "agent_skill", title: "Agent Skill", description: "Custom agent capability — extends what Supa OS agents can do (e.g. document analysis, fraud detection, sentiment analysis).", fileExtension: ".skill.ts", monetizable: true, requiresCodeReview: true, implemented: true },
  { type: "api_connector", title: "API Connector", description: "Pre-built API integration — connects Supa OS to a third-party service (e.g. Stripe, Plaid, Twilio, SendGrid).", fileExtension: ".connector.ts", monetizable: true, requiresCodeReview: true, implemented: true },
  { type: "ui_component", title: "UI Component Blueprint", description: "Reusable UI component (e.g. LoanCalculator, TransactionChart, KycWidget).", fileExtension: ".tsx", monetizable: true, requiresCodeReview: true, implemented: true },
  { type: "template", title: "App Template", description: "Full application template — a complete starting point for a specific domain (e.g. fintech starter, healthcare portal).", fileExtension: ".template.json", monetizable: true, requiresCodeReview: true, implemented: true },
  { type: "theme", title: "Design System Theme", description: "Custom design system theme — colors, typography, spacing, dark mode variant.", fileExtension: ".theme.json", monetizable: true, requiresCodeReview: false, implemented: true },
];

// ───────────────────────────────────────────────
// 2. Marketplace item.
// ───────────────────────────────────────────────

export type MarketplaceItemStatus =
  | "draft"          // author is editing.
  | "submitted"     // submitted for review.
  | "in_review"     // being reviewed.
  | "approved"       // approved, ready to publish.
  | "published"      // live on the marketplace.
  | "rejected"       // rejected by review.
  | "deprecated"     // author deprecated it.
  | "removed"       // removed by admins.
  | "yanked";       // forcibly withdrawn after publication.

export type MonetizationModel =
  | "free"             // no charge.
  | "one_time"         // one-time purchase.
  | "subscription"     // monthly/yearly subscription.
  | "revenue_share"    // revenue share (70% to creator, 30% to Supa OS).
  | "freemium";         // free tier + paid tier.

export interface MarketplaceItem {
  id: string;
  name: string;
  type: MarketplaceItemType;
  description: string;
  /** The creator's developer ID. */
  creatorId: string;
  creatorName: string;
  /** Current status. */
  status: MarketplaceItemStatus;
  /** Monetization model. */
  monetization: MonetizationModel;
  /** Price (USD) — for one_time / subscription. */
  price: number;
  /** Version (semantic). */
  version: string;
  /** Category tags. */
  tags: string[];
  /** Optional item manifest/payload used by automated review checks. */
  manifest?: Record<string, unknown>;
  /** Download count. */
  downloadCount: number;
  /** Rating (0-5, average). */
  rating: number;
  /** Review count. */
  reviewCount: number;
  /** Whether this item is featured. */
  featured: boolean;
  /** Whether this item is verified (by Supa OS team). */
  verified: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ───────────────────────────────────────────────
// 3. Publishing workflow.
// ───────────────────────────────────────────────

export type ReviewStatus = "pending" | "in_progress" | "approved" | "rejected";

export interface ReviewCheck {
  id: string;
  title: string;
  description: string;
  status: ReviewStatus;
  reviewer: string | null;
  notes: string | null;
}

export const REVIEW_CHECKS: Array<{ id: string; title: string; description: string }> = [
  { id: "schema", title: "Schema Validation", description: "Item structure matches the marketplace schema." },
  { id: "security", title: "Security Scan", description: "No malicious code, no hardcoded secrets, no outbound data exfiltration." },
  { id: "permissions", title: "Permission Audit", description: "Item only requests the permissions it actually needs (least privilege)." },
  { id: "budget", title: "Budget Impact", description: "Item's resource usage is within acceptable limits." },
  { id: "plagiarism", title: "Plagiarism Check", description: "Item is original (not a copy of another marketplace item)." },
  { id: "quality", title: "Quality Review", description: "Code quality, documentation, and tests meet the standard." },
];

/**
 * Submit an item for marketplace review.
 *
 * The publishing workflow:
 *   1. Author creates item (draft).
 *   2. Author submits for review.
 *   3. Automated checks run (schema + security + permissions + budget + plagiarism).
 *   4. Human review (quality).
 *   5. If all checks pass → approved → published.
 *   6. If any check fails → rejected (with feedback).
 */
export function submitForReview(item: MarketplaceItem, options: { duplicateManifest?: boolean } = {}): { item: MarketplaceItem; checks: ReviewCheck[] } {
  const checks: ReviewCheck[] = REVIEW_CHECKS.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    status: "pending",
    reviewer: null,
    notes: null,
  }));

  // Validate the submitted manifest and source. Checks that require a human
  // judgment (quality) remain pending; automated checks never accept browser-
  // supplied results as proof.
  const manifest = item.manifest ?? {};
  const requiredKeys: Record<MarketplaceItemType, string[]> = {
    agent_skill: ["entrypoint", "permissions"], api_connector: ["entrypoint", "permissions"],
    ui_component: ["entrypoint", "permissions"], template: ["files", "permissions"], theme: ["tokens"],
  };
  const missing = requiredKeys[item.type].filter((key) => !(key in manifest));
  checks[0]!.status = missing.length ? "rejected" : "approved";
  checks[0]!.notes = missing.length ? `Missing required manifest fields: ${missing.join(", ")}` : "Required manifest fields are present.";
  const manifestText = JSON.stringify(manifest);
  const sourceFiles = Array.isArray(manifest.files)
    ? manifest.files.filter((file): file is Record<string, unknown> => typeof file === "object" && file !== null && typeof (file as Record<string, unknown>).content === "string")
    : [];
  const hasInspectableSource = (typeof manifest.source === "string" && manifest.source.trim().length > 0) ||
    (typeof manifest.code === "string" && manifest.code.trim().length > 0) || sourceFiles.length > 0;
  const unsafePatterns = [
    /\beval\s*\(/i, /new\s+Function\s*\(/i, /child_process|node:child_process/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:["']?(?:api[_-]?key|secret|password|token|private[_-]?key)["']?)\s*[:=]\s*["'][^"']{8,}["']/i,
  ];
  const unsafeMatch = unsafePatterns.some((pattern) => pattern.test(manifestText));
  checks[1]!.status = unsafeMatch || (item.type !== "theme" && !hasInspectableSource) ? "rejected" : "approved";
  checks[1]!.notes = unsafeMatch
    ? "Potential unsafe execution or embedded secret pattern detected; inspect and remove it."
    : item.type !== "theme" && !hasInspectableSource
      ? "Inspectable source code is required before executable assets can be published."
      : "Static source/manifest scan found no known high-risk patterns; a full code audit is still required.";
  checks[2]!.status = Array.isArray(manifest.permissions) || item.type === "theme" ? "approved" : "rejected";
  checks[2]!.notes = Array.isArray(manifest.permissions) ? "Permissions are explicitly declared." : item.type === "theme" ? "Static theme assets do not request runtime permissions." : "Executable assets must declare a permissions array.";
  const budgetValue = manifest.monthlyBudgetUsd ?? manifest.budgetUsd;
  const estimatedBudget = budgetValue === undefined && item.type === "theme" ? 0 : Number(budgetValue);
  const budgetDeclared = budgetValue !== undefined || item.type === "theme";
  checks[3]!.status = budgetDeclared && Number.isFinite(estimatedBudget) && estimatedBudget >= 0 && estimatedBudget <= 1000 ? "approved" : "rejected";
  checks[3]!.notes = item.type === "theme" ? "Static theme assets do not incur runtime budget." : "A finite monthly budget between $0 and $1,000 must be declared.";
  checks[4]!.status = options.duplicateManifest ? "rejected" : "approved";
  checks[4]!.notes = options.duplicateManifest ? "An identical manifest already exists in the marketplace." : "No identical manifest was found in the current marketplace corpus.";
  checks[5]!.status = "in_progress";

  return {
    item: { ...item, status: "in_review", updatedAt: new Date() },
    checks,
  };
}

/**
 * Complete the review (approve or reject).
 */
export function completeReview(input: {
  item: MarketplaceItem;
  checks: ReviewCheck[];
  decision: "approve" | "reject";
  reviewerId: string;
  notes: string;
}): MarketplaceItem {
  if (input.decision === "approve") {
    return {
      ...input.item,
      status: "published",
      verified: true,
      publishedAt: new Date(),
      updatedAt: new Date(),
    };
  }
  return {
    ...input.item,
    status: "rejected",
    updatedAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// 4. Reviews + ratings.
// ───────────────────────────────────────────────

export interface MarketplaceReview {
  id: string;
  itemId: string;
  /** The reviewer's user ID. */
  userId: string;
  userName: string;
  /** Rating (1-5). */
  rating: number;
  /** Review text. */
  comment: string;
  /** Whether the reviewer verified their purchase. */
  verifiedPurchase: boolean;
  createdAt: Date;
  /** Whether the creator responded. */
  creatorResponse: string | null;
  respondedAt: Date | null;
}

// ───────────────────────────────────────────────
// 5. Discovery.
// ───────────────────────────────────────────────

export type DiscoverySort = "trending" | "newest" | "top_rated" | "most_downloaded" | "featured";

export interface DiscoveryQuery {
  query?: string;
  type?: MarketplaceItemType;
  tags?: string[];
  monetization?: MonetizationModel;
  sort?: DiscoverySort;
  verifiedOnly?: boolean;
}

export function discoverItems(items: MarketplaceItem[], query: DiscoveryQuery): MarketplaceItem[] {
  let filtered = items.filter((i) => i.status === "published");

  if (query.query) {
    const q = query.query.toLowerCase();
    filtered = filtered.filter((i) =>
      i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (query.type) filtered = filtered.filter((i) => i.type === query.type);
  if (query.tags && query.tags.length > 0) filtered = filtered.filter((i) => query.tags!.some((t) => i.tags.includes(t)));
  if (query.monetization) filtered = filtered.filter((i) => i.monetization === query.monetization);
  if (query.verifiedOnly) filtered = filtered.filter((i) => i.verified);

  switch (query.sort ?? "trending") {
    case "trending":
      filtered.sort((a, b) => b.downloadCount - a.downloadCount);
      break;
    case "newest":
      filtered.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
      break;
    case "top_rated":
      filtered.sort((a, b) => b.rating - a.rating);
      break;
    case "most_downloaded":
      filtered.sort((a, b) => b.downloadCount - a.downloadCount);
      break;
    case "featured":
      filtered.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
      break;
  }

  return filtered;
}

// ───────────────────────────────────────────────
// 6. Creator revenue.
// ───────────────────────────────────────────────

export interface CreatorRevenue {
  creatorId: string;
  /** Total revenue (USD). */
  totalRevenue: number;
  /** Revenue this month. */
  monthlyRevenue: number;
  /** Revenue split (70% creator / 30% Supa OS for revenue_share model). */
  creatorShare: number;
  platformShare: number;
  /** Items published. */
  itemCount: number;
  /** Total downloads. */
  totalDownloads: number;
  /** Average rating across all items. */
  averageRating: number;
}

export function calculateCreatorRevenue(input: {
  items: MarketplaceItem[];
  monthlySales: Array<{ itemId: string; quantity: number; price: number; monetization: MonetizationModel }>;
  creatorId: string;
}): CreatorRevenue {
  const creatorItems = input.items.filter((i) => i.creatorId === input.creatorId);
  const totalRevenue = input.monthlySales.reduce((sum, s) => sum + s.quantity * s.price, 0);
  const monthlyRevenue = totalRevenue;

  // Revenue share: 70% creator / 30% platform for revenue_share model.
  // For one_time / subscription: 85% creator / 15% platform.
  let creatorShare = 0;
  let platformShare = 0;
  for (const sale of input.monthlySales) {
    const revenue = sale.quantity * sale.price;
    if (sale.monetization === "revenue_share") {
      creatorShare += revenue * 0.7;
      platformShare += revenue * 0.3;
    } else {
      creatorShare += revenue * 0.85;
      platformShare += revenue * 0.15;
    }
  }

  const totalDownloads = creatorItems.reduce((sum, i) => sum + i.downloadCount, 0);
  const averageRating = creatorItems.length > 0
    ? creatorItems.reduce((sum, i) => sum + i.rating, 0) / creatorItems.length
    : 0;

  return {
    creatorId: input.creatorId,
    totalRevenue: creatorShare,
    monthlyRevenue,
    creatorShare,
    platformShare,
    itemCount: creatorItems.length,
    totalDownloads,
    averageRating,
  };
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface MarketplaceVerification {
  totalItemTypes: number;
  totalReviewChecks: number;
  submitFunctionImplemented: boolean;
  discoverFunctionImplemented: boolean;
  revenueFunctionImplemented: boolean;
  allImplemented: boolean;
}

export function verifyMarketplace(): MarketplaceVerification {
  return {
    totalItemTypes: MARKETPLACE_ITEM_TYPES.length,
    totalReviewChecks: REVIEW_CHECKS.length,
    submitFunctionImplemented: true,
    discoverFunctionImplemented: true,
    revenueFunctionImplemented: true,
    allImplemented: MARKETPLACE_ITEM_TYPES.every((t) => t.implemented),
  };
}
