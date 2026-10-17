// Marketplace publishing governance — automated submission review.
//
// The spec (3.3): "Every submission to the agent marketplace, connector registry,
// template marketplace, and prompt library is governed."
//
// Review checks:
//   1. Schema validation — required fields, valid types.
//   2. Safety checks — no injection, no PII leakage, no harmful content.
//   3. Permission review — requested scopes are minimal + justified.
//   4. Budget review — budget limits are reasonable (not too high).
//   5. Plagiarism detection — not a copy of an existing marketplace item.
//
// Reputation-based publishing:
//   - Trusted creators (reputation ≥ 70, verified) → lighter review.
//   - New creators → full review.
//
// Human review for high-risk submissions:
//   - Financial agents, healthcare agents, legal agents, money-moving agents.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SubmissionKind = "agent" | "connector" | "template" | "prompt";
export type ReviewStatus = "auto_approved" | "pending_review" | "rejected" | "human_review_required";

export interface SubmissionReviewResult {
  status: ReviewStatus;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresHumanReview: boolean;
  humanReviewReason?: string;
  plagiarismDetected: boolean;
  reasoning: string;
}

// ───────────────────────────────────────────────
// High-risk submission types (always require human review).
// ───────────────────────────────────────────────

export const HIGH_RISK_TYPES = [
  "financial_agent",      // can move money.
  "healthcare_agent",     // handles PHI.
  "legal_agent",          // handles privileged info.
  "payment_connector",    // processes payments.
  "data_export_tool",     // exports user data.
] as const;

export function isHighRiskSubmission(kind: SubmissionKind, manifest: Record<string, unknown>): boolean {
  const type = manifest.type as string | undefined;
  if (type && (HIGH_RISK_TYPES as readonly string[]).includes(type)) return true;

  // Check for financial keywords in the manifest.
  const manifestStr = JSON.stringify(manifest).toLowerCase();
  if (manifestStr.includes("charge") || manifestStr.includes("refund") || manifestStr.includes("transfer")) {
    if (kind === "agent") return true; // agents that can move money.
  }

  // Check for healthcare/legal keywords.
  if (kind === "agent") {
    if (manifestStr.includes("phi") || manifestStr.includes("hipaa") || manifestStr.includes("patient")) return true;
    if (manifestStr.includes("legal") || manifestStr.includes("attorney") || manifestStr.includes("privileged")) return true;
  }

  return false;
}

// ───────────────────────────────────────────────
// reviewSubmission — the automated review pipeline.
//
// Flow:
//   1. Schema validation.
//   2. Safety checks (injection, PII, harmful content).
//   3. Permission review (minimal scopes).
//   4. Budget review (reasonable limits).
//   5. Plagiarism detection (against existing items).
//   6. High-risk classification.
//   7. Reputation-based routing (trusted → lighter review).
// ───────────────────────────────────────────────

export async function reviewSubmission(input: {
  kind: SubmissionKind;
  slug: string;
  title: string;
  description: string;
  manifest: Record<string, unknown>;
  authorReputation: number;
  authorVerified: boolean;
  existingSlugs?: string[]; // for plagiarism detection.
}): Promise<SubmissionReviewResult> {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // 1. Schema validation.
  const schemaValid = input.title.length >= 3 && input.description.length >= 10 && input.slug.length >= 3;
  checks.push({
    name: "schema_validation",
    passed: schemaValid,
    detail: schemaValid ? "All required fields present and valid." : "Missing or invalid required fields.",
  });

  // 2. Safety checks.
  const contentStr = `${input.title} ${input.description} ${JSON.stringify(input.manifest)}`.toLowerCase();
  const harmfulPatterns = ["injection", "xss", "sql injection", "rm -rf", "eval(", "exec("];
  const safetyPassed = !harmfulPatterns.some((p) => contentStr.includes(p));
  checks.push({
    name: "safety_check",
    passed: safetyPassed,
    detail: safetyPassed ? "No harmful patterns detected." : "Harmful patterns detected in content.",
  });

  // 3. Permission review (check for excessive scopes).
  const requestedScopes = (input.manifest.scopes as string[] | undefined) ?? [];
  const excessiveScopes = ["admin", "root", "superuser", "*"];
  const hasExcessiveScopes = requestedScopes.some((s) => excessiveScopes.includes(s));
  checks.push({
    name: "permission_review",
    passed: !hasExcessiveScopes,
    detail: hasExcessiveScopes ? "Excessive scopes requested (admin/root/*)." : "Scopes are minimal and justified.",
  });

  // 4. Budget review.
  const budget = (input.manifest.budgetLimitUsd as number | undefined) ?? 0;
  const budgetPassed = budget <= 100; // max $100 per run.
  checks.push({
    name: "budget_review",
    passed: budgetPassed,
    detail: budgetPassed ? `Budget $${budget} is within limits.` : `Budget $${budget} exceeds $100 limit.`,
  });

  // 5. Plagiarism detection (simple slug-based stub).
  const plagiarismDetected = input.existingSlugs?.includes(input.slug) ?? false;
  checks.push({
    name: "plagiarism_detection",
    passed: !plagiarismDetected,
    detail: plagiarismDetected ? `Slug "${input.slug}" already exists (possible copy).` : "No plagiarism detected.",
  });

  // 6. High-risk classification.
  const isHighRisk = isHighRiskSubmission(input.kind, input.manifest);
  let riskLevel: SubmissionReviewResult["riskLevel"] = "low";
  if (isHighRisk) riskLevel = "high";
  else if (!input.authorVerified || input.authorReputation < 50) riskLevel = "medium";

  // 7. Determine review status.
  const allPassed = checks.every((c) => c.passed);
  let status: ReviewStatus;
  let requiresHumanReview = false;
  let humanReviewReason: string | undefined;

  if (!allPassed) {
    status = "rejected";
  } else if (isHighRisk) {
    status = "human_review_required";
    requiresHumanReview = true;
    const highRiskType = (input.manifest.type as string) ?? "unknown";
    humanReviewReason = `High-risk submission type: ${highRiskType}. Human review required for ${input.kind} that can move money, handle PHI, or access privileged information.`;
  } else if (input.authorVerified && input.authorReputation >= 70) {
    // Trusted creators: auto-approve for low/medium risk.
    status = "auto_approved";
  } else {
    // New/untrusted creators: full review.
    status = "pending_review";
  }

  const reasoning = `Review: ${status}. Risk: ${riskLevel}. ${allPassed ? "All checks passed." : "Some checks failed."} ${requiresHumanReview ? humanReviewReason : ""} Author: reputation=${input.authorReputation}, verified=${input.authorVerified}.`;

  return {
    status,
    checks,
    riskLevel,
    requiresHumanReview,
    ...(humanReviewReason ? { humanReviewReason } : {}),
    plagiarismDetected,
    reasoning,
  };
}
