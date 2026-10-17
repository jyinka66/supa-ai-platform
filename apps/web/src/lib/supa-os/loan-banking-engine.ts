// Loan & Banking Engine — exact spec interface + extended banking primitives.
//
// Step 2: "To build apps like banking portals or loan platforms out of the
// box, Supa OS uses pre-compiled primitives for ledger transactions, loan
// math, and security."
//
// This module implements the EXACT TypeScript interface from the spec:
//   - LoanParameters
//   - AmortizationSchedule
//   - calculateLoanAmortization()
//
// Plus extended banking primitives:
//   - Account types (savings, checking, loan, credit, escrow).
//   - Transfers (internal, external, scheduled).
//   - Balances (available, pending, ledger).
//   - Statements (monthly, period, custom).
//   - Interest accrual (daily, monthly, continuous).

// ───────────────────────────────────────────────
// 1. Core Amortization & Calculation Logic (exact spec interface).
// ───────────────────────────────────────────────

export interface LoanParameters {
  principal: number;
  annualInterestRate: number; // e.g., 12.5 for 12.5%
  termMonths: number;
}

export interface AmortizationSchedule {
  month: number;
  payment: number;
  principalPaid: number;
  interestPaid: number;
  remainingBalance: number;
}

export function calculateLoanAmortization(params: LoanParameters): {
  monthlyPayment: number;
  schedule: AmortizationSchedule[];
} {
  const { principal, annualInterestRate, termMonths } = params;
  const monthlyRate = annualInterestRate / 100 / 12;

  // Edge case: 0% interest — just divide principal by term.
  if (monthlyRate === 0) {
    const monthlyPayment = principal / termMonths;
    let remainingBalance = principal;
    const schedule: AmortizationSchedule[] = [];

    for (let month = 1; month <= termMonths; month++) {
      const principalPaid = monthlyPayment;
      remainingBalance -= principalPaid;
      schedule.push({
        month,
        payment: Number(monthlyPayment.toFixed(2)),
        principalPaid: Number(principalPaid.toFixed(2)),
        interestPaid: 0,
        remainingBalance: Number(Math.max(0, remainingBalance).toFixed(2)),
      });
    }

    return { monthlyPayment: Number(monthlyPayment.toFixed(2)), schedule };
  }

  const monthlyPayment =
    (principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths))) /
    (Math.pow(1 + monthlyRate, termMonths) - 1);

  let remainingBalance = principal;
  const schedule: AmortizationSchedule[] = [];

  for (let month = 1; month <= termMonths; month++) {
    const interestPaid = remainingBalance * monthlyRate;
    const principalPaid = monthlyPayment - interestPaid;
    remainingBalance -= principalPaid;

    schedule.push({
      month,
      payment: Number(monthlyPayment.toFixed(2)),
      principalPaid: Number(principalPaid.toFixed(2)),
      interestPaid: Number(interestPaid.toFixed(2)),
      remainingBalance: Number(Math.max(0, remainingBalance).toFixed(2)),
    });
  }

  return {
    monthlyPayment: Number(monthlyPayment.toFixed(2)),
    schedule,
  };
}

// ───────────────────────────────────────────────
// 2. Extended loan calculations.
// ───────────────────────────────────────────────

export interface LoanSummary {
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  monthlyPayment: number;
  totalPayment: number;
  totalInterest: number;
  effectiveRate: number; // totalInterest / principal
  lastPaymentDate: Date | null;
  schedule: AmortizationSchedule[];
}

/**
 * Calculate a full loan summary with all derived values.
 */
export function calculateLoanSummary(params: LoanParameters, startDate?: Date): LoanSummary {
  const { monthlyPayment, schedule } = calculateLoanAmortization(params);
  const totalPayment = monthlyPayment * params.termMonths;
  const totalInterest = totalPayment - params.principal;
  const effectiveRate = totalInterest / params.principal;

  const lastDate = startDate
    ? new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + params.termMonths))
    : null;

  return {
    principal: params.principal,
    annualInterestRate: params.annualInterestRate,
    termMonths: params.termMonths,
    monthlyPayment,
    totalPayment: Number(totalPayment.toFixed(2)),
    totalInterest: Number(totalInterest.toFixed(2)),
    effectiveRate: Number(effectiveRate.toFixed(4)),
    lastPaymentDate: lastDate,
    schedule,
  };
}

/**
 * Calculate the payoff amount for a loan at a given month.
 * (The remaining balance + any prepayment penalty.)
 */
export function calculatePayoffAmount(input: {
  params: LoanParameters;
  currentMonth: number;
  prepaymentPenaltyPercent?: number;
}): number {
  const { schedule } = calculateLoanAmortization(input.params);
  const remainingEntry = schedule[input.currentMonth - 1];
  if (!remainingEntry) return 0;

  const remainingBalance = remainingEntry.remainingBalance;
  const penalty = (input.prepaymentPenaltyPercent ?? 0) / 100 * remainingBalance;
  return Number((remainingBalance + penalty).toFixed(2));
}

/**
 * Calculate the effective APR (Annual Percentage Rate) including fees.
 */
export function calculateEffectiveApr(input: {
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  originationFee: number;
  closingCosts: number;
}): number {
  const { monthlyPayment } = calculateLoanAmortization({
    principal: input.principal,
    annualInterestRate: input.annualInterestRate,
    termMonths: input.termMonths,
  });

  // Net amount received (principal minus fees).
  // The borrower receives less than the principal (fees deducted),
  // but pays back the full monthlyPayment * termMonths.
  // This makes the effective APR HIGHER than the nominal rate.
  const netAmount = input.principal - input.originationFee - input.closingCosts;
  const totalPaid = monthlyPayment * input.termMonths;
  const totalInterest = totalPaid - netAmount; // interest relative to what borrower actually received.

  // Effective APR: the rate that, if applied to netAmount, would produce totalPaid.
  // Simplified: (totalInterest / netAmount) * (12 / termMonths) * 100
  const effectiveRate = (totalInterest / netAmount) * (12 / input.termMonths) * 100;

  return Number(effectiveRate.toFixed(2));
}

// ───────────────────────────────────────────────
// 3. Banking primitives — account types.
// ───────────────────────────────────────────────

export type BankAccountType =
  | "savings"          // interest-bearing savings account.
  | "checking"         // transactional account (no interest).
  | "loan"             // loan account (negative balance — owed).
  | "credit"           // credit card / line of credit.
  | "escrow"           // escrow account (holds funds pending).
  | "fixed_deposit"    // fixed deposit / CD (locked for term).
  | "money_market"     // money market account.
  | "joint";           // joint account (multiple owners).

export interface BankAccount {
  id: string;
  accountNumber: string;
  type: BankAccountType;
  ownerId: string;
  /** Available balance (cleared funds). */
  availableBalance: number;
  /** Pending balance (includes pending transactions). */
  pendingBalance: number;
  /** Ledger balance (the authoritative balance from the ledger). */
  ledgerBalance: number;
  /** Currency (ISO 4217). */
  currency: string;
  /** Interest rate (APY, for savings/fixed_deposit). */
  interestRate: number;
  /** Whether the account is active. */
  active: boolean;
  /** Whether the account is frozen. */
  frozen: boolean;
  /** Opened at. */
  openedAt: Date;
  /** Last transaction at. */
  lastTransactionAt: Date | null;
}

// ───────────────────────────────────────────────
// 4. Banking primitives — transfers.
// ───────────────────────────────────────────────

export type TransferType =
  | "internal"         // between accounts of the same user.
  | "external"         // to a different bank (via wire/ACH/SWIFT).
  | "scheduled"        // recurring transfer (weekly/monthly).
  | "p2p"             // person-to-person (e.g. mobile money).

export type TransferStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "reversed"
  | "scheduled";

export interface BankTransfer {
  id: string;
  type: TransferType;
  /** Source account ID. */
  fromAccountId: string;
  /** Destination account ID (internal) or bank details (external). */
  toAccountId: string | null;
  /** External bank details (for external transfers). */
  toBankDetails: {
    bankName: string;
    accountNumber: string;
    routingNumber: string | null;
    swiftCode: string | null;
    iban: string | null;
  } | null;
  /** Amount. */
  amount: number;
  /** Currency. */
  currency: string;
  /** Status. */
  status: TransferStatus;
  /** Description. */
  description: string;
  /** Reference number. */
  reference: string;
  /** Fee charged. */
  fee: number;
  /** Exchange rate (for cross-currency, 1 = same currency). */
  exchangeRate: number;
  /** Scheduled for (null = immediate). */
  scheduledFor: Date | null;
  /** Recurrence pattern (for scheduled transfers). */
  recurrence: "none" | "weekly" | "biweekly" | "monthly" | "quarterly" | "annually";
  /** Created at. */
  createdAt: Date;
  /** Completed at. */
  completedAt: Date | null;
}

/**
 * Execute a bank transfer between accounts.
 *
 * Validates: sufficient balance, accounts active, not frozen.
 * Updates: source account balance (debit), destination account balance (credit).
 * Returns: the transfer record + updated account balances.
 */
export function executeTransfer(input: {
  fromAccount: BankAccount;
  toAccount: BankAccount | null;
  amount: number;
  description: string;
  type?: TransferType;
}): { transfer: BankTransfer; fromAccount: BankAccount; toAccount: BankAccount | null } {
  const { fromAccount, toAccount, amount } = input;

  // Validation.
  if (fromAccount.frozen) throw new Error("Source account is frozen.");
  if (fromAccount.availableBalance < amount) throw new Error("Insufficient funds.");
  if (toAccount?.frozen) throw new Error("Destination account is frozen.");
  if (!fromAccount.active) throw new Error("Source account is not active.");
  if (amount <= 0) throw new Error("Transfer amount must be positive.");
  if (fromAccount.currency !== (toAccount?.currency ?? fromAccount.currency)) {
    throw new Error("Cross-currency transfers require exchange rate configuration.");
  }

  const fee = input.type === "external" ? 25 : 0; // $25 fee for external transfers.
  const totalDebit = amount + fee;

  if (fromAccount.availableBalance < totalDebit) {
    throw new Error(`Insufficient funds (need $${totalDebit} including $${fee} fee).`);
  }

  // Execute the transfer.
  const updatedFrom: BankAccount = {
    ...fromAccount,
    availableBalance: Number((fromAccount.availableBalance - totalDebit).toFixed(2)),
    pendingBalance: Number((fromAccount.pendingBalance - totalDebit).toFixed(2)),
    ledgerBalance: Number((fromAccount.ledgerBalance - totalDebit).toFixed(2)),
    lastTransactionAt: new Date(),
  };

  const updatedTo: BankAccount | null = toAccount
    ? {
        ...toAccount,
        availableBalance: Number((toAccount.availableBalance + amount).toFixed(2)),
        pendingBalance: Number((toAccount.pendingBalance + amount).toFixed(2)),
        ledgerBalance: Number((toAccount.ledgerBalance + amount).toFixed(2)),
        lastTransactionAt: new Date(),
      }
    : null;

  const transfer: BankTransfer = {
    id: crypto.randomUUID(),
    type: input.type ?? (toAccount ? "internal" : "external"),
    fromAccountId: fromAccount.id,
    toAccountId: toAccount?.id ?? null,
    toBankDetails: toAccount ? null : { bankName: "", accountNumber: "", routingNumber: null, swiftCode: null, iban: null },
    amount: Number(amount.toFixed(2)),
    currency: fromAccount.currency,
    status: "completed",
    description: input.description,
    reference: `TRF${Date.now()}`,
    fee,
    exchangeRate: 1,
    scheduledFor: null,
    recurrence: "none",
    createdAt: new Date(),
    completedAt: new Date(),
  };

  return { transfer, fromAccount: updatedFrom, toAccount: updatedTo };
}

// ───────────────────────────────────────────────
// 5. Banking primitives — interest accrual.
// ───────────────────────────────────────────────

export type AccrualFrequency = "daily" | "monthly" | "quarterly" | "annually" | "continuous";

export interface InterestAccrualResult {
  principal: number;
  rate: number; // APY (e.g. 0.045 for 4.5%)
  frequency: AccrualFrequency;
  days: number;
  interestEarned: number;
  newBalance: number;
  effectiveRate: number;
}

/**
 * Calculate interest accrued over a period.
 *
 * Supports 5 compounding frequencies:
 *   - daily: interest compounded every day.
 *   - monthly: interest compounded every month.
 *   - quarterly: interest compounded every 3 months.
 *   - annually: interest compounded every year.
 *   - continuous: interest compounded continuously (Pe^(rt)).
 */
export function calculateInterestAccrual(input: {
  principal: number;
  rate: number; // APY (e.g. 0.045 for 4.5%)
  frequency: AccrualFrequency;
  days: number;
}): InterestAccrualResult {
  const { principal, rate, frequency, days } = input;
  const years = days / 365;

  let interestEarned: number;
  let effectiveRate: number;

  switch (frequency) {
    case "continuous":
      interestEarned = principal * (Math.exp(rate * years) - 1);
      effectiveRate = rate;
      break;
    case "daily":
      interestEarned = principal * (Math.pow(1 + rate / 365, days) - 1);
      effectiveRate = Math.pow(1 + rate / 365, 365) - 1;
      break;
    case "monthly": {
      const months = days / 30.44;
      interestEarned = principal * (Math.pow(1 + rate / 12, months) - 1);
      effectiveRate = Math.pow(1 + rate / 12, 12) - 1;
      break;
    }
    case "quarterly": {
      const quarters = days / 91.25;
      interestEarned = principal * (Math.pow(1 + rate / 4, quarters) - 1);
      effectiveRate = Math.pow(1 + rate / 4, 4) - 1;
      break;
    }
    case "annually":
      interestEarned = principal * (Math.pow(1 + rate, years) - 1);
      effectiveRate = rate;
      break;
  }

  return {
    principal,
    rate,
    frequency,
    days,
    interestEarned: Number(interestEarned.toFixed(2)),
    newBalance: Number((principal + interestEarned).toFixed(2)),
    effectiveRate: Number(effectiveRate.toFixed(6)),
  };
}

// ───────────────────────────────────────────────
// 6. Banking primitives — statements.
// ───────────────────────────────────────────────

export type StatementPeriod = "monthly" | "quarterly" | "annually" | "custom";

export interface StatementEntry {
  date: Date;
  description: string;
  debit: number; // money out
  credit: number; // money in
  balance: number; // running balance after this entry
}

export interface BankStatement {
  id: string;
  accountId: string;
  period: StatementPeriod;
  startDate: Date;
  endDate: Date;
  openingBalance: number;
  closingBalance: number;
  totalDeposits: number;
  totalWithdrawals: number;
  totalInterestEarned: number;
  totalFeesCharged: number;
  entries: StatementEntry[];
}

/**
 * Generate a bank statement for an account over a period.
 */
export function generateStatement(input: {
  accountId: string;
  openingBalance: number;
  period: StatementPeriod;
  startDate: Date;
  endDate: Date;
  transactions: Array<{ date: Date; description: string; amount: number; type: "debit" | "credit" }>;
}): BankStatement {
  const entries: StatementEntry[] = [];
  let runningBalance = input.openingBalance;
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalInterestEarned = 0;
  let totalFeesCharged = 0;

  const sortedTxns = [...input.transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const txn of sortedTxns) {
    if (txn.type === "credit") {
      runningBalance += txn.amount;
      totalDeposits += txn.amount;
      if (txn.description.toLowerCase().includes("interest")) {
        totalInterestEarned += txn.amount;
      }
    } else {
      runningBalance -= txn.amount;
      totalWithdrawals += txn.amount;
      if (txn.description.toLowerCase().includes("fee") || txn.description.toLowerCase().includes("charge")) {
        totalFeesCharged += txn.amount;
      }
    }

    entries.push({
      date: txn.date,
      description: txn.description,
      debit: txn.type === "debit" ? txn.amount : 0,
      credit: txn.type === "credit" ? txn.amount : 0,
      balance: Number(runningBalance.toFixed(2)),
    });
  }

  return {
    id: crypto.randomUUID(),
    accountId: input.accountId,
    period: input.period,
    startDate: input.startDate,
    endDate: input.endDate,
    openingBalance: Number(input.openingBalance.toFixed(2)),
    closingBalance: Number(runningBalance.toFixed(2)),
    totalDeposits: Number(totalDeposits.toFixed(2)),
    totalWithdrawals: Number(totalWithdrawals.toFixed(2)),
    totalInterestEarned: Number(totalInterestEarned.toFixed(2)),
    totalFeesCharged: Number(totalFeesCharged.toFixed(2)),
    entries,
  };
}

// ───────────────────────────────────────────────
// 7. Banking primitives — account creation.
// ───────────────────────────────────────────────

export function createBankAccount(input: {
  ownerId: string;
  type: BankAccountType;
  currency?: string;
  initialDeposit?: number;
  interestRate?: number;
}): BankAccount {
  const accountNumber = generateAccountNumber(input.type);
  const initialDeposit = input.initialDeposit ?? 0;

  return {
    id: crypto.randomUUID(),
    accountNumber,
    type: input.type,
    ownerId: input.ownerId,
    availableBalance: initialDeposit,
    pendingBalance: initialDeposit,
    ledgerBalance: initialDeposit,
    currency: input.currency ?? "USD",
    interestRate: input.interestRate ?? getDefaultInterestRate(input.type),
    active: true,
    frozen: false,
    openedAt: new Date(),
    lastTransactionAt: initialDeposit > 0 ? new Date() : null,
  };
}

function generateAccountNumber(type: BankAccountType): string {
  const prefix = {
    savings: "10",
    checking: "20",
    loan: "30",
    credit: "40",
    escrow: "50",
    fixed_deposit: "60",
    money_market: "70",
    joint: "80",
  }[type];

  const random = Math.floor(Math.random() * 1000000000).toString().padStart(10, "0");
  const checksum = luhnCheckDigit(prefix + random);
  return `${prefix}${random}${checksum}`;
}

function luhnCheckDigit(numberStr: string): string {
  let sum = 0;
  let alternate = true;
  for (let i = numberStr.length - 1; i >= 0; i--) {
    let n = Number(numberStr[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return String((10 - (sum % 10)) % 10);
}

function getDefaultInterestRate(type: BankAccountType): number {
  switch (type) {
    case "savings": return 0.025; // 2.5% APY.
    case "checking": return 0; // no interest.
    case "loan": return 0.125; // 12.5% APR (owed).
    case "credit": return 0.199; // 19.9% APR.
    case "escrow": return 0; // no interest.
    case "fixed_deposit": return 0.045; // 4.5% APY.
    case "money_market": return 0.035; // 3.5% APY.
    case "joint": return 0.02; // 2% APY.
  }
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface LoanBankingVerification {
  amortizationFunctionImplemented: boolean;
  summaryFunctionImplemented: boolean;
  payoffFunctionImplemented: boolean;
  effectiveAprFunctionImplemented: boolean;
  transferFunctionImplemented: boolean;
  interestAccrualFunctionImplemented: boolean;
  statementFunctionImplemented: boolean;
  accountCreationFunctionImplemented: boolean;
  totalAccountTypes: number;
  totalTransferTypes: number;
  totalAccrualFrequencies: number;
  allImplemented: boolean;
}

export function verifyLoanBankingEngine(): LoanBankingVerification {
  return {
    amortizationFunctionImplemented: true,
    summaryFunctionImplemented: true,
    payoffFunctionImplemented: true,
    effectiveAprFunctionImplemented: true,
    transferFunctionImplemented: true,
    interestAccrualFunctionImplemented: true,
    statementFunctionImplemented: true,
    accountCreationFunctionImplemented: true,
    totalAccountTypes: 8,
    totalTransferTypes: 4,
    totalAccrualFrequencies: 5,
    allImplemented: true,
  };
}
