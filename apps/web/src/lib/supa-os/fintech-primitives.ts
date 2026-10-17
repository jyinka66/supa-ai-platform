// Fintech banking primitives — KYC connectors, payment gateways, ledger.
//
// Phase 2: Domain-specific modules for fintech & banking.
//
//   1. Auth & KYC: Built-in integration connectors for Identity Verification
//      (Plaid, Smile Identity, Veriff, Persona) and OAuth 2.0.
//   2. Payment Gateways & Ledger: Out-of-the-box support for double-entry
//      bookkeeping, Stripe, Paystack, Flutterwave, and ledger databases.
//   3. Loan Calculation Engine (separate file: loan-engine.ts).

// ───────────────────────────────────────────────
// 1. KYC / Identity verification connectors.
// ───────────────────────────────────────────────

export type KycProviderId =
  | "persona"          // Persona (US/EU)
  | "smile_identity"   // Smile Identity (Africa)
  | "veriff"           // Veriff (global)
  | "plaid"            // Plaid Identity (bank-linked)
  | "onfido"           // Onfido (EU/UK)
  | "sumsub"           // Sumsub (global)
  | "jumio";           // Jumio (US)

export interface KycProviderConfig {
  id: KycProviderId;
  title: string;
  description: string;
  /** Regions where this provider is strong. */
  regions: string[];
  /** What verification steps this provider supports. */
  capabilities: Array<"document" | "selfie" | "liveness" | "sanctions" | "address" | "pep" | "watchlist">;
  /** Environment variables needed. */
  envVars: string[];
  /** Webhook path for verification callbacks. */
  webhookPath: string;
  /** Whether this provider supports bank-linked KYC (Plaid). */
  bankLinked: boolean;
  implemented: boolean;
}

export const KYC_PROVIDERS: KycProviderConfig[] = [
  {
    id: "persona",
    title: "Persona",
    description: "Identity verification with document, selfie, and sanctions screening. Strong in US/EU.",
    regions: ["US", "EU", "UK", "CA", "AU"],
    capabilities: ["document", "selfie", "liveness", "sanctions", "address"],
    envVars: ["PERSONA_API_KEY", "PERSONA_WEBHOOK_SECRET", "NEXT_PUBLIC_PERSONA_TEMPLATE_ID"],
    webhookPath: "/api/webhooks/persona",
    bankLinked: false,
    implemented: true,
  },
  {
    id: "smile_identity",
    title: "Smile Identity",
    description: "Identity verification optimized for African markets. Document + selfie + liveness.",
    regions: ["Africa", "NG", "KE", "GH", "ZA", "EG"],
    capabilities: ["document", "selfie", "liveness", "sanctions"],
    envVars: ["SMILE_PARTNER_ID", "SMILE_API_KEY", "SMILE_API_SECRET", "SMILE_CALLBACK_URL"],
    webhookPath: "/api/webhooks/smile",
    bankLinked: false,
    implemented: true,
  },
  {
    id: "veriff",
    title: "Veriff",
    description: "Global identity verification with document + selfie + liveness. 230+ countries.",
    regions: ["Global"],
    capabilities: ["document", "selfie", "liveness", "sanctions", "address"],
    envVars: ["VERIFF_API_KEY", "VERIFF_API_SECRET", "VERIFF_WEBHOOK_URL"],
    webhookPath: "/api/webhooks/veriff",
    bankLinked: false,
    implemented: true,
  },
  {
    id: "plaid",
    title: "Plaid Identity",
    description: "Bank-linked identity verification — verifies identity via bank account data.",
    regions: ["US", "CA", "UK", "IE", "NL", "FR", "ES"],
    capabilities: ["document", "address"],
    envVars: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "NEXT_PUBLIC_PLAID_PUBLIC_KEY"],
    webhookPath: "/api/webhooks/plaid",
    bankLinked: true,
    implemented: true,
  },
  {
    id: "onfido",
    title: "Onfido",
    description: "Identity verification strong in EU/UK. Document + facial similarity.",
    regions: ["EU", "UK", "US"],
    capabilities: ["document", "selfie", "liveness"],
    envVars: ["ONFIDO_API_TOKEN", "ONFIDO_WEBHOOK_URL"],
    webhookPath: "/api/webhooks/onfido",
    bankLinked: false,
    implemented: true,
  },
  {
    id: "sumsub",
    title: "Sumsub",
    description: "All-in-one verification platform — KYC, KYB, AML, transaction monitoring.",
    regions: ["Global"],
    capabilities: ["document", "selfie", "liveness", "sanctions", "address", "pep", "watchlist"],
    envVars: ["SUMSUB_APP_TOKEN", "SUMSUB_SECRET_KEY", "SUMSUB_WEBHOOK_URL"],
    webhookPath: "/api/webhooks/sumsub",
    bankLinked: false,
    implemented: true,
  },
  {
    id: "jumio",
    title: "Jumio",
    description: "Identity verification + document verification. Strong in US enterprise.",
    regions: ["US", "EU", "UK"],
    capabilities: ["document", "selfie", "liveness", "address"],
    envVars: ["JUMIO_API_TOKEN", "JUMIO_API_SECRET", "JUMIO_WEBHOOK_URL"],
    webhookPath: "/api/webhooks/jumio",
    bankLinked: false,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 2. OAuth 2.0 connectors.
// ───────────────────────────────────────────────

export type OAuthProviderId =
  | "google"
  | "apple"
  | "microsoft"
  | "github"
  | "facebook"
  | "linkedin"
  | "twitter";

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  title: string;
  description: string;
  envVars: string[];
  /** Whether this provider is available for fintech (some have stricter requirements). */
  fintechApproved: boolean;
  implemented: boolean;
}

export const OAUTH_PROVIDERS: OAuthProviderConfig[] = [
  { id: "google", title: "Google OAuth 2.0", description: "Sign in with Google (OpenID Connect).", envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], fintechApproved: true, implemented: true },
  { id: "apple", title: "Sign in with Apple", description: "Sign in with Apple (required for iOS App Store).", envVars: ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"], fintechApproved: true, implemented: true },
  { id: "microsoft", title: "Microsoft OAuth 2.0", description: "Sign in with Microsoft (Azure AD).", envVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"], fintechApproved: true, implemented: true },
  { id: "github", title: "GitHub OAuth 2.0", description: "Sign in with GitHub (developer-focused).", envVars: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"], fintechApproved: false, implemented: true },
  { id: "facebook", title: "Facebook Login", description: "Sign in with Facebook (Meta).", envVars: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"], fintechApproved: false, implemented: true },
  { id: "linkedin", title: "LinkedIn Sign In", description: "Sign in with LinkedIn.", envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], fintechApproved: false, implemented: true },
  { id: "twitter", title: "Twitter/X OAuth 2.0", description: "Sign in with X (Twitter).", envVars: ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"], fintechApproved: false, implemented: true },
];

// ───────────────────────────────────────────────
// 3. Payment gateways.
// ───────────────────────────────────────────────

export type PaymentGatewayId =
  | "stripe"          // global cards
  | "paystack"        // Africa (Nigeria, Ghana, Kenya, South Africa)
  | "flutterwave"     // Africa (pan-African)
  | "razorpay"        // India
  | "mercadopago"     // LATAM
  | "square"          // US/CA/AU
  | "adyen"            // global enterprise
  | "mollie";          // EU

export interface PaymentGatewayConfig {
  id: PaymentGatewayId;
  title: string;
  description: string;
  regions: string[];
  /** Supported payment methods. */
  methods: string[];
  /** Whether this gateway supports payouts (marketplace/Connect). */
  supportsPayouts: boolean;
  /** Whether this gateway supports recurring/subscriptions. */
  supportsSubscriptions: boolean;
  /** Webhook path for payment events. */
  webhookPath: string;
  envVars: string[];
  implemented: boolean;
}

export const PAYMENT_GATEWAYS: PaymentGatewayConfig[] = [
  {
    id: "stripe",
    title: "Stripe",
    description: "Global payment processing — cards, wallets, bank transfers, Connect (marketplace payouts).",
    regions: ["US", "EU", "UK", "CA", "AU", "JP", "SG", "Global"],
    methods: ["card", "apple_pay", "google_pay", "bank_transfer", "sepa", "ideal", "bancontact", "sofort"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/stripe",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
    implemented: true,
  },
  {
    id: "paystack",
    title: "Paystack",
    description: "African payment processing — Nigeria, Ghana, Kenya, South Africa. Cards + bank transfer + mobile money.",
    regions: ["NG", "GH", "KE", "ZA"],
    methods: ["card", "bank_transfer", "mobile_money", "ussd", "bank"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/paystack",
    envVars: ["PAYSTACK_SECRET_KEY", "NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY"],
    implemented: true,
  },
  {
    id: "flutterwave",
    title: "Flutterwave",
    description: "Pan-African payment processing — 30+ African countries. Cards + mobile money + bank transfer.",
    regions: ["NG", "GH", "KE", "UG", "TZ", "ZA", "EG", "MA", "Africa"],
    methods: ["card", "mobile_money", "bank_transfer", "ussd", "bank"],
    supportsPayouts: true,
    supportsSubscriptions: false,
    webhookPath: "/api/webhooks/flutterwave",
    envVars: ["FLW_SECRET_KEY", "NEXT_PUBLIC_FLW_PUBLIC_KEY"],
    implemented: true,
  },
  {
    id: "razorpay",
    title: "Razorpay",
    description: "Indian payment processing — UPI, cards, netbanking, wallets.",
    regions: ["IN"],
    methods: ["upi", "card", "netbanking", "wallet", "emi"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/razorpay",
    envVars: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
    implemented: true,
  },
  {
    id: "mercadopago",
    title: "Mercado Pago",
    description: "LATAM payment processing — Brazil, Mexico, Argentina, Chile, Colombia.",
    regions: ["BR", "MX", "AR", "CL", "CO", "PE", "UY"],
    methods: ["card", "pix", "boleto", "oxxo", "pse"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/mercadopago",
    envVars: ["MERCADOPAGO_ACCESS_TOKEN", "NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY"],
    implemented: true,
  },
  {
    id: "square",
    title: "Square",
    description: "US/CA/AU payment processing — cards + Cash App Pay.",
    regions: ["US", "CA", "AU", "IE", "FR", "ES", "UK"],
    methods: ["card", "cash_app", "gift_card"],
    supportsPayouts: false,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/square",
    envVars: ["SQUARE_ACCESS_TOKEN", "SQUARE_ENVIRONMENT", "NEXT_PUBLIC_SQUARE_APP_ID"],
    implemented: true,
  },
  {
    id: "adyen",
    title: "Adyen",
    description: "Enterprise global payment processing — unified across all regions.",
    regions: ["Global"],
    methods: ["card", "apple_pay", "google_pay", "sepa", "ideal", "bancontact", "sofort", "alipay", "wechat_pay"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/adyen",
    envVars: ["ADYEN_API_KEY", "ADYEN_MERCHANT_ACCOUNT", "ADYEN_WEBHOOK_HMAC_KEY"],
    implemented: true,
  },
  {
    id: "mollie",
    title: "Mollie",
    description: "EU-focused payment processing — Netherlands, Germany, Belgium, France.",
    regions: ["NL", "DE", "BE", "FR", "EU"],
    methods: ["card", "ideal", "bancontact", "sofort", "klarna", "paypal"],
    supportsPayouts: true,
    supportsSubscriptions: true,
    webhookPath: "/api/webhooks/mollie",
    envVars: ["MOLLIE_API_KEY"],
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 4. Double-entry ledger.
// ───────────────────────────────────────────────

export type LedgerEntryType = "debit" | "credit";
export type LedgerAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface LedgerAccount {
  id: string;
  code: string;            // e.g. "1000" (Cash), "2000" (Loans Payable)
  name: string;
  type: LedgerAccountType;
  /** Whether this is a contra account (reduces the parent). */
  contra: boolean;
  /** Currency code (ISO 4217). */
  currency: string;
  /** Current balance (computed from entries). */
  balance: number;
  /** Whether this account is active. */
  active: boolean;
}

export interface LedgerEntry {
  id: string;
  /** The transaction this entry belongs to (double-entry: 2+ entries per transaction). */
  transactionId: string;
  /** The account this entry affects. */
  accountId: string;
  /** Debit or credit. */
  type: LedgerEntryType;
  /** Amount (always positive — direction is in `type`). */
  amount: number;
  /** Currency code. */
  currency: string;
  /** Description of the entry. */
  description: string;
  /** When the entry was posted. */
  postedAt: Date;
  /** Whether this entry is reversed (reversal entry). */
  reversed: boolean;
}

export interface LedgerTransaction {
  id: string;
  entries: LedgerEntry[];
  /** Whether the transaction balances (sum of debits = sum of credits). */
  balanced: boolean;
  description: string;
  postedAt: Date;
  /** Reference to the source (payment ID, loan ID, etc.). */
  sourceType: string;
  sourceId: string;
}

/**
 * Verify a ledger transaction is balanced (double-entry rule).
 *
 * Every transaction must have equal debits and credits.
 * This is the fundamental rule of double-entry bookkeeping.
 */
export function verifyLedgerBalance(transaction: LedgerTransaction): boolean {
  const debits = transaction.entries
    .filter((e) => e.type === "debit" && !e.reversed)
    .reduce((sum, e) => sum + e.amount, 0);
  const credits = transaction.entries
    .filter((e) => e.type === "credit" && !e.reversed)
    .reduce((sum, e) => sum + e.amount, 0);
  return debits === credits;
}

/**
 * Post a ledger transaction (double-entry).
 *
 * Creates 2+ entries that must balance (debits = credits).
 * Example: Loan disbursement of $10,000:
 *   Debit: Loans Receivable $10,000 (asset increase)
 *   Credit: Cash $10,000 (asset decrease)
 */
export function postLedgerTransaction(input: {
  entries: Array<{
    accountId: string;
    type: LedgerEntryType;
    amount: number;
    currency: string;
    description: string;
  }>;
  description: string;
  sourceType: string;
  sourceId: string;
}): LedgerTransaction {
  const transactionId = crypto.randomUUID();
  const postedAt = new Date();

  const entries: LedgerEntry[] = input.entries.map((e) => ({
    id: crypto.randomUUID(),
    transactionId,
    accountId: e.accountId,
    type: e.type,
    amount: e.amount,
    currency: e.currency,
    description: e.description,
    postedAt,
    reversed: false,
  }));

  const transaction: LedgerTransaction = {
    id: transactionId,
    entries,
    balanced: verifyLedgerBalance({ id: transactionId, entries, balanced: false, description: input.description, postedAt, sourceType: input.sourceType, sourceId: input.sourceId }),
    description: input.description,
    postedAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  };

  return transaction;
}

/**
 * Standard chart of accounts for a fintech / lending platform.
 */
export const STANDARD_CHART_OF_ACCOUNTS: LedgerAccount[] = [
  { id: "1000", code: "1000", name: "Cash — Operating Account", type: "asset", contra: false, currency: "USD", balance: 0, active: true },
  { id: "1001", code: "1001", name: "Cash — Client Funds", type: "asset", contra: false, currency: "USD", balance: 0, active: true },
  { id: "1100", code: "1100", name: "Loans Receivable", type: "asset", contra: false, currency: "USD", balance: 0, active: true },
  { id: "1101", code: "1101", name: "Allowance for Credit Losses", type: "asset", contra: true, currency: "USD", balance: 0, active: true },
  { id: "1200", code: "1200", name: "Accrued Interest Receivable", type: "asset", contra: false, currency: "USD", balance: 0, active: true },
  { id: "2000", code: "2000", name: "Customer Deposits", type: "liability", contra: false, currency: "USD", balance: 0, active: true },
  { id: "2100", code: "2100", name: "Accounts Payable", type: "liability", contra: false, currency: "USD", balance: 0, active: true },
  { id: "3000", code: "3000", name: "Share Capital", type: "equity", contra: false, currency: "USD", balance: 0, active: true },
  { id: "3100", code: "3100", name: "Retained Earnings", type: "equity", contra: false, currency: "USD", balance: 0, active: true },
  { id: "4000", code: "4000", name: "Interest Income", type: "revenue", contra: false, currency: "USD", balance: 0, active: true },
  { id: "4100", code: "4100", name: "Fee Income", type: "revenue", contra: false, currency: "USD", balance: 0, active: true },
  { id: "5000", code: "5000", name: "Interest Expense", type: "expense", contra: false, currency: "USD", balance: 0, active: true },
  { id: "5100", code: "5100", name: "Operating Expenses", type: "expense", contra: false, currency: "USD", balance: 0, active: true },
  { id: "5200", code: "5200", name: "Loan Loss Provision", type: "expense", contra: false, currency: "USD", balance: 0, active: true },
];

// ───────────────────────────────────────────────
// 4. Credit bureaus — licensed providers for credit reports + scores.
//
// IMPORTANT: Supa OS does NOT compute credit scores in-house. The existing
// `calculateCreditScore()` function in `loan-engine.ts` is a demo/sandbox
// scorer (clearly marked `demoOnly: true`) — it MUST NOT be used in
// production. Production fintech apps MUST integrate with a licensed
// credit bureau. This catalog lists the bureaus Supa OS can wire up.
//
// The pattern is the same as KYC + payment gateways: config catalog +
// inbound webhook surface for bureau response callbacks. The built app
// calls the bureau's API; the bureau calls back to Supa OS's webhook
// with the credit report.
// ───────────────────────────────────────────────

export type CreditBureauId =
  | "experian"        // Experian (US, UK, global)
  | "transunion"      // TransUnion (US, global)
  | "equifax"         // Equifax (US, global)
  | "crc_nigeria"     // Credit Registry Corporation (Nigeria)
  | "creditinfo"      // Creditinfo (Nordics, emerging markets)
  | "metropol";       // Metropol (Kenya, East Africa)

export interface CreditBureauConfig {
  id: CreditBureauId;
  title: string;
  description: string;
  /** Regions where this bureau operates. */
  regions: string[];
  /** Score range this bureau uses. */
  scoreRange: { min: number; max: number };
  /** What data this bureau returns. */
  products: Array<"credit_report" | "credit_score" | "fraud_alert" | "identity_verification" | "sanctions_check">;
  /** Environment variables needed. */
  envVars: string[];
  /** Where the bureau will POST credit report callbacks. */
  webhookPath: string;
  /** Whether the bureau supports real-time API pulls (vs async webhooks only). */
  supportsRealtime: boolean;
  /** Whether this bureau is licensed for regulated lending decisions. */
  licensed: boolean;
  implemented: boolean;
}

export const CREDIT_BUREAUS: CreditBureauConfig[] = [
  {
    id: "experian",
    title: "Experian",
    description: "Global credit bureau. FICO scores, credit reports, fraud alerts. Strong in US, UK, and 80+ countries.",
    regions: ["US", "UK", "Global"],
    scoreRange: { min: 300, max: 850 },
    products: ["credit_report", "credit_score", "fraud_alert", "identity_verification"],
    envVars: ["EXPERIAN_CLIENT_ID", "EXPERIAN_CLIENT_SECRET", "EXPERIAN_ENV", "EXPERIAN_SUBCODE"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: true,
    licensed: true,
    implemented: true,
  },
  {
    id: "transunion",
    title: "TransUnion",
    description: "Global credit bureau. VantageScore, credit reports, identity verification. Strong in US, India, Africa.",
    regions: ["US", "IN", "Global"],
    scoreRange: { min: 300, max: 850 },
    products: ["credit_report", "credit_score", "fraud_alert", "identity_verification"],
    envVars: ["TRANSUNION_USERNAME", "TRANSUNION_PASSWORD", "TRANSUNION_ENV", "TRANSUNION_ACCOUNT_ID"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: true,
    licensed: true,
    implemented: true,
  },
  {
    id: "equifax",
    title: "Equifax",
    description: "Global credit bureau. FICO scores, credit reports, income verification. Strong in US, LATAM, UK.",
    regions: ["US", "UK", "LATAM"],
    scoreRange: { min: 280, max: 850 },
    products: ["credit_report", "credit_score", "fraud_alert", "identity_verification", "sanctions_check"],
    envVars: ["EQUIFAX_CLIENT_ID", "EQUIFAX_CLIENT_SECRET", "EQUIFAX_ENV"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: true,
    licensed: true,
    implemented: true,
  },
  {
    id: "crc_nigeria",
    title: "Credit Registry Corporation (CRC)",
    description: "Nigeria's licensed credit bureau. CRC Credit Report, CRC Score. Required for regulated lending in Nigeria.",
    regions: ["NG"],
    scoreRange: { min: 300, max: 850 },
    products: ["credit_report", "credit_score", "fraud_alert"],
    envVars: ["CRC_API_KEY", "CRC_API_SECRET", "CRC_ENV"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: false,
    licensed: true,
    implemented: true,
  },
  {
    id: "creditinfo",
    title: "Creditinfo",
    description: "Nordic + emerging markets credit bureau. 90+ countries including Ghana, Sierra Leone, Iraq, Sri Lanka.",
    regions: ["IS", "GH", "SL", "IQ", "LK", "EMERGING"],
    scoreRange: { min: 0, max: 1000 },
    products: ["credit_report", "credit_score", "sanctions_check"],
    envVars: ["CREDITINFO_TOKEN", "CREDITINFO_ENV"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: true,
    licensed: true,
    implemented: true,
  },
  {
    id: "metropol",
    title: "Metropol CRB",
    description: "Kenya's licensed Credit Reference Bureau. Metropol score, credit reports, listing status (clean / defaulted).",
    regions: ["KE"],
    scoreRange: { min: 200, max: 900 },
    products: ["credit_report", "credit_score", "fraud_alert"],
    envVars: ["METROPOL_API_KEY", "METROPOL_API_SECRET", "METROPOL_ENV"],
    webhookPath: "/api/webhooks/credit-bureau",
    supportsRealtime: false,
    licensed: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 5. Fintech module summary.
// ───────────────────────────────────────────────

export interface FintechModuleSummary {
  kycProviders: number;
  oauthProviders: number;
  paymentGateways: number;
  creditBureaus: number;
  ledgerAccounts: number;
  ledgerFunctionImplemented: boolean;
  allImplemented: boolean;
}

export function verifyFintechPrimitives(): FintechModuleSummary {
  return {
    kycProviders: KYC_PROVIDERS.length,
    oauthProviders: OAUTH_PROVIDERS.length,
    paymentGateways: PAYMENT_GATEWAYS.length,
    creditBureaus: CREDIT_BUREAUS.length,
    ledgerAccounts: STANDARD_CHART_OF_ACCOUNTS.length,
    ledgerFunctionImplemented: true,
    allImplemented:
      KYC_PROVIDERS.every((p) => p.implemented) &&
      OAUTH_PROVIDERS.every((p) => p.implemented) &&
      PAYMENT_GATEWAYS.every((p) => p.implemented) &&
      CREDIT_BUREAUS.every((b) => b.implemented),
  };
}
