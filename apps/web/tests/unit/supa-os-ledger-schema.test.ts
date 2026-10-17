/**
 * Supa OS — Double-Entry Ledger Schema — tests.
 *
 * Verifies:
 *   1. Schema tables match the exact spec SQL (accounts, ledger_entries, loan_applications).
 *   2. Double-entry validation (balanced = debits equal credits).
 *   3. Account balance computation (asset vs liability accounts).
 *   4. Post double-entry transaction (creates grouped entries).
 */

import { describe, it, expect } from "vitest";
import {
  SCHEMA_SQL,
  SCHEMA_TABLES,
  validateDoubleEntry,
  postDoubleEntry,
  computeAccountBalance,
  verifyLedgerSchema,
  type Account,
  type NewAccount,
  type LedgerEntry,
  type NewLedgerEntry,
  type LoanApplication,
  type NewLoanApplication,
  type LedgerEntryType,
  type DoubleEntryTransaction,
  type TableSpec,
} from "@/lib/supa-os/ledger-schema";

// ───────────────────────────────────────────────
// 1. Schema matches exact spec SQL
// ───────────────────────────────────────────────

describe("1 — Schema matches exact spec SQL", () => {
  it("has 3 tables (accounts, ledger_entries, loan_applications)", () => {
    expect(SCHEMA_TABLES).toHaveLength(3);
    expect(SCHEMA_TABLES.map((t) => t.name)).toEqual(["accounts", "ledger_entries", "loan_applications"]);
  });

  it("accounts table has 6 columns matching the spec", () => {
    const accountsTable = SCHEMA_TABLES.find((t) => t.name === "accounts")!;
    expect(accountsTable.columns).toHaveLength(6);
    const colNames = accountsTable.columns.map((c) => c.name);
    expect(colNames).toEqual(["id", "user_id", "account_type", "balance", "currency", "created_at"]);
  });

  it("accounts.id is UUID PRIMARY KEY DEFAULT gen_random_uuid()", () => {
    const idCol = SCHEMA_TABLES.find((t) => t.name === "accounts")!.columns.find((c) => c.name === "id")!;
    expect(idCol.type).toBe("UUID");
    expect(idCol.isPrimaryKey).toBe(true);
    expect(idCol.defaultValue).toBe("gen_random_uuid()");
    expect(idCol.nullable).toBe(false);
  });

  it("accounts.balance is DECIMAL(18, 4) NOT NULL DEFAULT 0.0000", () => {
    const balanceCol = SCHEMA_TABLES.find((t) => t.name === "accounts")!.columns.find((c) => c.name === "balance")!;
    expect(balanceCol.type).toBe("DECIMAL(18, 4)");
    expect(balanceCol.nullable).toBe(false);
    expect(balanceCol.defaultValue).toBe("0.0000");
  });

  it("accounts.account_type is VARCHAR(50) with comment listing types", () => {
    const typeCol = SCHEMA_TABLES.find((t) => t.name === "accounts")!.columns.find((c) => c.name === "account_type")!;
    expect(typeCol.type).toBe("VARCHAR(50)");
    expect(typeCol.nullable).toBe(false);
    expect(typeCol.comment).toContain("CHECKING");
    expect(typeCol.comment).toContain("SAVINGS");
    expect(typeCol.comment).toContain("LOAN");
  });

  it("ledger_entries table has 6 columns matching the spec", () => {
    const ledgerTable = SCHEMA_TABLES.find((t) => t.name === "ledger_entries")!;
    expect(ledgerTable.columns).toHaveLength(6);
    const colNames = ledgerTable.columns.map((c) => c.name);
    expect(colNames).toEqual(["id", "transaction_group_id", "account_id", "type", "amount", "created_at"]);
  });

  it("ledger_entries.type has CHECK constraint (DEBIT, CREDIT)", () => {
    const typeCol = SCHEMA_TABLES.find((t) => t.name === "ledger_entries")!.columns.find((c) => c.name === "type")!;
    expect(typeCol.checkConstraint).toBe("type IN ('DEBIT', 'CREDIT')");
  });

  it("ledger_entries.account_id REFERENCES accounts(id)", () => {
    const acctCol = SCHEMA_TABLES.find((t) => t.name === "ledger_entries")!.columns.find((c) => c.name === "account_id")!;
    expect(acctCol.isForeignKey).toBe(true);
    expect(acctCol.references).toBe("accounts(id)");
  });

  it("ledger_entries.amount is DECIMAL(18, 4) NOT NULL", () => {
    const amountCol = SCHEMA_TABLES.find((t) => t.name === "ledger_entries")!.columns.find((c) => c.name === "amount")!;
    expect(amountCol.type).toBe("DECIMAL(18, 4)");
    expect(amountCol.nullable).toBe(false);
  });

  it("loan_applications table has 8 columns matching the spec", () => {
    const loanTable = SCHEMA_TABLES.find((t) => t.name === "loan_applications")!;
    expect(loanTable.columns).toHaveLength(8);
    const colNames = loanTable.columns.map((c) => c.name);
    expect(colNames).toEqual(["id", "user_id", "requested_amount", "term_months", "interest_rate", "status", "risk_score", "created_at"]);
  });

  it("loan_applications.requested_amount is DECIMAL(18, 2) NOT NULL", () => {
    const col = SCHEMA_TABLES.find((t) => t.name === "loan_applications")!.columns.find((c) => c.name === "requested_amount")!;
    expect(col.type).toBe("DECIMAL(18, 2)");
    expect(col.nullable).toBe(false);
  });

  it("loan_applications.interest_rate is DECIMAL(5, 2) NOT NULL", () => {
    const col = SCHEMA_TABLES.find((t) => t.name === "loan_applications")!.columns.find((c) => c.name === "interest_rate")!;
    expect(col.type).toBe("DECIMAL(5, 2)");
    expect(col.nullable).toBe(false);
  });

  it("loan_applications.status DEFAULT 'PENDING' with comment", () => {
    const col = SCHEMA_TABLES.find((t) => t.name === "loan_applications")!.columns.find((c) => c.name === "status")!;
    expect(col.defaultValue).toBe("'PENDING'");
    expect(col.comment).toContain("PENDING");
    expect(col.comment).toContain("APPROVED");
    expect(col.comment).toContain("REJECTED");
  });

  it("loan_applications.risk_score is INT (nullable)", () => {
    const col = SCHEMA_TABLES.find((t) => t.name === "loan_applications")!.columns.find((c) => c.name === "risk_score")!;
    expect(col.type).toBe("INT");
    expect(col.nullable).toBe(true);
    expect(col.defaultValue).toBeNull();
  });

  it("SCHEMA_SQL contains the exact CREATE TABLE statements from the spec", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE accounts");
    expect(SCHEMA_SQL).toContain("CREATE TABLE ledger_entries");
    expect(SCHEMA_SQL).toContain("CREATE TABLE loan_applications");
    // Check exact column definitions from spec.
    expect(SCHEMA_SQL).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(SCHEMA_SQL).toContain("balance DECIMAL(18, 4) NOT NULL DEFAULT 0.0000");
    expect(SCHEMA_SQL).toContain("type VARCHAR(10) CHECK (type IN ('DEBIT', 'CREDIT'))");
    expect(SCHEMA_SQL).toContain("account_id UUID REFERENCES accounts(id)");
    expect(SCHEMA_SQL).toContain("requested_amount DECIMAL(18, 2) NOT NULL");
    expect(SCHEMA_SQL).toContain("term_months INT NOT NULL");
    expect(SCHEMA_SQL).toContain("interest_rate DECIMAL(5, 2) NOT NULL");
    expect(SCHEMA_SQL).toContain("status VARCHAR(20) DEFAULT 'PENDING'");
    expect(SCHEMA_SQL).toContain("risk_score INT");
  });

  it("SCHEMA_SQL includes indexes for performance", () => {
    expect(SCHEMA_SQL).toContain("CREATE INDEX idx_accounts_user_id");
    expect(SCHEMA_SQL).toContain("CREATE INDEX idx_ledger_entries_transaction_group_id");
    expect(SCHEMA_SQL).toContain("CREATE INDEX idx_loan_applications_status");
  });
});

// ───────────────────────────────────────────────
// 2. Double-entry validation
// ───────────────────────────────────────────────

describe("2 — Double-entry validation", () => {
  it("validates a balanced transaction (debits = credits)", () => {
    const txn: DoubleEntryTransaction = {
      transactionGroupId: "grp-1",
      entries: [
        { accountId: "acc-loan", type: "DEBIT", amount: 10000 },
        { accountId: "acc-cash", type: "CREDIT", amount: 10000 },
      ],
      description: "Loan disbursement",
    };
    const result = validateDoubleEntry(txn);
    expect(result.balanced).toBe(true);
    expect(result.totalDebits).toBe(10000);
    expect(result.totalCredits).toBe(10000);
    expect(result.error).toBeNull();
  });

  it("rejects an unbalanced transaction (debits != credits)", () => {
    const txn: DoubleEntryTransaction = {
      transactionGroupId: "grp-2",
      entries: [
        { accountId: "acc-loan", type: "DEBIT", amount: 10000 },
        { accountId: "acc-cash", type: "CREDIT", amount: 5000 },
      ],
      description: "Unbalanced",
    };
    const result = validateDoubleEntry(txn);
    expect(result.balanced).toBe(false);
    expect(result.totalDebits).toBe(10000);
    expect(result.totalCredits).toBe(5000);
    expect(result.error).toContain("not balanced");
  });

  it("rejects a transaction with only 1 entry (needs at least 2)", () => {
    const txn: DoubleEntryTransaction = {
      transactionGroupId: "grp-3",
      entries: [{ accountId: "acc-1", type: "DEBIT", amount: 100 }],
      description: "Single entry",
    };
    const result = validateDoubleEntry(txn);
    expect(result.balanced).toBe(false);
    expect(result.error).toContain("at least 2");
  });

  it("validates a multi-entry balanced transaction (3+ entries)", () => {
    const txn: DoubleEntryTransaction = {
      transactionGroupId: "grp-4",
      entries: [
        { accountId: "acc-cash", type: "DEBIT", amount: 5000 },
        { accountId: "acc-fee", type: "DEBIT", amount: 100 },
        { accountId: "acc-loan", type: "CREDIT", amount: 5100 },
      ],
      description: "Loan repayment with fee",
    };
    const result = validateDoubleEntry(txn);
    expect(result.balanced).toBe(true);
    expect(result.totalDebits).toBe(5100);
    expect(result.totalCredits).toBe(5100);
  });
});

// ───────────────────────────────────────────────
// 3. Post double-entry transaction
// ───────────────────────────────────────────────

describe("3 — Post double-entry transaction", () => {
  it("posts a balanced transaction (loan disbursement)", () => {
    const txn = postDoubleEntry({
      entries: [
        { accountId: "acc-loan", type: "DEBIT", amount: 10000 },
        { accountId: "acc-cash", type: "CREDIT", amount: 10000 },
      ],
      description: "Loan disbursement — $10,000",
    });
    expect(txn.transactionGroupId).toBeTruthy();
    expect(txn.entries).toHaveLength(2);
    expect(txn.description).toContain("Loan disbursement");
  });

  it("throws when posting an unbalanced transaction", () => {
    expect(() => postDoubleEntry({
      entries: [
        { accountId: "acc-loan", type: "DEBIT", amount: 10000 },
        { accountId: "acc-cash", type: "CREDIT", amount: 9000 },
      ],
      description: "Unbalanced",
    })).toThrow("Cannot post unbalanced");
  });

  it("throws when posting a single-entry transaction", () => {
    expect(() => postDoubleEntry({
      entries: [{ accountId: "acc-1", type: "DEBIT", amount: 100 }],
      description: "Single",
    })).toThrow("Cannot post unbalanced");
  });

  it("generates a unique transaction_group_id for each transaction", () => {
    const txn1 = postDoubleEntry({
      entries: [
        { accountId: "acc-1", type: "DEBIT", amount: 100 },
        { accountId: "acc-2", type: "CREDIT", amount: 100 },
      ],
      description: "Transaction 1",
    });
    const txn2 = postDoubleEntry({
      entries: [
        { accountId: "acc-1", type: "DEBIT", amount: 200 },
        { accountId: "acc-2", type: "CREDIT", amount: 200 },
      ],
      description: "Transaction 2",
    });
    expect(txn1.transactionGroupId).not.toBe(txn2.transactionGroupId);
  });
});

// ───────────────────────────────────────────────
// 4. Account balance computation
// ───────────────────────────────────────────────

describe("4 — Account balance computation", () => {
  it("CHECKING account: credits increase, debits decrease", () => {
    const balance = computeAccountBalance({
      entries: [
        { type: "CREDIT", amount: 5000 }, // deposit
        { type: "DEBIT", amount: 1000 },  // withdrawal
        { type: "CREDIT", amount: 500 },  // deposit
      ],
      accountType: "CHECKING",
    });
    expect(balance).toBe(4500); // 5000 - 1000 + 500
  });

  it("SAVINGS account: credits increase, debits decrease", () => {
    const balance = computeAccountBalance({
      entries: [
        { type: "CREDIT", amount: 10000 }, // initial deposit
        { type: "CREDIT", amount: 250 },   // interest
      ],
      accountType: "SAVINGS",
    });
    expect(balance).toBe(10250);
  });

  it("LOAN account: debits increase, credits decrease (customer owes bank)", () => {
    const balance = computeAccountBalance({
      entries: [
        { type: "DEBIT", amount: 10000 },  // loan disbursed (customer owes more)
        { type: "CREDIT", amount: 1000 },  // repayment (customer owes less)
      ],
      accountType: "LOAN",
    });
    expect(balance).toBe(9000); // 10000 - 1000 = 9000 still owed.
  });

  it("empty account has balance 0", () => {
    const balance = computeAccountBalance({
      entries: [],
      accountType: "CHECKING",
    });
    expect(balance).toBe(0);
  });

  it("balance is rounded to 4 decimal places", () => {
    const balance = computeAccountBalance({
      entries: [
        { type: "CREDIT", amount: 100.12345 },
      ],
      accountType: "CHECKING",
    });
    expect(balance).toBe(100.1235); // rounded to 4 decimals.
  });
});

// ───────────────────────────────────────────────
// 5. TypeScript types
// ───────────────────────────────────────────────

describe("5 — TypeScript types", () => {
  it("Account type has all spec fields", () => {
    const account: Account = {
      id: "acc-1",
      userId: "user-1",
      accountType: "CHECKING",
      balance: "5000.0000",
      currency: "USD",
      createdAt: new Date(),
    };
    expect(account.id).toBe("acc-1");
    expect(account.accountType).toBe("CHECKING");
  });

  it("NewAccount type allows partial input (defaults filled by DB)", () => {
    const newAccount: NewAccount = {
      userId: "user-1",
      accountType: "SAVINGS",
    };
    expect(newAccount.userId).toBe("user-1");
    expect(newAccount.accountType).toBe("SAVINGS");
  });

  it("LedgerEntry type has all spec fields", () => {
    const entry: LedgerEntry = {
      id: "le-1",
      transactionGroupId: "grp-1",
      accountId: "acc-1",
      type: "DEBIT",
      amount: "10000.0000",
      createdAt: new Date(),
    };
    expect(entry.type).toBe("DEBIT");
    expect(entry.transactionGroupId).toBe("grp-1");
  });

  it("LoanApplication type has all spec fields", () => {
    const loan: LoanApplication = {
      id: "loan-1",
      userId: "user-1",
      requestedAmount: "10000.00",
      termMonths: 36,
      interestRate: "12.50",
      status: "PENDING",
      riskScore: 720,
      createdAt: new Date(),
    };
    expect(loan.status).toBe("PENDING");
    expect(loan.termMonths).toBe(36);
    expect(loan.interestRate).toBe("12.50");
  });

  it("LedgerEntryType is DEBIT | CREDIT", () => {
    const t1: LedgerEntryType = "DEBIT";
    const t2: LedgerEntryType = "CREDIT";
    expect([t1, t2]).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────
// 6. Verification
// ───────────────────────────────────────────────

describe("6 — Verification", () => {
  it("verifyLedgerSchema reports all implemented", () => {
    const v = verifyLedgerSchema();
    expect(v.totalTables).toBe(3);
    expect(v.totalColumns).toBe(20); // 6 + 6 + 8.
    expect(v.totalIndexes).toBe(6);
    expect(v.totalEnums).toBe(3);
    expect(v.validationFunctionImplemented).toBe(true);
    expect(v.postFunctionImplemented).toBe(true);
    expect(v.balanceFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });
});
