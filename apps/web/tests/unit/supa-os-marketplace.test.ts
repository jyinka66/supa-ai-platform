import { describe, expect, it } from "vitest";
import { submitForReview, type MarketplaceItem } from "@/lib/supa-os/marketplace";

function item(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: "c1a7f2b2-ef08-4a20-a75f-c4e810f01d15", name: "Useful skill", type: "agent_skill",
    description: "A useful skill that performs a focused task for a workspace.", creatorId: "admin-1", creatorName: "Admin",
    status: "draft", monetization: "free", price: 0, version: "1.0.0", tags: [],
    manifest: { entrypoint: "index.ts", permissions: [], monthlyBudgetUsd: 5, source: "export async function run() { return true; }" }, downloadCount: 0, rating: 0,
    reviewCount: 0, featured: false, verified: false, publishedAt: null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe("marketplace automated review checks", () => {
  it("validates declared fields and keeps human quality review pending", () => {
    const result = submitForReview(item());
    expect(result.item.status).toBe("in_review");
    expect(result.checks.find((check) => check.id === "schema")?.status).toBe("approved");
    expect(result.checks.find((check) => check.id === "security")?.status).toBe("approved");
    expect(result.checks.find((check) => check.id === "quality")?.status).toBe("in_progress");
  });

  it("rejects embedded secrets and duplicate manifests", () => {
    const unsafe = submitForReview(item({ manifest: { entrypoint: "index.ts", permissions: [], monthlyBudgetUsd: 5, source: "export async function run() { return true; }", api_key: "supersecret-value-123" } }));
    expect(unsafe.checks.find((check) => check.id === "security")?.status).toBe("rejected");
    const duplicate = submitForReview(item(), { duplicateManifest: true });
    expect(duplicate.checks.find((check) => check.id === "plagiarism")?.status).toBe("rejected");
  });

  it("rejects over-budget items and missing permission declarations", () => {
    const overBudget = submitForReview(item({ manifest: { entrypoint: "index.ts", permissions: [], monthlyBudgetUsd: 1001, source: "export async function run() { return true; }" } }));
    expect(overBudget.checks.find((check) => check.id === "budget")?.status).toBe("rejected");
    const missingPermissions = submitForReview(item({ manifest: { entrypoint: "index.ts", source: "export async function run() { return true; }", monthlyBudgetUsd: 5 } }));
    expect(missingPermissions.checks.find((check) => check.id === "permissions")?.status).toBe("rejected");
  });
});
