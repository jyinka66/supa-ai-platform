/**
 * @supa/workspace-core/profile
 * ----------------------------------------------------------------
 * Business profiles: a workspace may hold multiple profiles
 *   (freelancer with two trades). Profile owns: currency, tax
 *   defaults, invoice prefix + numbering sequence, bank details,
 *   branding, payment terms. Switching profile = scoped context
 *   switch, same workspace — the profile is the identity on
 *   documents, the workspace is the identity on data. Roles
 *   (owner/member/viewer) resolve per workspace; the design
 *   system's capability checks pattern returns here as
 *   can(user, action, resource) with no exceptions in the UI layer.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "./workspace.js";
import type { Currency } from "@supa/money/money";

// ───────────────────────────────────────────────
// BusinessProfile — the identity on documents
// ───────────────────────────────────────────────

/**
 * A business profile. A workspace may hold multiple profiles (e.g.
 * a freelancer with two trades — "Acme Design Studio" and "Acme
 * Consulting"). The profile is the identity on documents (invoices,
 * receipts); the workspace is the identity on data (which workspace
 * owns the rows).
 *
 * Switching profile = scoped context switch, same workspace. The
 * profile owns:
 *   - currency (per-profile, may differ from workspace base — e.g.
 *     a USD-profile in a NGN-base workspace for international clients)
 *   - tax defaults (per-line vs per-invoice, default rate)
 *   - invoice prefix + numbering sequence (per-profile, so two
 *     profiles don't collide: "DS-001" vs "CO-001")
 *   - bank details (per-profile, since different trades may use
 *     different accounts)
 *   - branding (logo, colors, font)
 *   - payment terms (default due-in-days, late fee policy)
 */
export interface BusinessProfile {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  /** Display name on documents (e.g. "Acme Design Studio"). */
  readonly name: string;
  /** Profile's native currency (for invoices issued under this profile). */
  readonly currency: Currency;
  /** Tax defaults for this profile. */
  readonly taxDefaults: TaxDefaults;
  /** Invoice prefix (e.g. "DS-" → "DS-0001"). */
  readonly invoicePrefix: string;
  /** Next invoice number in the sequence (monotonic per profile). */
  readonly nextInvoiceNumber: number;
  /** Bank details for this profile (multiple accounts allowed). */
  readonly bankDetails: BankDetails[];
  /** Branding assets (logo hash, colors, font family). */
  readonly branding: ProfileBranding;
  /** Default payment terms. */
  readonly paymentTerms: PaymentTerms;
  /** Soft-deleted at (null = active). */
  readonly deletedAt: number | null;
}

// ───────────────────────────────────────────────
// Tax defaults
// ───────────────────────────────────────────────

export interface TaxDefaults {
  /** Tax mode: per-line or per-invoice. */
  readonly mode: "per-line" | "per-invoice";
  /** Default tax rate as decimal string (e.g. "0.075" for 7.5% VAT). */
  readonly defaultRate: string;
  /** Tax label shown on invoices (e.g. "VAT", "Sales Tax"). */
  readonly label: string;
  /** Whether tax is inclusive (built into line price) or exclusive. */
  readonly inclusive: boolean;
}

// ───────────────────────────────────────────────
// Bank details
// ───────────────────────────────────────────────

export interface BankDetails {
  /** Bank name (e.g. "GTBank"). */
  readonly bankName: string;
  /** Account name. */
  readonly accountName: string;
  /** Account number (10 digits for NGN). */
  readonly accountNumber: string;
  /** Bank code (e.g. sort code, routing number, or CBN code). */
  readonly bankCode: string;
  /** Currency this account is denominated in. */
  readonly currency: Currency;
  /** Whether this is the primary account for the profile. */
  readonly primary: boolean;
}

// ───────────────────────────────────────────────
// Branding
// ───────────────────────────────────────────────

export interface ProfileBranding {
  /** Logo asset hash (content-addressed). */
  readonly logoHash: string | null;
  /** Primary brand color (hex). */
  readonly primaryColor: string;
  /** Secondary brand color (hex). */
  readonly secondaryColor: string;
  /** Preferred font family for documents. */
  readonly fontFamily: string | null;
}

// ───────────────────────────────────────────────
// Payment terms
// ───────────────────────────────────────────────

export interface PaymentTerms {
  /** Default due-in days from invoice issue date. */
  readonly defaultDueInDays: number;
  /** Late fee policy (percentage per month, as decimal string). */
  readonly lateFeeRate: string | null;
  /** Whether to auto-send reminders. */
  readonly autoReminders: boolean;
  /** Discount for early payment (e.g. "2/10 net 30" = 2% off if paid in 10 days). */
  readonly earlyPaymentDiscount: EarlyPaymentDiscount | null;
}

export interface EarlyPaymentDiscount {
  /** Discount percentage (decimal string, e.g. "0.02" for 2%). */
  readonly rate: string;
  /** Days within which payment qualifies for the discount. */
  readonly withinDays: number;
}

// ───────────────────────────────────────────────
// Profile context — the scoped context switch
// ───────────────────────────────────────────────

/**
 * The scoped context for working under a specific profile. Carries
 * the workspace scope + the active profile id. Switching profile
 * is just swapping the profileId — the workspace scope stays the
 * same (same data ownership, different document identity).
 */
export interface ProfileContext {
  readonly workspace: import("./workspace.js").WorkspaceScope;
  readonly profileId: string;
}

/**
 * Switch the active profile within a workspace. Returns a new
 * ProfileContext — the workspace scope is unchanged (same data
 * ownership), only the profile id differs.
 */
export function switchProfile(
  scope: import("./workspace.js").WorkspaceScope,
  profileId: string,
): ProfileContext {
  return { workspace: scope, profileId };
}

// ───────────────────────────────────────────────
// Invoice numbering — per-profile monotonic sequence
// ───────────────────────────────────────────────

/**
 * Compute the next invoice number for a profile. Format:
 *   `${invoicePrefix}${nextInvoiceNumber.toString().padStart(width, "0")}`
 *
 * The numbering is monotonic per profile — two profiles in the same
 * workspace don't collide (DS-0001 vs CO-0001). The caller is
 * responsible for atomically incrementing `nextInvoiceNumber` when
 * an invoice is issued.
 */
export function nextInvoiceId(profile: BusinessProfile, width: number = 4): string {
  return `${profile.invoicePrefix}${profile.nextInvoiceNumber.toString().padStart(width, "0")}`;
}

/**
 * Increment the profile's next-invoice-number (returns a new
 * BusinessProfile — immutable update). Called atomically when an
 * invoice is issued, so concurrent invoice creations don't collide.
 */
export function incrementInvoiceNumber(profile: BusinessProfile): BusinessProfile {
  return {
    ...profile,
    nextInvoiceNumber: profile.nextInvoiceNumber + 1,
  };
}

// ───────────────────────────────────────────────
// Profile ownership — profiles belong to workspaces
// ───────────────────────────────────────────────

/**
 * Assert that a profile belongs to a workspace. Called by every
 * repository function that takes a profile id — defense in depth
 * (the repository layer is the first gate, RLS is the second).
 */
export function assertProfileInWorkspace(profile: BusinessProfile, wsId: WorkspaceId): void {
  if (profile.workspaceId !== wsId) {
    throw new ProfileAccessError(
      `profile ${profile.id} does not belong to workspace ${wsId}`,
    );
  }
}

export class ProfileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileAccessError";
  }
}
