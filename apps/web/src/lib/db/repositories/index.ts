/**
 * Repository barrel — the ONLY layer that touches the DB.
 *
 * The lint rule LINT_RULE_NO_RAW_DB_ACCESS (from @supa/workspace-core)
 * enforces that no code outside repositories/ imports the db or
 * schema directly. Every route handler + service layer goes through
 * these repository classes.
 *
 * Cross-tenant isolation is enforced by 3 gates:
 *   1. Structural — lint rule (no raw DB access outside repositories)
 *   2. Runtime — RLS policies at the DB
 *   3. Regression — cross-tenant isolation property tests
 */

export { PostgresNumberAllocator } from "./number-allocator.js";
export { InvoiceRepositoryImpl } from "./invoice-repository.js";
export { CreditNoteRepositoryImpl } from "./credit-note-repository.js";
export { CustomerRepositoryImpl } from "./customer-repository.js";
export { ActivityRepositoryImpl } from "./activity-repository.js";
export { DealRepositoryImpl } from "./deal-repository.js";
export { ExpenseRepositoryImpl } from "./expense-repository.js";
export { MergeRepositoryImpl } from "./merge-repository.js";
export { ImportRepositoryImpl } from "./import-repository.js";
export { ApprovalRepositoryImpl } from "./approval-repository.js";
export { ReceiptRepositoryImpl } from "./receipt-repository.js";
export { ConvertRepositoryImpl } from "./convert-repository.js";
export { ReportFactRepositoryImpl } from "./report-fact-repository.js";
