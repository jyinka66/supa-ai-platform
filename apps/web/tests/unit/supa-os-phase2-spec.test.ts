/**
 * Supa OS Phase 2 — Fintech & Loan Engine — tests.
 *
 * Verifies:
 *   1. Fintech primitives: KYC providers, OAuth, payment gateways, ledger.
 *   2. Loan engine: interest calculation, amortization, credit scoring, repayment tracking.
 *   3. Multi-platform output: 7 platform targets + multi-platform project config.
 */

import { describe, it, expect } from "vitest";
import {
  KYC_PROVIDERS,
  OAUTH_PROVIDERS,
  PAYMENT_GATEWAYS,
  STANDARD_CHART_OF_ACCOUNTS,
  verifyLedgerBalance,
  postLedgerTransaction,
  verifyFintechPrimitives,
  type KycProviderId,
  type OAuthProviderId,
  type PaymentGatewayId,
  type LedgerEntryType,
  type LedgerAccountType,
} from "@/lib/supa-os/fintech-primitives";
import {
  calculateInterest,
  calculateMonthlyPayment,
  generateAmortizationSchedule,
  calculateCreditScore,
  trackRepayments,
  verifyLoanEngine,
  type InterestType,
  type AmortizationType,
  type PaymentStatus,
  type LoanStatus,
} from "@/lib/supa-os/loan-engine";
import {
  PLATFORM_OUTPUTS,
  configureMultiPlatformProject,
  verifyMultiPlatform,
  type PlatformOutputId,
} from "@/lib/supa-os/multi-platform-output";

// ───────────────────────────────────────────────
// 1. Fintech Primitives
// ───────────────────────────────────────────────

describe("1 — Fintech Banking Primitives", () => {
  it("has 7 KYC providers", () => {
    expect(KYC_PROVIDERS).toHaveLength(7);
    const ids = KYC_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("persona");
    expect(ids).toContain("smile_identity");
    expect(ids).toContain("veriff");
    expect(ids).toContain("plaid");
    expect(ids).toContain("onfido");
    expect(ids).toContain("sumsub");
    expect(ids).toContain("jumio");
  });

  it("all 7 KYC providers are implemented", () => {
    expect(KYC_PROVIDERS.every((p) => p.implemented)).toBe(true);
  });

  it("Smile Identity is optimized for African markets", () => {
    const smile = KYC_PROVIDERS.find((p) => p.id === "smile_identity");
    expect(smile?.regions).toContain("NG");
    expect(smile?.regions).toContain("KE");
    expect(smile?.regions).toContain("ZA");
  });

  it("Plaid is bank-linked KYC", () => {
    const plaid = KYC_PROVIDERS.find((p) => p.id === "plaid");
    expect(plaid?.bankLinked).toBe(true);
  });

  it("has 7 OAuth providers", () => {
    expect(OAUTH_PROVIDERS).toHaveLength(7);
    const ids = OAUTH_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("google");
    expect(ids).toContain("apple");
    expect(ids).toContain("microsoft");
    expect(ids).toContain("github");
  });

  it("Apple OAuth is fintech-approved (required for iOS)", () => {
    const apple = OAUTH_PROVIDERS.find((p) => p.id === "apple");
    expect(apple?.fintechApproved).toBe(true);
  });

  it("has 8 payment gateways", () => {
    expect(PAYMENT_GATEWAYS).toHaveLength(8);
    const ids = PAYMENT_GATEWAYS.map((p) => p.id);
    expect(ids).toContain("stripe");
    expect(ids).toContain("paystack");
    expect(ids).toContain("flutterwave");
    expect(ids).toContain("razorpay");
    expect(ids).toContain("mercadopago");
    expect(ids).toContain("square");
    expect(ids).toContain("adyen");
    expect(ids).toContain("mollie");
  });

  it("all 8 payment gateways are implemented", () => {
    expect(PAYMENT_GATEWAYS.every((p) => p.implemented)).toBe(true);
  });

  it("Stripe supports payouts (Connect) + subscriptions", () => {
    const stripe = PAYMENT_GATEWAYS.find((p) => p.id === "stripe");
    expect(stripe?.supportsPayouts).toBe(true);
    expect(stripe?.supportsSubscriptions).toBe(true);
  });

  it("Paystack supports mobile money (Africa)", () => {
    const paystack = PAYMENT_GATEWAYS.find((p) => p.id === "paystack");
    expect(paystack?.methods).toContain("mobile_money");
    expect(paystack?.methods).toContain("ussd");
  });

  it("Razorpay supports UPI (India)", () => {
    const razorpay = PAYMENT_GATEWAYS.find((p) => p.id === "razorpay");
    expect(razorpay?.methods).toContain("upi");
  });

  it("has 14 standard chart of accounts", () => {
    expect(STANDARD_CHART_OF_ACCOUNTS).toHaveLength(14);
    expect(STANDARD_CHART_OF_ACCOUNTS.some((a) => a.code === "1000" && a.name.includes("Cash"))).toBe(true);
    expect(STANDARD_CHART_OF_ACCOUNTS.some((a) => a.code === "1100" && a.name.includes("Loans Receivable"))).toBe(true);
    expect(STANDARD_CHART_OF_ACCOUNTS.some((a) => a.code === "4000" && a.name.includes("Interest Income"))).toBe(true);
  });

  it("verifies ledger balance — balanced transaction", () => {
    const txn = postLedgerTransaction({
      entries: [
        { accountId: "1100", type: "debit", amount: 10000, currency: "USD", description: "Loan disbursement" },
        { accountId: "1000", type: "credit", amount: 10000, currency: "USD", description: "Cash out" },
      ],
      description: "Loan disbursement — $10,000",
      sourceType: "loan",
      sourceId: "loan-1",
    });
    expect(txn.balanced).toBe(true);
    expect(verifyLedgerBalance(txn)).toBe(true);
  });

  it("verifies ledger balance — unbalanced transaction", () => {
    const txn = postLedgerTransaction({
      entries: [
        { accountId: "1100", type: "debit", amount: 10000, currency: "USD", description: "Loan disbursement" },
        { accountId: "1000", type: "credit", amount: 5000, currency: "USD", description: "Cash out (wrong)" },
      ],
      description: "Unbalanced — should fail",
      sourceType: "loan",
      sourceId: "loan-2",
    });
    expect(txn.balanced).toBe(false);
  });

  it("verifyFintechPrimitives reports all implemented", () => {
    const v = verifyFintechPrimitives();
    expect(v.kycProviders).toBe(7);
    expect(v.oauthProviders).toBe(7);
    expect(v.paymentGateways).toBe(8);
    expect(v.ledgerAccounts).toBe(14);
    expect(v.allImplemented).toBe(true);
  });

  it("KycProviderId is the union of 7 named ids", () => {
    const ids: KycProviderId[] = ["persona", "smile_identity", "veriff", "plaid", "onfido", "sumsub", "jumio"];
    expect(ids).toHaveLength(7);
  });

  it("PaymentGatewayId is the union of 8 named ids", () => {
    const ids: PaymentGatewayId[] = ["stripe", "paystack", "flutterwave", "razorpay", "mercadopago", "square", "adyen", "mollie"];
    expect(ids).toHaveLength(8);
  });
});

// ───────────────────────────────────────────────
// 2. Loan Calculation Engine
// ───────────────────────────────────────────────

describe("2 — Loan Calculation Engine", () => {
  it("calculates monthly payment for a standard loan", () => {
    // $10,000 at 12% APR for 36 months.
    const payment = calculateMonthlyPayment(10000, 0.12, 36);
    expect(payment).toBeGreaterThan(330);
    expect(payment).toBeLessThan(335);
  });

  it("calculates monthly payment for 0% interest (principal / term)", () => {
    const payment = calculateMonthlyPayment(12000, 0, 12);
    expect(payment).toBe(1000);
  });

  it("calculates simple interest", () => {
    const result = calculateInterest({ principal: 10000, annualRate: 0.12, termMonths: 12, interestType: "simple" });
    expect(result.totalInterest).toBe(1200); // 10000 * 0.12 * 1
    expect(result.totalPayment).toBe(11200);
  });

  it("calculates compound interest", () => {
    const result = calculateInterest({ principal: 10000, annualRate: 0.12, termMonths: 12, interestType: "compound" });
    expect(result.totalInterest).toBeGreaterThan(1200); // compound > simple
    expect(result.totalPayment).toBeGreaterThan(11200);
  });

  it("calculates reducing balance interest", () => {
    const result = calculateInterest({ principal: 10000, annualRate: 0.12, termMonths: 36, interestType: "reducing_balance" });
    expect(result.totalInterest).toBeGreaterThan(0);
    expect(result.totalPayment).toBeGreaterThan(10000);
    expect(result.totalPayment).toBeLessThan(13000); // less than simple over 3 years
  });

  it("generates equal_payment amortization schedule", () => {
    const schedule = generateAmortizationSchedule({
      principal: 10000,
      annualRate: 0.12,
      termMonths: 12,
      type: "equal_payment",
    });
    expect(schedule.entries).toHaveLength(12);
    expect(schedule.entries[0]?.paymentNumber).toBe(1);
    expect(schedule.entries[11]?.endingBalance).toBeCloseTo(0, 0);
    // First payment has highest interest, last has lowest.
    expect(schedule.entries[0]?.interest).toBeGreaterThan(schedule.entries[11]?.interest ?? 0);
  });

  it("generates equal_principal amortization schedule", () => {
    const schedule = generateAmortizationSchedule({
      principal: 12000,
      annualRate: 0.12,
      termMonths: 12,
      type: "equal_principal",
    });
    expect(schedule.entries).toHaveLength(12);
    // Equal principal: principal portion is constant.
    const principal0 = schedule.entries[0]?.principal;
    const principal11 = schedule.entries[11]?.principal;
    expect(principal0).toBeCloseTo(principal11 ?? 0, 0);
    // First payment is highest (more interest on higher balance).
    expect(schedule.entries[0]?.scheduledPayment).toBeGreaterThan(schedule.entries[11]?.scheduledPayment ?? 0);
  });

  it("generates interest_only amortization schedule", () => {
    const schedule = generateAmortizationSchedule({
      principal: 10000,
      annualRate: 0.12,
      termMonths: 12,
      type: "interest_only",
    });
    expect(schedule.entries).toHaveLength(12);
    // Interest-only: all payments are interest, principal due at maturity.
    expect(schedule.entries[0]?.principal).toBe(0);
    expect(schedule.entries[11]?.principal).toBe(10000); // principal at maturity
    expect(schedule.entries[11]?.endingBalance).toBe(0);
  });

  it("generates balloon amortization schedule", () => {
    const schedule = generateAmortizationSchedule({
      principal: 10000,
      annualRate: 0.12,
      termMonths: 12,
      type: "balloon",
      balloonAmount: 5000,
    });
    expect(schedule.entries).toHaveLength(12);
    // Last payment includes balloon.
    expect(schedule.entries[11]?.scheduledPayment).toBeGreaterThan(schedule.entries[0]?.scheduledPayment ?? 0);
  });

  it("calculates credit score — high credit (A grade)", () => {
    const result = calculateCreditScore({
      paymentHistory: 95,
      creditUtilization: 80,
      creditHistoryLength: 90,
      creditMix: 70,
      newInquiries: 90,
      debtToIncome: 80,
    });
    expect(result.score).toBeGreaterThanOrEqual(750);
    expect(result.grade).toBe("A");
    expect(result.riskLevel).toBe("low");
    expect(result.recommendedRate).toBe(0.05); // 5% for A-grade
  });

  it("calculates credit score — low credit (D/F grade)", () => {
    const result = calculateCreditScore({
      paymentHistory: 40,
      creditUtilization: 30,
      creditHistoryLength: 20,
      creditMix: 20,
      newInquiries: 30,
      debtToIncome: 20,
    });
    expect(result.score).toBeLessThan(600);
    expect(["D", "F"]).toContain(result.grade);
    expect(["high", "very_high"]).toContain(result.riskLevel);
    expect(result.recommendedRate).toBeGreaterThanOrEqual(0.18); // 18%+ for high risk
  });

  it("credit score weighted breakdown sums to ~100%", () => {
    const result = calculateCreditScore({
      paymentHistory: 80,
      creditUtilization: 70,
      creditHistoryLength: 60,
      creditMix: 50,
      newInquiries: 80,
      debtToIncome: 70,
    });
    const totalWeight = result.weightedBreakdown.reduce((sum, f) => sum + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 2); // weights sum to 1.0
  });

  it("max loan amount is reduced for high DTI", () => {
    const lowDti = calculateCreditScore({
      paymentHistory: 90, creditUtilization: 80, creditHistoryLength: 80,
      creditMix: 70, newInquiries: 80, debtToIncome: 30, // LOW DTI = higher score factor
    });
    const highDti = calculateCreditScore({
      paymentHistory: 90, creditUtilization: 80, creditHistoryLength: 80,
      creditMix: 70, newInquiries: 80, debtToIncome: 80, // HIGH DTI = lower max loan
    });
    // Higher DTI reduces max loan amount (dtiAdjustment is lower).
    expect(lowDti.maxLoanAmount).toBeGreaterThan(highDti.maxLoanAmount);
  });

  it("tracks repayments — active loan", () => {
    const startDate = new Date("2026-01-01T00:00:00.000Z");
    const schedule = generateAmortizationSchedule({
      principal: 12000,
      annualRate: 0.12,
      termMonths: 12,
      type: "equal_payment",
      startDate,
    });
    // Make the first 3 scheduled payments on their exact due dates.
    const payments = schedule.entries.slice(0, 3).map((entry) => ({
      date: entry.paymentDate,
      amount: entry.scheduledPayment,
    }));
    const tracker = trackRepayments({
      loanId: "loan-1",
      schedule,
      payments,
      currentDate: addMonths(startDate, 4),
    });
    expect(tracker.status).toBe("active");
    expect(tracker.totalPaid).toBeCloseTo(schedule.monthlyPayment * 3, 0);
    expect(tracker.outstandingPrincipal).toBeLessThan(12000);
    expect(tracker.delinquencyDays).toBe(0);
    expect(tracker.nextPaymentDue).not.toBeNull();
  });

  it("tracks repayments — paid off loan", () => {
    const schedule = generateAmortizationSchedule({
      principal: 12000,
      annualRate: 0,
      termMonths: 12,
      type: "equal_principal",
    });
    // Make all 12 payments.
    const payments = schedule.entries.map((e) => ({ date: e.paymentDate, amount: e.scheduledPayment }));
    const tracker = trackRepayments({
      loanId: "loan-2",
      schedule,
      payments,
      currentDate: addMonths(new Date(), 13),
    });
    expect(tracker.status).toBe("paid_off");
    expect(tracker.outstandingPrincipal).toBeLessThanOrEqual(1); // near zero (rounding)
  });

  it("tracks repayments — delinquent loan (missed payments)", () => {
    const schedule = generateAmortizationSchedule({
      principal: 12000,
      annualRate: 0.12,
      termMonths: 12,
      type: "equal_payment",
    });
    // No payments made — 60 days past first due date.
    const tracker = trackRepayments({
      loanId: "loan-3",
      schedule,
      payments: [],
      currentDate: addMonths(new Date(), 3), // 3 months in, no payments
    });
    expect(tracker.status).toBe("delinquent");
    expect(tracker.delinquencyDays).toBeGreaterThan(30);
    expect(tracker.payments.filter((p) => p.status === "overdue" || p.status === "defaulted").length).toBeGreaterThan(0);
  });

  it("verifyLoanEngine reports all implemented", () => {
    const v = verifyLoanEngine();
    expect(v.allImplemented).toBe(true);
    expect(v.amortizationTypes).toBe(4);
  });

  it("InterestType is the union of 3 types", () => {
    const t: InterestType[] = ["simple", "compound", "reducing_balance"];
    expect(t).toHaveLength(3);
  });

  it("AmortizationType is the union of 4 types", () => {
    const t: AmortizationType[] = ["equal_payment", "equal_principal", "balloon", "interest_only"];
    expect(t).toHaveLength(4);
  });

  it("LoanStatus covers all states", () => {
    const s: LoanStatus[] = ["pending", "active", "paid_off", "delinquent", "defaulted", "written_off"];
    expect(s).toHaveLength(6);
  });
});

// ───────────────────────────────────────────────
// 3. Multi-Platform Output
// ───────────────────────────────────────────────

describe("3 — Multi-Platform Output", () => {
  it("has 7 platform output targets", () => {
    expect(PLATFORM_OUTPUTS).toHaveLength(7);
    const ids = PLATFORM_OUTPUTS.map((p) => p.id);
    expect(ids).toContain("web_nextjs");
    expect(ids).toContain("web_react");
    expect(ids).toContain("mobile_flutter");
    expect(ids).toContain("mobile_rn");
    expect(ids).toContain("backend_node");
    expect(ids).toContain("backend_python");
    expect(ids).toContain("backend_go");
  });

  it("all 7 targets are implemented", () => {
    expect(PLATFORM_OUTPUTS.every((p) => p.implemented)).toBe(true);
  });

  it("has 2 web targets + 2 mobile targets + 3 backend targets", () => {
    const v = verifyMultiPlatform();
    expect(v.webTargets).toBe(2);
    expect(v.mobileTargets).toBe(2);
    // web_nextjs is both frontend + backend, so backendTargets counts it too.
    expect(v.backendTargets).toBeGreaterThanOrEqual(3);
  });

  it("all targets are fintech-ready", () => {
    expect(PLATFORM_OUTPUTS.every((p) => p.fintechReady)).toBe(true);
  });

  it("Flutter uses Dart, React Native uses TypeScript", () => {
    const flutter = PLATFORM_OUTPUTS.find((p) => p.id === "mobile_flutter");
    expect(flutter?.language).toBe("Dart");
    const rn = PLATFORM_OUTPUTS.find((p) => p.id === "mobile_rn");
    expect(rn?.language).toBe("TypeScript");
  });

  it("backend_python uses FastAPI", () => {
    const python = PLATFORM_OUTPUTS.find((p) => p.id === "backend_python");
    expect(python?.framework).toContain("FastAPI");
  });

  it("backend_go uses Gin", () => {
    const go = PLATFORM_OUTPUTS.find((p) => p.id === "backend_go");
    expect(go?.framework).toContain("Gin");
  });

  it("configures multi-platform project (web + mobile)", () => {
    const project = configureMultiPlatformProject({
      primary: "web_nextjs",
      secondary: ["mobile_flutter"],
    });
    expect(project.primary.id).toBe("web_nextjs");
    expect(project.secondary).toHaveLength(1);
    expect(project.secondary[0]?.id).toBe("mobile_flutter");
    expect(project.isMultiPlatform).toBe(true);
    expect(project.sharedApiContract).toBe(true);
    expect(project.totalEstimatedLines).toBeGreaterThan(0);
  });

  it("configures single-platform project (web only)", () => {
    const project = configureMultiPlatformProject({
      primary: "web_nextjs",
    });
    expect(project.isMultiPlatform).toBe(false);
    expect(project.secondary).toHaveLength(0);
  });

  it("verifyMultiPlatform reports all implemented", () => {
    const v = verifyMultiPlatform();
    expect(v.totalTargets).toBe(7);
    expect(v.allImplemented).toBe(true);
  });

  it("PlatformOutputId is the union of 7 named ids", () => {
    const ids: PlatformOutputId[] = [
      "web_nextjs", "web_react", "mobile_flutter", "mobile_rn",
      "backend_node", "backend_python", "backend_go",
    ];
    expect(ids).toHaveLength(7);
  });
});

// ───────────────────────────────────────────────
// Helper
// ───────────────────────────────────────────────

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}
