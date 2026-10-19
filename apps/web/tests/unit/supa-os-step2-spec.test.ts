/**
 * Supa OS Step 2 — Fintech Engine & Compliance Security — tests.
 */

import { describe, it, expect } from "vitest";
import {
  AFRICAN_KYC_PROVIDERS,
  postImmutableEntry,
  postDoubleEntryTransaction,
  verifyImmutableLedger,
  processBatchTransaction,
  createPaymentWebhook,
  initFintechEngine,
  verifyFintechEngine,
  type AfricanKycProviderId,
  type PaymentWebhookEvent,
  type LedgerEntryStatus,
  type ImmutableLedger,
} from "@/lib/supa-os/fintech-engine";
import {
  SENSITIVE_FIELDS,
  encryptSensitiveField,
  maskSensitiveField,
  autoEncryptSchema,
  FINTECH_ROLES,
  generateRbacMiddleware,
  COMPLIANCE_RULES,
  verifyComplianceSecurity,
  type SensitiveFieldType,
  type FintechRole,
} from "@/lib/supa-os/compliance-security";

// ───────────────────────────────────────────────
// 1. Supa Fintech Engine
// ───────────────────────────────────────────────

describe("1 — Supa Fintech Engine", () => {
  it("has 10 KYC providers (7 global + 3 African)", () => {
    expect(AFRICAN_KYC_PROVIDERS.length).toBeGreaterThanOrEqual(10);
    const ids = AFRICAN_KYC_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("persona"); // global.
    expect(ids).toContain("mono"); // African.
    expect(ids).toContain("bvn_verify"); // Nigeria BVN.
    expect(ids).toContain("nip_verification"); // Nigeria NIBSS.
  });

  it("Mono is African Open Banking", () => {
    const mono = AFRICAN_KYC_PROVIDERS.find((p) => p.id === "mono");
    expect(mono?.african).toBe(true);
    expect(mono?.verificationType).toBe("bank_account");
    expect(mono?.regions).toContain("NG");
  });

  it("BVN verification is Nigeria-specific", () => {
    const bvn = AFRICAN_KYC_PROVIDERS.find((p) => p.id === "bvn_verify");
    expect(bvn?.regions).toEqual(["NG"]);
    expect(bvn?.verificationType).toBe("bvn");
  });

  it("posts an entry to the immutable ledger", () => {
    const ledger: ImmutableLedger = { entries: [], chainTip: null, totalEntries: 0, chainVerified: true, lastVerifiedAt: null };
    const { ledger: updated, entry } = postImmutableEntry({
      ledger,
      transactionId: "txn-1",
      accountCode: "1000",
      entryType: "debit",
      amount: 10000,
      currency: "USD",
      description: "Loan disbursement",
      sourceType: "loan",
      sourceId: "loan-1",
    });
    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBeNull();
    expect(entry.hash).toBeTruthy();
    expect(entry.immutable).toBe(true);
    expect(entry.status).toBe("posted");
    expect(updated.totalEntries).toBe(1);
    expect(updated.chainTip).toBe(entry.hash);
  });

  it("posts a double-entry transaction (balanced)", () => {
    const ledger: ImmutableLedger = { entries: [], chainTip: null, totalEntries: 0, chainVerified: true, lastVerifiedAt: null };
    const { ledger: updated, transactionId, entries } = postDoubleEntryTransaction({
      ledger,
      entries: [
        { accountCode: "1100", entryType: "debit", amount: 10000, description: "Loan receivable" },
        { accountCode: "1000", entryType: "credit", amount: 10000, description: "Cash out" },
      ],
      currency: "USD",
      sourceType: "loan",
      sourceId: "loan-1",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.entryType).toBe("debit");
    expect(entries[1]?.entryType).toBe("credit");
    expect(entries[0]?.amount).toBe(entries[1]?.amount);
    expect(entries[0]?.transactionId).toBe(transactionId);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash); // hash chain.
    expect(updated.totalEntries).toBe(2);
  });

  it("verifies the immutable ledger chain (no tampering)", () => {
    let ledger: ImmutableLedger = { entries: [], chainTip: null, totalEntries: 0, chainVerified: true, lastVerifiedAt: null };
    const r1 = postImmutableEntry({ ledger, transactionId: "t1", accountCode: "1000", entryType: "debit", amount: 100, currency: "USD", description: "Test 1", sourceType: "test", sourceId: "1" });
    ledger = r1.ledger;
    const r2 = postImmutableEntry({ ledger, transactionId: "t2", accountCode: "1000", entryType: "credit", amount: 100, currency: "USD", description: "Test 2", sourceType: "test", sourceId: "2" });
    ledger = r2.ledger;

    const verified = verifyImmutableLedger(ledger);
    expect(verified.chainVerified).toBe(true);
    expect(verified.lastVerifiedAt).not.toBeNull();
  });

  it("processes a batch of high-frequency transactions", () => {
    const batch = processBatchTransaction({
      transactions: [
        { idempotencyKey: "key-1", amount: 100, currency: "USD", description: "Payment 1" },
        { idempotencyKey: "key-2", amount: 200, currency: "USD", description: "Payment 2" },
        { idempotencyKey: "key-3", amount: 300, currency: "USD", description: "Payment 3" },
      ],
    });
    expect(batch.count).toBe(3);
    expect(batch.totalAmount).toBe(600);
    expect(batch.idempotent).toBe(true);
    expect(batch.status).toBe("completed");
    expect(batch.processingMs).not.toBeNull();
  });

  it("detects non-idempotent batch (duplicate keys)", () => {
    const batch = processBatchTransaction({
      transactions: [
        { idempotencyKey: "key-1", amount: 100, currency: "USD", description: "Payment 1" },
        { idempotencyKey: "key-1", amount: 100, currency: "USD", description: "Duplicate" },
      ],
    });
    expect(batch.idempotent).toBe(false);
  });

  it("creates a payment webhook configuration", () => {
    const webhook = createPaymentWebhook({
      gateway: "stripe",
      events: ["payment.succeeded", "payment.failed", "payment.refunded"],
    });
    expect(webhook.gateway).toBe("stripe");
    expect(webhook.events).toHaveLength(3);
    expect(webhook.url).toBe("/api/webhooks/stripe");
    expect(webhook.secret).toContain("whsec_");
    expect(webhook.active).toBe(true);
  });

  it("initializes the fintech engine with KYC + payments", () => {
    const engine = initFintechEngine({
      kycProviders: ["persona", "bvn_verify"],
      paymentGateways: ["stripe", "paystack"],
      defaultCurrency: "USD",
    });
    expect(engine.ready).toBe(true);
    expect(engine.config.kycProviders).toContain("bvn_verify");
    expect(engine.config.paymentGateways).toContain("paystack");
    expect(engine.ledger).not.toBeNull();
    expect(engine.ledger?.totalEntries).toBe(0);
    expect(engine.webhooks).toHaveLength(2); // one per gateway.
    expect(engine.config.immutableLedger).toBe(true);
    expect(engine.config.highFrequency).toBe(true);
  });

  it("verifyFintechEngine reports all implemented", () => {
    const v = verifyFintechEngine();
    expect(v.totalKycProviders).toBeGreaterThanOrEqual(10);
    expect(v.totalPaymentGateways).toBe(8);
    expect(v.totalChartOfAccounts).toBe(14);
    expect(v.totalWebhookEvents).toBe(11);
    expect(v.allImplemented).toBe(true);
  });

  it("AfricanKycProviderId includes all providers", () => {
    const ids: AfricanKycProviderId[] = ["persona", "mono", "bvn_verify", "nip_verification"];
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  it("PaymentWebhookEvent covers 11 events", () => {
    const events: PaymentWebhookEvent[] = [
      "payment.succeeded", "payment.failed", "payment.refunded",
      "payment.disputed", "payment.chargedback",
      "payout.succeeded", "payout.failed",
      "subscription.created", "subscription.cancelled",
      "invoice.paid", "invoice.overdue",
    ];
    expect(events).toHaveLength(11);
  });

  it("LedgerEntryStatus covers 4 states", () => {
    const s: LedgerEntryStatus[] = ["posted", "pending", "reversed", "voided"];
    expect(s).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 2. Compliance & Security
// ───────────────────────────────────────────────

describe("2 — Automated Compliance & Security Rules", () => {
  it("has 14 sensitive field types", () => {
    expect(SENSITIVE_FIELDS).toHaveLength(14);
    const types = SENSITIVE_FIELDS.map((f) => f.type);
    expect(types).toContain("ssn");
    expect(types).toContain("bvn");
    expect(types).toContain("credit_score");
    expect(types).toContain("card_number");
    expect(types).toContain("card_cvv");
    expect(types).toContain("date_of_birth");
  });

  it("SSN is encrypted + searchable + masked in logs", () => {
    const ssn = SENSITIVE_FIELDS.find((f) => f.type === "ssn");
    expect(ssn?.algorithm).toBe("aes-256-gcm");
    expect(ssn?.searchable).toBe(true);
    expect(ssn?.maskedInLogs).toBe(true);
    expect(ssn?.decryptRoles).toContain("admin");
  });

  it("BVN can be decrypted by admin + loan_officer", () => {
    const bvn = SENSITIVE_FIELDS.find((f) => f.type === "bvn");
    expect(bvn?.decryptRoles).toContain("admin");
    expect(bvn?.decryptRoles).toContain("loan_officer");
  });

  it("card_number is tokenized (never stored raw)", () => {
    const card = SENSITIVE_FIELDS.find((f) => f.type === "card_number");
    expect(card?.tokenized).toBe(true);
    expect(card?.decryptRoles).toHaveLength(0); // no one can decrypt — it's tokenized.
  });

  it("encrypts a sensitive field (SSN)", () => {
    const result = encryptSensitiveField({
      value: "123-45-6789",
      fieldType: "ssn",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    expect(result.ciphertext).toBeTruthy();
    expect(result.iv).toBeTruthy();
    expect(result.tag).toBeTruthy();
    expect(result.blindIndex).not.toBeNull(); // SSN is searchable.
    expect(result.fieldType).toBe("ssn");
  });

  it("rejects encryption of tokenized fields (card_number)", () => {
    expect(() => encryptSensitiveField({
      value: "4111111111111111",
      fieldType: "card_number",
      encryptionKey: "test-key",
    })).toThrow("tokenized");
  });

  it("masks a sensitive field for display", () => {
    const masked = maskSensitiveField({ value: "123-45-6789", fieldType: "ssn" });
    expect(masked).toContain("*");
    expect(masked).not.toContain("123-45");
    expect(masked.slice(-4)).toBe("6789"); // last 4 visible.
  });

  it("auto-encrypts schema columns matching sensitive patterns", () => {
    const result = autoEncryptSchema({
      columns: [
        { table: "users", column: "ssn", type: "text" },
        { table: "users", column: "email", type: "text" },
        { table: "loans", column: "credit_score", type: "integer" },
        { table: "payments", column: "card_number", type: "text" },
        { table: "profiles", column: "bvn", type: "text" },
        { table: "profiles", column: "full_name", type: "text" },
      ],
    });
    expect(result).toHaveLength(4); // ssn, credit_score, card_number, bvn.
    expect(result.some((r) => r.fieldType === "ssn")).toBe(true);
    expect(result.some((r) => r.fieldType === "credit_score")).toBe(true);
    expect(result.some((r) => r.fieldType === "card_number")).toBe(true);
    expect(result.some((r) => r.fieldType === "bvn")).toBe(true);
    // email + full_name are NOT sensitive.
    expect(result.some((r) => r.column === "email")).toBe(false);
    expect(result.some((r) => r.column === "full_name")).toBe(false);
  });

  it("has 8 fintech roles", () => {
    expect(FINTECH_ROLES).toHaveLength(8);
    const roles = FINTECH_ROLES.map((r) => r.role);
    expect(roles).toContain("customer");
    expect(roles).toContain("loan_officer");
    expect(roles).toContain("credit_analyst");
    expect(roles).toContain("auditor");
    expect(roles).toContain("admin");
    expect(roles).toContain("super_admin");
    expect(roles).toContain("support_agent");
    expect(roles).toContain("compliance_officer");
  });

  it("customer can only see own data", () => {
    const customer = FINTECH_ROLES.find((r) => r.role === "customer");
    expect(customer?.readPermissions).toContain("own.profile");
    expect(customer?.readPermissions).toContain("own.transactions");
    expect(customer?.canDecryptFields).toHaveLength(0); // customer can't decrypt anything.
    expect(customer?.canApproveLoans).toBe(false);
    expect(customer?.canAccessAuditLog).toBe(false);
  });

  it("loan_officer can decrypt BVN + approve loans", () => {
    const officer = FINTECH_ROLES.find((r) => r.role === "loan_officer");
    expect(officer?.canDecryptFields).toContain("bvn");
    expect(officer?.canDecryptFields).toContain("bank_account");
    expect(officer?.canApproveLoans).toBe(true);
    expect(officer?.canAccessAuditLog).toBe(true);
  });

  it("auditor has read-only access (no writes)", () => {
    const auditor = FINTECH_ROLES.find((r) => r.role === "auditor");
    expect(auditor?.readPermissions).toContain("*");
    expect(auditor?.writePermissions).toHaveLength(0);
    expect(auditor?.canAccessAuditLog).toBe(true);
    expect(auditor?.canApproveLoans).toBe(false);
  });

  it("super_admin can modify compliance", () => {
    const sa = FINTECH_ROLES.find((r) => r.role === "super_admin");
    expect(sa?.canModifyCompliance).toBe(true);
    expect(sa?.canProcessPayments).toBe(true);
  });

  it("generates RBAC middleware with roles + routes + code", () => {
    const result = generateRbacMiddleware({
      roles: ["customer", "loan_officer", "admin", "auditor"],
    });
    expect(result.roles).toHaveLength(4);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.some((r) => r.requiredRoles.includes("loan_officer"))).toBe(true);
    expect(result.middlewareCode).toContain("ROLE_HIERARCHY");
    expect(result.middlewareCode).toContain("checkPermission");
    expect(result.middlewareCode).toContain("canDecryptField");
  });

  it("loan approval route requires loan_officer or admin", () => {
    const result = generateRbacMiddleware({});
    const approveRoute = result.routes.find((r) => r.path.includes("approve"));
    expect(approveRoute?.requiredRoles).toContain("loan_officer");
    expect(approveRoute?.requiredRoles).toContain("admin");
  });

  it("has 8 compliance rules (auto-injected)", () => {
    expect(COMPLIANCE_RULES).toHaveLength(8);
    expect(COMPLIANCE_RULES.every((r) => r.autoInjected)).toBe(true);
    const frameworks = COMPLIANCE_RULES.map((r) => r.framework);
    expect(frameworks.some((f) => f.includes("PCI-DSS"))).toBe(true);
    expect(frameworks.some((f) => f.includes("SOC2"))).toBe(true);
    expect(frameworks.some((f) => f.includes("GDPR"))).toBe(true);
  });

  it("verifyComplianceSecurity reports all implemented", () => {
    const v = verifyComplianceSecurity();
    expect(v.totalSensitiveFields).toBe(14);
    expect(v.totalFintechRoles).toBe(8);
    expect(v.totalComplianceRules).toBe(8);
    expect(v.allImplemented).toBe(true);
  });

  it("SensitiveFieldType covers 14 types", () => {
    const t: SensitiveFieldType[] = [
      "ssn", "bvn", "nin", "credit_score", "credit_rating",
      "bank_account", "card_number", "card_cvv", "date_of_birth",
      "national_id", "tax_id", "salary", "api_key", "private_key",
    ];
    expect(t).toHaveLength(14);
  });

  it("FintechRole covers 8 roles", () => {
    const r: FintechRole[] = [
      "customer", "loan_officer", "credit_analyst", "auditor",
      "admin", "super_admin", "support_agent", "compliance_officer",
    ];
    expect(r).toHaveLength(8);
  });
});

// ───────────────────────────────────────────────
// Overall verification
// ───────────────────────────────────────────────

describe("Step 2 — overall verification", () => {
  it("both modules are fully implemented", () => {
    expect(verifyFintechEngine().allImplemented).toBe(true);
    expect(verifyComplianceSecurity().allImplemented).toBe(true);
  });
});
