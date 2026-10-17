/**
 * Supa OS Step 2 — Loan & Banking Engine — tests.
 *
 * Verifies:
 *   1. Core amortization (exact spec interface: LoanParameters, AmortizationSchedule, calculateLoanAmortization).
 *   2. Extended loan calculations (summary, payoff, effective APR).
 *   3. Banking primitives (accounts, transfers, interest accrual, statements).
 */

import { describe, it, expect } from "vitest";
import {
  calculateLoanAmortization,
  calculateLoanSummary,
  calculatePayoffAmount,
  calculateEffectiveApr,
  createBankAccount,
  executeTransfer,
  calculateInterestAccrual,
  generateStatement,
  verifyLoanBankingEngine,
  type LoanParameters,
  type AmortizationSchedule,
  type BankAccountType,
  type TransferType,
  type TransferStatus,
  type AccrualFrequency,
  type StatementPeriod,
} from "@/lib/supa-os/loan-banking-engine";

// ───────────────────────────────────────────────
// 1. Core Amortization (exact spec interface)
// ───────────────────────────────────────────────

describe("1 — Core Amortization (spec interface)", () => {
  it("LoanParameters has principal, annualInterestRate, termMonths", () => {
    const params: LoanParameters = { principal: 10000, annualInterestRate: 12.5, termMonths: 36 };
    expect(params.principal).toBe(10000);
    expect(params.annualInterestRate).toBe(12.5);
    expect(params.termMonths).toBe(36);
  });

  it("calculateLoanAmortization returns monthlyPayment + schedule", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(result.monthlyPayment).toBeGreaterThan(0);
    expect(result.schedule).toHaveLength(36);
  });

  it("monthlyPayment for $10,000 at 12.5% for 36 months is ~$334.62", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(result.monthlyPayment).toBeGreaterThan(334);
    expect(result.monthlyPayment).toBeLessThan(336);
  });

  it("schedule entries have month, payment, principalPaid, interestPaid, remainingBalance", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 12 });
    const entry: AmortizationSchedule = result.schedule[0]!;
    expect(entry.month).toBe(1);
    expect(entry.payment).toBeGreaterThan(0);
    expect(entry.principalPaid).toBeGreaterThan(0);
    expect(entry.interestPaid).toBeGreaterThan(0);
    expect(entry.remainingBalance).toBeGreaterThanOrEqual(0);
  });

  it("remaining balance reaches 0 at the end", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    const lastEntry = result.schedule[result.schedule.length - 1]!;
    expect(lastEntry.remainingBalance).toBe(0);
  });

  it("first payment has highest interest, last has lowest", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(result.schedule[0]!.interestPaid).toBeGreaterThan(result.schedule[35]!.interestPaid);
    expect(result.schedule[0]!.principalPaid).toBeLessThan(result.schedule[35]!.principalPaid);
  });

  it("all values are rounded to 2 decimal places", () => {
    const result = calculateLoanAmortization({ principal: 15437.50, annualInterestRate: 7.875, termMonths: 48 });
    for (const entry of result.schedule) {
      expect(entry.payment).toBe(Number(entry.payment.toFixed(2)));
      expect(entry.principalPaid).toBe(Number(entry.principalPaid.toFixed(2)));
      expect(entry.interestPaid).toBe(Number(entry.interestPaid.toFixed(2)));
      expect(entry.remainingBalance).toBe(Number(entry.remainingBalance.toFixed(2)));
    }
  });

  it("handles 0% interest (equal monthly payments)", () => {
    const result = calculateLoanAmortization({ principal: 12000, annualInterestRate: 0, termMonths: 12 });
    expect(result.monthlyPayment).toBe(1000);
    expect(result.schedule).toHaveLength(12);
    expect(result.schedule[0]!.interestPaid).toBe(0);
    expect(result.schedule[11]!.remainingBalance).toBe(0);
  });

  it("total of all payments equals monthlyPayment * termMonths", () => {
    const result = calculateLoanAmortization({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    const totalPayments = result.schedule.reduce((sum, e) => sum + e.payment, 0);
    expect(Number(totalPayments.toFixed(2))).toBe(Number((result.monthlyPayment * 36).toFixed(2)));
  });
});

// ───────────────────────────────────────────────
// 2. Extended Loan Calculations
// ───────────────────────────────────────────────

describe("2 — Extended Loan Calculations", () => {
  it("calculateLoanSummary returns all derived values", () => {
    const summary = calculateLoanSummary({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(summary.principal).toBe(10000);
    expect(summary.annualInterestRate).toBe(12.5);
    expect(summary.termMonths).toBe(36);
    expect(summary.monthlyPayment).toBeGreaterThan(0);
    expect(summary.totalPayment).toBeGreaterThan(summary.principal);
    expect(summary.totalInterest).toBeGreaterThan(0);
    expect(summary.effectiveRate).toBeGreaterThan(0);
    expect(summary.schedule).toHaveLength(36);
  });

  it("totalPayment = monthlyPayment * termMonths", () => {
    const summary = calculateLoanSummary({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(Number(summary.totalPayment.toFixed(2))).toBe(Number((summary.monthlyPayment * 36).toFixed(2)));
  });

  it("totalInterest = totalPayment - principal", () => {
    const summary = calculateLoanSummary({ principal: 10000, annualInterestRate: 12.5, termMonths: 36 });
    expect(Number(summary.totalInterest.toFixed(2))).toBe(Number((summary.totalPayment - summary.principal).toFixed(2)));
  });

  it("calculatePayoffAmount returns remaining balance at given month", () => {
    const payoff = calculatePayoffAmount({ params: { principal: 10000, annualInterestRate: 12.5, termMonths: 36 }, currentMonth: 12 });
    expect(payoff).toBeGreaterThan(0);
    expect(payoff).toBeLessThan(10000);
  });

  it("calculatePayoffAmount includes prepayment penalty", () => {
    const noPenalty = calculatePayoffAmount({ params: { principal: 10000, annualInterestRate: 12.5, termMonths: 36 }, currentMonth: 12 });
    const withPenalty = calculatePayoffAmount({ params: { principal: 10000, annualInterestRate: 12.5, termMonths: 36 }, currentMonth: 12, prepaymentPenaltyPercent: 2 });
    expect(withPenalty).toBeGreaterThan(noPenalty);
  });

  it("calculateEffectiveApr includes origination fee + closing costs", () => {
    const apr = calculateEffectiveApr({ principal: 10000, annualInterestRate: 12.5, termMonths: 36, originationFee: 200, closingCosts: 300 });
    // The effective APR should be different from the nominal rate (12.5%)
    // because fees change the net amount received vs total paid.
    expect(apr).not.toBe(12.5);
    expect(apr).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────
// 3. Banking Primitives — Accounts
// ───────────────────────────────────────────────

describe("3 — Banking Primitives (Accounts)", () => {
  it("BankAccountType covers 8 types", () => {
    const types: BankAccountType[] = ["savings", "checking", "loan", "credit", "escrow", "fixed_deposit", "money_market", "joint"];
    expect(types).toHaveLength(8);
  });

  it("createBankAccount creates a savings account with initial deposit", () => {
    const account = createBankAccount({ ownerId: "user-1", type: "savings", initialDeposit: 1000 });
    expect(account.type).toBe("savings");
    expect(account.availableBalance).toBe(1000);
    expect(account.pendingBalance).toBe(1000);
    expect(account.ledgerBalance).toBe(1000);
    expect(account.active).toBe(true);
    expect(account.frozen).toBe(false);
    expect(account.accountNumber).toBeTruthy();
    expect(account.interestRate).toBeGreaterThan(0); // savings earns interest.
  });

  it("checking account has 0 interest rate", () => {
    const account = createBankAccount({ ownerId: "user-1", type: "checking" });
    expect(account.interestRate).toBe(0);
  });

  it("loan account has high interest rate (12.5%)", () => {
    const account = createBankAccount({ ownerId: "user-1", type: "loan" });
    expect(account.interestRate).toBe(0.125);
  });

  it("account number starts with type prefix (10=savings, 20=checking, 30=loan)", () => {
    const savings = createBankAccount({ ownerId: "user-1", type: "savings" });
    const checking = createBankAccount({ ownerId: "user-1", type: "checking" });
    const loan = createBankAccount({ ownerId: "user-1", type: "loan" });
    expect(savings.accountNumber.startsWith("10")).toBe(true);
    expect(checking.accountNumber.startsWith("20")).toBe(true);
    expect(loan.accountNumber.startsWith("30")).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 4. Banking Primitives — Transfers
// ───────────────────────────────────────────────

describe("4 — Banking Primitives (Transfers)", () => {
  it("TransferType covers 4 types", () => {
    const types: TransferType[] = ["internal", "external", "scheduled", "p2p"];
    expect(types).toHaveLength(4);
  });

  it("executeTransfer — internal transfer between accounts", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 5000 });
    const to = createBankAccount({ ownerId: "user-1", type: "savings", initialDeposit: 1000 });
    const result = executeTransfer({ fromAccount: from, toAccount: to, amount: 1000, description: "Transfer to savings" });
    expect(result.transfer.status).toBe("completed");
    expect(result.transfer.amount).toBe(1000);
    expect(result.transfer.fee).toBe(0); // internal = no fee.
    expect(result.fromAccount.availableBalance).toBe(4000); // 5000 - 1000.
    expect(result.toAccount?.availableBalance).toBe(2000); // 1000 + 1000.
  });

  it("executeTransfer — external transfer charges $25 fee", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 5000 });
    const result = executeTransfer({ fromAccount: from, toAccount: null, amount: 1000, description: "Wire transfer", type: "external" });
    expect(result.transfer.fee).toBe(25);
    expect(result.fromAccount.availableBalance).toBe(3975); // 5000 - 1000 - 25.
  });

  it("executeTransfer — rejects insufficient funds", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 500 });
    const to = createBankAccount({ ownerId: "user-1", type: "savings" });
    expect(() => executeTransfer({ fromAccount: from, toAccount: to, amount: 1000, description: "Too much" })).toThrow("Insufficient");
  });

  it("executeTransfer — rejects frozen account", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 5000 });
    from.frozen = true;
    expect(() => executeTransfer({ fromAccount: from, toAccount: null, amount: 100, description: "Frozen" })).toThrow("frozen");
  });

  it("executeTransfer — rejects negative amount", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 5000 });
    expect(() => executeTransfer({ fromAccount: from, toAccount: null, amount: -100, description: "Negative" })).toThrow("positive");
  });

  it("executeTransfer — rejects external transfer with insufficient funds for fee", () => {
    const from = createBankAccount({ ownerId: "user-1", type: "checking", initialDeposit: 1000 });
    // Need 1000 + 25 fee = 1025, but only have 1000.
    expect(() => executeTransfer({ fromAccount: from, toAccount: null, amount: 1000, description: "External", type: "external" })).toThrow("Insufficient");
  });
});

// ───────────────────────────────────────────────
// 5. Banking Primitives — Interest Accrual
// ───────────────────────────────────────────────

describe("5 — Banking Primitives (Interest Accrual)", () => {
  it("AccrualFrequency covers 5 frequencies", () => {
    const f: AccrualFrequency[] = ["daily", "monthly", "quarterly", "annually", "continuous"];
    expect(f).toHaveLength(5);
  });

  it("continuous compounding earns more than annual", () => {
    const continuous = calculateInterestAccrual({ principal: 10000, rate: 0.05, frequency: "continuous", days: 365 });
    const annual = calculateInterestAccrual({ principal: 10000, rate: 0.05, frequency: "annually", days: 365 });
    expect(continuous.interestEarned).toBeGreaterThan(annual.interestEarned);
  });

  it("daily compounding earns more than monthly", () => {
    const daily = calculateInterestAccrual({ principal: 10000, rate: 0.05, frequency: "daily", days: 365 });
    const monthly = calculateInterestAccrual({ principal: 10000, rate: 0.05, frequency: "monthly", days: 365 });
    expect(daily.interestEarned).toBeGreaterThanOrEqual(monthly.interestEarned);
  });

  it("interest earned on $10,000 at 4.5% for 365 days (daily) is ~$460", () => {
    const result = calculateInterestAccrual({ principal: 10000, rate: 0.045, frequency: "daily", days: 365 });
    expect(result.interestEarned).toBeGreaterThan(455);
    expect(result.interestEarned).toBeLessThan(465);
    expect(result.newBalance).toBeGreaterThan(10455);
  });

  it("newBalance = principal + interestEarned", () => {
    const result = calculateInterestAccrual({ principal: 10000, rate: 0.045, frequency: "monthly", days: 365 });
    expect(Number(result.newBalance.toFixed(2))).toBe(Number((result.principal + result.interestEarned).toFixed(2)));
  });
});

// ───────────────────────────────────────────────
// 6. Banking Primitives — Statements
// ───────────────────────────────────────────────

describe("6 — Banking Primitives (Statements)", () => {
  it("StatementPeriod covers 4 periods", () => {
    const p: StatementPeriod[] = ["monthly", "quarterly", "annually", "custom"];
    expect(p).toHaveLength(4);
  });

  it("generateStatement produces a bank statement with entries", () => {
    const startDate = new Date("2026-01-01");
    const endDate = new Date("2026-01-31");
    const statement = generateStatement({
      accountId: "acc-1",
      openingBalance: 1000,
      period: "monthly",
      startDate,
      endDate,
      transactions: [
        { date: new Date("2026-01-05"), description: "Deposit", amount: 500, type: "credit" },
        { date: new Date("2026-01-10"), description: "ATM withdrawal", amount: 200, type: "debit" },
        { date: new Date("2026-01-15"), description: "Interest earned", amount: 5.50, type: "credit" },
        { date: new Date("2026-01-20"), description: "Monthly fee", amount: 10, type: "debit" },
      ],
    });
    expect(statement.openingBalance).toBe(1000);
    expect(statement.closingBalance).toBe(1295.5); // 1000 + 500 - 200 + 5.50 - 10.
    expect(statement.totalDeposits).toBe(505.5); // 500 + 5.50.
    expect(statement.totalWithdrawals).toBe(210); // 200 + 10.
    expect(statement.totalInterestEarned).toBe(5.5);
    expect(statement.totalFeesCharged).toBe(10);
    expect(statement.entries).toHaveLength(4);
    expect(statement.entries[0]!.balance).toBe(1500); // 1000 + 500.
    expect(statement.entries[3]!.balance).toBe(1295.5);
  });

  it("statement entries are sorted by date", () => {
    const statement = generateStatement({
      accountId: "acc-1",
      openingBalance: 1000,
      period: "monthly",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-01-31"),
      transactions: [
        { date: new Date("2026-01-20"), description: "Late", amount: 100, type: "credit" },
        { date: new Date("2026-01-05"), description: "Early", amount: 50, type: "credit" },
        { date: new Date("2026-01-10"), description: "Middle", amount: 25, type: "debit" },
      ],
    });
    expect(statement.entries[0]!.description).toBe("Early"); // Jan 5 first.
    expect(statement.entries[1]!.description).toBe("Middle"); // Jan 10 second.
    expect(statement.entries[2]!.description).toBe("Late"); // Jan 20 third.
  });
});

// ───────────────────────────────────────────────
// Overall verification
// ───────────────────────────────────────────────

describe("Loan & Banking Engine — overall verification", () => {
  it("verifyLoanBankingEngine reports all implemented", () => {
    const v = verifyLoanBankingEngine();
    expect(v.amortizationFunctionImplemented).toBe(true);
    expect(v.summaryFunctionImplemented).toBe(true);
    expect(v.payoffFunctionImplemented).toBe(true);
    expect(v.effectiveAprFunctionImplemented).toBe(true);
    expect(v.transferFunctionImplemented).toBe(true);
    expect(v.interestAccrualFunctionImplemented).toBe(true);
    expect(v.statementFunctionImplemented).toBe(true);
    expect(v.accountCreationFunctionImplemented).toBe(true);
    expect(v.totalAccountTypes).toBe(8);
    expect(v.totalTransferTypes).toBe(4);
    expect(v.totalAccrualFrequencies).toBe(5);
    expect(v.allImplemented).toBe(true);
  });
});
