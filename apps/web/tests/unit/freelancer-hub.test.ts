/**
 * Tests for the Freelancer Hub modules.
 *
 * Covers:
 *   1. Semantic job matching — TF-IDF embedding, cosine similarity, client filters.
 *   2. Content repurposer — key-point extraction, platform-specific generation.
 *   3. Approval bot — Slack + Telegram message builders, callback parsing.
 *   4. Bid analytics — conversion rates, win/loss, by-platform/by-tone breakdowns.
 */

import { describe, it, expect } from "vitest";
import {
  semanticMatchJobs,
  cosineSimilarity,
  buildVocabulary,
  embed,
  type PortfolioEmbedding as PortfolioEmbeddingType,
  type JobWithClientInfo,
} from "@/lib/freelancer/semantic-match";

// PortfolioEmbedding has a `vector` field that's computed at runtime —
// we omit it in test fixtures (semanticMatchJobs fills it in).
type PortfolioEmbedding = Omit<PortfolioEmbeddingType, "vector">;
import {
  repurposeContent,
  PLATFORM_LIMITS,
} from "@/lib/freelancer/content-repurposer";
import {
  buildSlackApprovalMessage,
  buildTelegramApprovalMessage,
  buildApprovalMessage,
  parseApprovalCallback,
} from "@/lib/freelancer/approval-bot";
import { computeBidAnalytics, type BidRecord } from "@/lib/freelancer/bid-analytics";

// ───────────────────────────────────────────────
// Semantic job matching
// ───────────────────────────────────────────────

describe("semanticMatchJobs", () => {
  const portfolio: PortfolioEmbedding[] = [
    {
      portfolioId: "p1",
      title: "Fintech Wallet App",
      sourceText: "Built a fintech wallet with BVN verification, NGN wallet, mobile money transfers via Paystack. Double-entry ledger, PCI-DSS compliant.",
      tags: ["fintech", "wallet", "BVN"],
    },
    {
      portfolioId: "p2",
      title: "E-commerce Platform",
      sourceText: "Built an e-commerce platform with product catalog, Stripe payments, shopping cart, and admin dashboard. Next.js and Supabase.",
      tags: ["ecommerce", "stripe"],
    },
    {
      portfolioId: "p3",
      title: "Healthcare Portal",
      sourceText: "Built a patient portal with HIPAA compliance, FHIR API, appointments, lab results, secure messaging.",
      tags: ["healthcare", "HIPAA"],
    },
  ];

  const jobs: JobWithClientInfo[] = [
    {
      jobId: "job_1",
      title: "Build a fintech wallet app with BVN verification",
      description: "We need a developer to build a fintech wallet app for Nigeria with BVN verification, NGN wallet, and mobile money transfers.",
      budget: { amount: 3000, currency: "USD" },
      clientRating: 4.8,
      clientVerifiedPayment: true,
      clientLocation: "NG",
      platform: "upwork",
    },
    {
      jobId: "job_2",
      title: "React Native developer for e-commerce app",
      description: "Looking for an experienced React Native developer to build a cross-platform e-commerce app with Stripe payments and product catalog.",
      budget: { amount: 2500, currency: "USD" },
      clientRating: 4.5,
      clientVerifiedPayment: true,
      clientLocation: "US",
      platform: "upwork",
    },
    {
      jobId: "job_3",
      title: "WordPress site maintenance",
      description: "Need someone to maintain our existing WordPress site, update plugins, and fix minor bugs.",
      budget: { amount: 200, currency: "USD" },
      clientRating: 3.8,
      clientVerifiedPayment: false,
      clientLocation: "IN",
      platform: "upwork",
    },
  ];

  it("returns results sorted by score descending", () => {
    const results = semanticMatchJobs(jobs, portfolio);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  it("scores the fintech job highest against the fintech portfolio", () => {
    const results = semanticMatchJobs(jobs, portfolio);
    const top = results[0]!;
    expect(top.jobId).toBe("job_1");
    expect(top.matchedPortfolio[0]!.title).toBe("Fintech Wallet App");
  });

  it("applies client quality filters", () => {
    const results = semanticMatchJobs(jobs, portfolio, {
      minClientRating: 4.0,
      requireVerifiedPayment: true,
    });
    // job_3 (rating 3.8, unverified) should be filtered out.
    expect(results.find((r) => r.jobId === "job_3")).toBeUndefined();
  });

  it("applies budget filters", () => {
    const results = semanticMatchJobs(jobs, portfolio, {
      minBudget: 1000,
    });
    // job_3 ($200 budget) should be filtered out.
    expect(results.find((r) => r.jobId === "job_3")).toBeUndefined();
  });

  it("includes match reasons (top overlapping terms)", () => {
    const results = semanticMatchJobs(jobs, portfolio);
    const top = results[0]!;
    expect(top.matchReasons.length).toBeGreaterThan(0);
  });

  it("includes matched portfolio items (top 3)", () => {
    const results = semanticMatchJobs(jobs, portfolio);
    const top = results[0]!;
    expect(top.matchedPortfolio.length).toBeLessThanOrEqual(3);
    expect(top.matchedPortfolio[0]!.portfolioId).toBeDefined();
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// ───────────────────────────────────────────────
// Content repurposer
// ───────────────────────────────────────────────

describe("repurposeContent", () => {
  const sampleContent = `
    How to Build a Fintech Wallet App for the Nigerian Market

    Building a fintech wallet requires careful attention to regulatory compliance, security, and user experience. In Nigeria, the Central Bank of Nigeria (CBN) requires BVN verification for all financial accounts.

    The first step is integrating a BVN verification provider like Mono. Mono provides a clean API for verifying Nigerian bank accounts and linking them to your wallet.

    Next, you need a double-entry ledger system. This ensures every transaction is properly recorded as both a debit and credit. The ledger should be immutable — once a transaction is posted, it cannot be edited.

    For payments, Paystack is the most popular gateway in Nigeria. It supports bank transfers, card payments, and mobile money. Integrate it for both inbound and outbound transactions.

    Security is paramount. Use AES-256 encryption at rest, TLS in transit, and implement RBAC so that only authorized roles can access sensitive data.

    Finally, build a clean mobile-first UI. Most Nigerian users access apps via mobile, so prioritize responsive design and low data usage.
  `;

  it("generates variants for all requested platforms", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["twitter_thread", "linkedin_post", "instagram_caption", "email_newsletter", "show_notes", "meta_description", "ad_copy"],
    });
    expect(result.variants).toHaveLength(7);
    for (const v of result.variants) {
      expect(v.content.length).toBeGreaterThan(0);
      expect(v.charCount).toBe(v.content.length);
    }
  });

  it("extracts key points from the content", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["linkedin_post"],
    });
    expect(result.extractedKeyPoints.length).toBeGreaterThan(0);
    expect(result.extractedKeyPoints.length).toBeLessThanOrEqual(6);
  });

  it("Twitter thread starts with 🧵", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["twitter_thread"],
    });
    expect(result.variants[0]!.content).toContain("🧵");
  });

  it("Instagram caption includes hashtags", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["instagram_caption"],
    });
    expect(result.variants[0]!.hashtags).toBeDefined();
    expect(result.variants[0]!.hashtags!.length).toBeGreaterThan(0);
  });

  it("meta_description is within 160 characters", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["meta_description"],
    });
    expect(result.variants[0]!.charCount).toBeLessThanOrEqual(160);
    expect(result.variants[0]!.withinLimit).toBe(true);
  });

  it("ad_copy is within 125 characters", () => {
    const result = repurposeContent({
      sourceContent: sampleContent,
      sourceType: "blog_post",
      platforms: ["ad_copy"],
    });
    expect(result.variants[0]!.charCount).toBeLessThanOrEqual(125);
  });

  it("PLATFORM_LIMITS has all 7 platforms", () => {
    expect(Object.keys(PLATFORM_LIMITS)).toHaveLength(7);
  });
});

// ───────────────────────────────────────────────
// Approval bot
// ───────────────────────────────────────────────

describe("approval bot", () => {
  const baseReq = {
    proposalId: "prop_001",
    jobId: "job_001",
    jobTitle: "Build a fintech wallet app",
    platform: "upwork" as const,
    proposal: { coverLetter: "Hi there, I can build this.", estimatedBudget: "$3000", estimatedTimeline: "4 weeks" },
    evaluation: { matchScore: 88, decision: "submit" as const },
    callbackUrl: "https://app.supa-os.local/callback",
    channel: "slack" as const,
  };

  it("builds a Slack message with Block Kit blocks", () => {
    const msg = buildSlackApprovalMessage(baseReq);
    expect(msg.channel).toBe("slack");
    const payload = msg.payload as { blocks: unknown[] };
    expect(payload.blocks).toBeDefined();
    expect(payload.blocks.length).toBeGreaterThan(0);
  });

  it("Slack message includes Approve, Edit, and Skip buttons", () => {
    const msg = buildSlackApprovalMessage(baseReq);
    const payload = msg.payload as { blocks: Array<Record<string, unknown>> };
    const actionsBlock = payload.blocks.find((b) => b.type === "actions") as { elements: Array<{ text: { text: string } }> } | undefined;
    expect(actionsBlock).toBeDefined();
    const buttonTexts = actionsBlock!.elements.map((e) => e.text.text);
    expect(buttonTexts.some((t) => t.includes("Approve"))).toBe(true);
    expect(buttonTexts.some((t) => t.includes("Edit"))).toBe(true);
    expect(buttonTexts.some((t) => t.includes("Skip"))).toBe(true);
  });

  it("builds a Telegram message with inline keyboard", () => {
    const msg = buildTelegramApprovalMessage(baseReq);
    expect(msg.channel).toBe("telegram");
    const payload = msg.payload as { reply_markup: { inline_keyboard: unknown[][] } };
    expect(payload.reply_markup).toBeDefined();
    expect(payload.reply_markup.inline_keyboard.length).toBeGreaterThan(0);
  });

  it("dispatcher routes to the right builder", () => {
    const slack = buildApprovalMessage({ ...baseReq, channel: "slack" });
    const telegram = buildApprovalMessage({ ...baseReq, channel: "telegram" });
    expect(slack.channel).toBe("slack");
    expect(telegram.channel).toBe("telegram");
  });

  it("parses Slack callback (approve_prop_001)", () => {
    const result = parseApprovalCallback("approve_prop_001", "slack");
    expect(result).toEqual({ action: "approve", proposalId: "prop_001" });
  });

  it("parses Telegram callback (edit:prop_001)", () => {
    const result = parseApprovalCallback("edit:prop_001", "telegram");
    expect(result).toEqual({ action: "edit", proposalId: "prop_001" });
  });

  it("returns null for invalid callback format", () => {
    expect(parseApprovalCallback("invalid_format", "slack")).toBeNull();
    expect(parseApprovalCallback("invalid", "telegram")).toBeNull();
  });
});

// ───────────────────────────────────────────────
// Bid analytics
// ───────────────────────────────────────────────

describe("computeBidAnalytics", () => {
  const sampleBids: BidRecord[] = [
    { id: "b1", jobId: "j1", jobTitle: "Fintech App", platform: "upwork", submittedAt: "2024-01-15T10:00:00Z", outcome: "won", resolvedAt: "2024-01-20T10:00:00Z", contractValue: 3000, currency: "USD", proposalTone: "direct", matchScore: 92, autoBid: true },
    { id: "b2", jobId: "j2", jobTitle: "E-commerce", platform: "upwork", submittedAt: "2024-01-16T10:00:00Z", outcome: "lost", resolvedAt: "2024-01-18T10:00:00Z", currency: "USD", proposalTone: "consultative", matchScore: 65, autoBid: false },
    { id: "b3", jobId: "j3", jobTitle: "Healthcare", platform: "direct", submittedAt: "2024-01-17T10:00:00Z", outcome: "won", resolvedAt: "2024-01-22T10:00:00Z", contractValue: 5000, currency: "USD", proposalTone: "bold", matchScore: 88, autoBid: false },
    { id: "b4", jobId: "j4", jobTitle: "CRM", platform: "fiverr", submittedAt: "2024-01-18T10:00:00Z", outcome: "pending", resolvedAt: null, currency: "USD", proposalTone: "direct", matchScore: 75, autoBid: true },
    { id: "b5", jobId: "j5", jobTitle: "Landing Page", platform: "upwork", submittedAt: "2024-01-19T10:00:00Z", outcome: "lost", resolvedAt: "2024-01-21T10:00:00Z", currency: "USD", proposalTone: "consultative", matchScore: 45, autoBid: false },
  ];

  it("computes total bids + won/lost/pending counts", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.totalBids).toBe(5);
    expect(a.totalWon).toBe(2);
    expect(a.totalLost).toBe(2);
    expect(a.totalPending).toBe(1);
  });

  it("computes conversion rate = won / (won + lost)", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.conversionRate).toBeCloseTo(0.5, 2); // 2 / (2+2) = 0.5
  });

  it("computes average contract value from won bids", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.averageContractValue).toBe(4000); // (3000 + 5000) / 2
  });

  it("computes total revenue from won bids", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.totalRevenue).toBe(8000);
  });

  it("computes auto-bid vs manual win rates", () => {
    const a = computeBidAnalytics(sampleBids);
    // Auto bids: b1 (won), b4 (pending) → won+lost = 1, won = 1 → winRate = 1.0
    expect(a.autoBidWinRate).toBeCloseTo(1.0, 1);
    // Manual bids: b2 (lost), b3 (won), b5 (lost) → won+lost = 3, won = 1 → winRate ≈ 0.33
    expect(a.manualBidWinRate).toBeCloseTo(1/3, 1);
  });

  it("breaks down by platform", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.byPlatform.upwork).toBeDefined();
    expect(a.byPlatform.upwork!.bids).toBe(3); // b1, b2, b5
    expect(a.byPlatform.upwork!.won).toBe(1); // b1
    expect(a.byPlatform.direct!.bids).toBe(1); // b3
  });

  it("breaks down by tone", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.byTone.direct).toBeDefined();
    expect(a.byTone.direct!.bids).toBe(2); // b1, b4
    expect(a.byTone.consultative!.bids).toBe(2); // b2, b5
  });

  it("groups by match-score bucket", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.byMatchScoreBucket).toHaveLength(5);
    // 92 is in the 85-95% bucket
    const bucket88 = a.byMatchScoreBucket.find((b) => b.bucket === "85-95%");
    expect(bucket88!.bids).toBe(2); // b1 (92), b3 (88)
  });

  it("computes recent trend (7 days)", () => {
    const a = computeBidAnalytics(sampleBids);
    expect(a.recentTrend).toHaveLength(7);
  });
});
