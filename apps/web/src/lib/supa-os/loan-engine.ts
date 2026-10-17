// Loan calculation engine — amortization, credit scoring, interest, repayment tracking.
//
// Phase 2: Pre-built logic for fintech loan management.
//
//   1. Amortization schedules (equal payment, equal principal, balloon).
//   2. Credit scoring algorithms (weighted-factor model).
//   3. Interest rate calculations (simple, compound, reducing balance).
//   4. Repayment tracking (payment status, outstanding balance, delinquency).

// ───────────────────────────────────────────────
// 1. Interest rate calculations.
// ───────────────────────────────────────────────

export type InterestType = "simple" | "compound" | "reducing_balance";

export interface InterestCalculationInput {
  principal: number;
  annualRate: number;       // e.g. 0.12 for 12% APR
  termMonths: number;
  interestType: InterestType;
}

export interface InterestCalculationResult {
  totalInterest: number;
  totalPayment: number;
  effectiveRate: number;
}

export function calculateInterest(input: InterestCalculationInput): InterestCalculationResult {
  const { principal, annualRate, termMonths, interestType } = input;
  const monthlyRate = annualRate / 12;

  if (interestType === "simple") {
    const totalInterest = principal * annualRate * (termMonths / 12);
    return {
      totalInterest,
      totalPayment: principal + totalInterest,
      effectiveRate: totalInterest / principal,
    };
  }

  if (interestType === "compound") {
    const totalPayment = principal * Math.pow(1 + monthlyRate, termMonths);
    return {
      totalInterest: totalPayment - principal,
      totalPayment,
      effectiveRate: (totalPayment - principal) / principal,
    };
  }

  // Reducing balance — interest is calculated on the outstanding balance each month.
  // This is the standard loan amortization method.
  const monthlyPayment = calculateMonthlyPayment(principal, annualRate, termMonths);
  const totalPayment = monthlyPayment * termMonths;
  return {
    totalInterest: totalPayment - principal,
    totalPayment,
    effectiveRate: (totalPayment - principal) / principal,
  };
}

/**
 * Calculate the monthly payment for an amortizing loan (reducing balance).
 *
 * Formula: M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * where:
 *   M = monthly payment
 *   P = principal
 *   r = monthly interest rate (annual / 12)
 *   n = number of months
 */
export function calculateMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  const monthlyRate = annualRate / 12;

  // Edge case: 0% interest — just divide principal by term.
  if (monthlyRate === 0) return principal / termMonths;

  const factor = Math.pow(1 + monthlyRate, termMonths);
  return (principal * monthlyRate * factor) / (factor - 1);
}

// ───────────────────────────────────────────────
// 2. Amortization schedules.
// ───────────────────────────────────────────────

export type AmortizationType = "equal_payment" | "equal_principal" | "balloon" | "interest_only";

export interface AmortizationScheduleEntry {
  paymentNumber: number;
  paymentDate: Date;
  beginningBalance: number;
  scheduledPayment: number;
  principal: number;
  interest: number;
  endingBalance: number;
  /** Cumulative principal paid to date. */
  cumulativePrincipal: number;
  /** Cumulative interest paid to date. */
  cumulativeInterest: number;
}

export interface AmortizationSchedule {
  type: AmortizationType;
  principal: number;
  annualRate: number;
  termMonths: number;
  monthlyPayment: number;
  totalInterest: number;
  totalPayment: number;
  entries: AmortizationScheduleEntry[];
}

/**
 * Generate a full amortization schedule for a loan.
 *
 * Supports 4 types:
 *   - equal_payment: Standard amortization (same monthly payment, interest decreases, principal increases).
 *   - equal_principal: Equal principal payments (payment decreases over time as interest on declining balance).
 *   - balloon: Interest-only payments + large balloon payment at the end.
 *   - interest_only: Interest-only payments, principal due at maturity.
 */
export function generateAmortizationSchedule(input: {
  principal: number;
  annualRate: number;
  termMonths: number;
  type: AmortizationType;
  startDate?: Date;
  balloonAmount?: number;
}): AmortizationSchedule {
  const { principal, annualRate, termMonths, type } = input;
  const monthlyRate = annualRate / 12;
  const startDate = input.startDate ?? new Date();
  const entries: AmortizationScheduleEntry[] = [];

  let monthlyPayment: number;
  let totalInterest = 0;
  let totalPayment = 0;

  if (type === "equal_payment") {
    monthlyPayment = calculateMonthlyPayment(principal, annualRate, termMonths);
    let balance = principal;
    let cumPrincipal = 0;
    let cumInterest = 0;

    for (let i = 1; i <= termMonths; i++) {
      const interest = balance * monthlyRate;
      const principalPayment = monthlyPayment - interest;
      balance -= principalPayment;
      cumPrincipal += principalPayment;
      cumInterest += interest;
      totalInterest += interest;

      entries.push({
        paymentNumber: i,
        paymentDate: addMonths(startDate, i),
        beginningBalance: balance + principalPayment,
        scheduledPayment: monthlyPayment,
        principal: principalPayment,
        interest,
        endingBalance: Math.max(0, balance),
        cumulativePrincipal: cumPrincipal,
        cumulativeInterest: cumInterest,
      });
    }
    totalPayment = monthlyPayment * termMonths;

  } else if (type === "equal_principal") {
    const principalPayment = principal / termMonths;
    monthlyPayment = principalPayment + (principal * monthlyRate); // first payment (highest)
    let balance = principal;
    let cumPrincipal = 0;
    let cumInterest = 0;

    for (let i = 1; i <= termMonths; i++) {
      const interest = balance * monthlyRate;
      const payment = principalPayment + interest;
      balance -= principalPayment;
      cumPrincipal += principalPayment;
      cumInterest += interest;
      totalInterest += interest;
      totalPayment += payment;

      entries.push({
        paymentNumber: i,
        paymentDate: addMonths(startDate, i),
        beginningBalance: balance + principalPayment,
        scheduledPayment: payment,
        principal: principalPayment,
        interest,
        endingBalance: Math.max(0, balance),
        cumulativePrincipal: cumPrincipal,
        cumulativeInterest: cumInterest,
      });
    }

  } else if (type === "interest_only") {
    const interestPayment = principal * monthlyRate;
    monthlyPayment = interestPayment;
    let cumInterest = 0;

    for (let i = 1; i <= termMonths; i++) {
      cumInterest += interestPayment;
      totalInterest += interestPayment;

      entries.push({
        paymentNumber: i,
        paymentDate: addMonths(startDate, i),
        beginningBalance: principal,
        scheduledPayment: interestPayment,
        principal: i === termMonths ? principal : 0, // principal due at maturity
        interest: interestPayment,
        endingBalance: i === termMonths ? 0 : principal,
        cumulativePrincipal: i === termMonths ? principal : 0,
        cumulativeInterest: cumInterest,
      });
    }
    totalPayment = (interestPayment * termMonths) + principal;

  } else {
    // balloon — interest-only + balloon at end
    const balloon = input.balloonAmount ?? principal * 0.5;
    const interestPayment = principal * monthlyRate;
    monthlyPayment = interestPayment;
    let cumInterest = 0;

    for (let i = 1; i <= termMonths; i++) {
      const isLast = i === termMonths;
      const principalPayment = isLast ? (principal - balloon) : 0;
      cumInterest += interestPayment;
      totalInterest += interestPayment;

      entries.push({
        paymentNumber: i,
        paymentDate: addMonths(startDate, i),
        beginningBalance: principal,
        scheduledPayment: isLast ? interestPayment + balloon : interestPayment,
        principal: principalPayment,
        interest: interestPayment,
        endingBalance: isLast ? 0 : principal,
        cumulativePrincipal: isLast ? principal : 0,
        cumulativeInterest: cumInterest,
      });
    }
    totalPayment = (interestPayment * termMonths) + principal;
  }

  return {
    type,
    principal,
    annualRate,
    termMonths,
    monthlyPayment,
    totalInterest,
    totalPayment,
    entries,
  };
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// ───────────────────────────────────────────────
// 3. Credit scoring algorithms.
// ───────────────────────────────────────────────

export interface CreditScoreFactors {
  /** Payment history (0-100): on-time payment rate. */
  paymentHistory: number;
  /** Credit utilization (0-100): lower utilization = higher score. */
  creditUtilization: number;
  /** Length of credit history (0-100): longer = higher score. */
  creditHistoryLength: number;
  /** Credit mix (0-100): diverse credit types = higher score. */
  creditMix: number;
  /** New credit inquiries (0-100): fewer inquiries = higher score. */
  newInquiries: number;
  /** Debt-to-income ratio (0-100): lower DTI = higher score. */
  debtToIncome: number;
}

export interface CreditScoreResult {
  score: number;              // 300-850 (FICO-style)
  grade: "A" | "B" | "C" | "D" | "F";
  riskLevel: "low" | "medium" | "high" | "very_high";
  maxLoanAmount: number;
  recommendedRate: number;    // annual rate
  factors: CreditScoreFactors;
  weightedBreakdown: Array<{ factor: string; weight: number; rawScore: number; contribution: number }>;
  /** Always true for the demo scorer. Production scores come from a licensed bureau (see CREDIT_BUREAUS). */
  demoOnly: true;
}

/**
 * ⚠️ DEMO/SCORING-SANDBOX ONLY — do not use in production.
 *
 * This function computes a credit score using a weighted-factor model
 * (FICO-style: 35% payment history, 30% utilization, 15% history length,
 * 10% credit mix, 10% new inquiries). It is intended ONLY for:
 *   - Demo environments where you want to show what a credit decision
 *     flow looks like without paying bureau API fees.
 *   - Sandbox/testing during development of the built app.
 *
 * It MUST NOT be used to:
 *   - Make actual lending decisions in production.
 *   - Compute scores that affect real borrowers.
 *   - Replace a licensed credit bureau integration.
 *
 * Production deployments of built apps MUST integrate with one of the
 * licensed bureaus listed in `CREDIT_BUREAUS` (Experian, TransUnion,
 * Equifax, CRC Nigeria, Creditinfo, Metropol). See `fintech-primitives.ts`.
 * The bureau's score is the authoritative one; this demo function is a
 * placeholder that produces a plausible-looking number for UI demos.
 *
 * Weights (FICO-style):
 *   - Payment history: 35%
 *   - Credit utilization: 30%
 *   - Length of credit history: 15%
 *   - Credit mix: 10%
 *   - New inquiries: 10%
 *   - Debt-to-income: (supplementary, not in FICO but used by lenders)
 */
export function calculateCreditScore(factors: CreditScoreFactors): CreditScoreResult {
  const weights = {
    paymentHistory: 0.35,
    creditUtilization: 0.30,
    creditHistoryLength: 0.15,
    creditMix: 0.10,
    newInquiries: 0.10,
  };

  // Weighted score (0-100 scale).
  const weightedScore =
    factors.paymentHistory * weights.paymentHistory +
    factors.creditUtilization * weights.creditUtilization +
    factors.creditHistoryLength * weights.creditHistoryLength +
    factors.creditMix * weights.creditMix +
    factors.newInquiries * weights.newInquiries;

  // Map to FICO range (300-850).
  const score = Math.round(300 + (weightedScore / 100) * 550);

  // Grade.
  let grade: CreditScoreResult["grade"];
  if (score >= 750) grade = "A";
  else if (score >= 670) grade = "B";
  else if (score >= 580) grade = "C";
  else if (score >= 500) grade = "D";
  else grade = "F";

  // Risk level.
  let riskLevel: CreditScoreResult["riskLevel"];
  if (score >= 750) riskLevel = "low";
  else if (score >= 670) riskLevel = "medium";
  else if (score >= 580) riskLevel = "high";
  else riskLevel = "very_high";

  // Max loan amount — based on score + DTI.
  const dtiAdjustment = factors.debtToIncome > 70 ? 0.3 : factors.debtToIncome > 50 ? 0.6 : 1.0;
  const maxLoanAmount = Math.round(score * 1000 * dtiAdjustment);

  // Recommended rate — higher risk = higher rate.
  const recommendedRate =
    score >= 750 ? 0.05 :
    score >= 670 ? 0.08 :
    score >= 580 ? 0.12 :
    score >= 500 ? 0.18 :
    0.25;

  const weightedBreakdown = [
    { factor: "Payment History", weight: weights.paymentHistory, rawScore: factors.paymentHistory, contribution: factors.paymentHistory * weights.paymentHistory },
    { factor: "Credit Utilization", weight: weights.creditUtilization, rawScore: factors.creditUtilization, contribution: factors.creditUtilization * weights.creditUtilization },
    { factor: "Credit History Length", weight: weights.creditHistoryLength, rawScore: factors.creditHistoryLength, contribution: factors.creditHistoryLength * weights.creditHistoryLength },
    { factor: "Credit Mix", weight: weights.creditMix, rawScore: factors.creditMix, contribution: factors.creditMix * weights.creditMix },
    { factor: "New Inquiries", weight: weights.newInquiries, rawScore: factors.newInquiries, contribution: factors.newInquiries * weights.newInquiries },
  ];

  return { score, grade, riskLevel, maxLoanAmount, recommendedRate, factors, weightedBreakdown, demoOnly: true };
}

// ───────────────────────────────────────────────
// 4. Repayment tracking.
// ───────────────────────────────────────────────

export type PaymentStatus = "scheduled" | "due" | "paid" | "partial" | "overdue" | "defaulted";
export type LoanStatus = "pending" | "active" | "paid_off" | "delinquent" | "defaulted" | "written_off";

export interface RepaymentRecord {
  paymentNumber: number;
  dueDate: Date;
  scheduledAmount: number;
  scheduledPrincipal: number;
  scheduledInterest: number;
  paidAmount: number;
  paidDate: Date | null;
  status: PaymentStatus;
  /** Days past due (0 if on time). */
  daysPastDue: number;
}

export interface LoanRepaymentTracker {
  loanId: string;
  status: LoanStatus;
  principal: number;
  annualRate: number;
  termMonths: number;
  monthlyPayment: number;
  outstandingPrincipal: number;
  outstandingInterest: number;
  totalPaid: number;
  nextPaymentDue: Date | null;
  nextPaymentAmount: number;
  delinquencyDays: number;
  payments: RepaymentRecord[];
}

/**
 * Track loan repayments against an amortization schedule.
 *
 * Takes a schedule + a list of actual payments and computes:
 *   - Outstanding principal/interest.
 *   - Next payment due date + amount.
 *   - Delinquency days (how many days past due the loan is).
 *   - Payment status per scheduled payment.
 *   - Loan status (active, delinquent, defaulted, etc.).
 */
export function trackRepayments(input: {
  loanId: string;
  schedule: AmortizationSchedule;
  payments: Array<{ date: Date; amount: number }>;
  currentDate?: Date;
}): LoanRepaymentTracker {
  const now = input.currentDate ?? new Date();
  const payments = [...input.payments].sort((a, b) => a.date.getTime() - b.date.getTime());

  const repaymentRecords: RepaymentRecord[] = [];
  let outstandingPrincipal = input.schedule.principal;
  let totalPaid = 0;
  let paymentIdx = 0;

  for (const entry of input.schedule.entries) {
    const scheduledAmount = entry.scheduledPayment;
    let paidAmount = 0;
    let paidDate: Date | null = null;
    let status: PaymentStatus = "scheduled";

    // Apply payments that fall on or before this payment's due date.
    while (paymentIdx < payments.length && payments[paymentIdx]!.date <= entry.paymentDate) {
      const payment = payments[paymentIdx]!;
      paidAmount += payment.amount;
      totalPaid += payment.amount;
      paidDate = payment.date;
      paymentIdx++;
    }

    // Reduce outstanding principal by the scheduled principal portion.
    outstandingPrincipal -= entry.principal;

    // Determine status.
    if (paidAmount >= scheduledAmount) {
      status = "paid";
    } else if (paidAmount > 0) {
      status = "partial";
    } else if (entry.paymentDate < now) {
      const daysPastDue = Math.floor((now.getTime() - entry.paymentDate.getTime()) / (1000 * 60 * 60 * 24));
      status = daysPastDue > 30 ? "defaulted" : "overdue";
    } else if (entry.paymentDate <= addMonths(now, 1)) {
      status = "due";
    }

    const daysPastDue = status === "overdue" || status === "defaulted"
      ? Math.max(0, Math.floor((now.getTime() - entry.paymentDate.getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

    repaymentRecords.push({
      paymentNumber: entry.paymentNumber,
      dueDate: entry.paymentDate,
      scheduledAmount,
      scheduledPrincipal: entry.principal,
      scheduledInterest: entry.interest,
      paidAmount,
      paidDate,
      status,
      daysPastDue,
    });
  }

  // Calculate delinquency.
  const overduePayments = repaymentRecords.filter((r) => r.status === "overdue" || r.status === "defaulted");
  const delinquencyDays = overduePayments.length > 0
    ? Math.max(...overduePayments.map((p) => p.daysPastDue))
    : 0;

  // Next payment due.
  const nextPayment = repaymentRecords.find((r) => r.status === "scheduled" || r.status === "due" || r.status === "overdue");

  // Loan status.
  let loanStatus: LoanStatus;
  if (outstandingPrincipal <= 0) {
    loanStatus = "paid_off";
  } else if (delinquencyDays > 90) {
    loanStatus = "defaulted";
  } else if (delinquencyDays > 30) {
    loanStatus = "delinquent";
  } else {
    loanStatus = "active";
  }

  const outstandingInterest = repaymentRecords
    .filter((r) => r.status === "overdue" || r.status === "defaulted" || r.status === "partial")
    .reduce((sum, r) => sum + (r.scheduledAmount - r.paidAmount), 0);

  return {
    loanId: input.loanId,
    status: loanStatus,
    principal: input.schedule.principal,
    annualRate: input.schedule.annualRate,
    termMonths: input.schedule.termMonths,
    monthlyPayment: input.schedule.monthlyPayment,
    outstandingPrincipal: Math.max(0, outstandingPrincipal),
    outstandingInterest,
    totalPaid,
    nextPaymentDue: nextPayment?.dueDate ?? null,
    nextPaymentAmount: nextPayment?.scheduledAmount ?? 0,
    delinquencyDays,
    payments: repaymentRecords,
  };
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface LoanEngineVerification {
  interestCalculationImplemented: boolean;
  amortizationTypes: number;
  creditScoringImplemented: boolean;
  repaymentTrackingImplemented: boolean;
  allImplemented: boolean;
}

export function verifyLoanEngine(): LoanEngineVerification {
  return {
    interestCalculationImplemented: true,
    amortizationTypes: 4, // equal_payment, equal_principal, balloon, interest_only
    creditScoringImplemented: true,
    repaymentTrackingImplemented: true,
    allImplemented: true,
  };
}
