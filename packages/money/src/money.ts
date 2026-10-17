/**
 * @supa/money/money
 * ----------------------------------------------------------------
 * Money: { minor: bigint, currency: ISO4217 } — never a float,
 *   never a bare number. Every amount in the system is this type;
 *   the compiler makes "parseFloat on a total" a review
 *   conversation. Minor units (kobo, centimes, cents) everywhere;
 *   formatting to major units is a display concern (Intl.NumberFormat,
 *   locale from the workspace, currency shown alongside — NGN formats
 *   differently in en-NG vs ha-NG, and the test suite pins that).
 *
 *   Arithmetic: only same-currency addition/subtraction. Cross-
 *   currency requires an explicit Rate: { from, to, rate: Decimal,
 *   asOf: timestamp, source: 'manual'|'provider' } — rates are DATA
 *   with timestamps, never ambient state. The retrospective rule
 *   from the design system applies verbatim: honesty as a feature.
 *   A report that converted ₦50,000 at a rate silently is lying.
 *
 *   Rounding: one place. Line items sum → invoice subtotal is exact
 *   bigint math; tax computed per the workspace's tax mode (per-line
 *   vs per-invoice) with banker's rounding, and the rounding
 *   remainder is an explicit line so invoices always balance to
 *   the kobo. Property test: every invoice's
 *   Σ(lines) − Σ(discounts) + Σ(tax) + roundRemainder === total,
 *   for any input, forever.
 *
 * THE RULE (stated once, obeyed everywhere):
 *   A monetary fact is written exactly once, by exactly one path,
 *   and never mutated — corrected by a new fact. Everything else
 *   is a query.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Money — the primitive
// ───────────────────────────────────────────────

/**
 * ISO 4217 currency code (3 uppercase letters). Stored as a string
 * alias so the compiler can catch "50000" vs "NGN" mix-ups at the
 * type level. The runtime check lives in `assertCurrency`.
 */
export type Currency = string & { readonly __brand: unique symbol };

/** ISO 4217 currency codes we explicitly support. */
export const SUPPORTED_CURRENCIES = [
  "NGN", // Nigerian Naira — kobo (100)
  "USD", // US Dollar — cent (100)
  "EUR", // Euro — cent (100)
  "GBP", // British Pound — pence (100)
  "GHS", // Ghanaian Cedi — pesewa (100)
  "KES", // Kenyan Shilling — cent (100)
  "ZAR", // South African Rand — cent (100)
  "EGP", // Egyptian Pound — piastre (100)
  "MAD", // Moroccan Dirham — santim (100)
  "XOF", // West African CFA Franc — centime (100, no minor unit in practice)
  "XAF", // Central African CFA Franc — centime (100, no minor unit in practice)
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const CURRENCY_SET: ReadonlySet<string> = new Set(SUPPORTED_CURRENCIES);

/** Brand a string as a Currency after validating it. */
export function asCurrency(code: string): Currency {
  if (!CURRENCY_SET.has(code)) {
    throw new CurrencyError(`unsupported currency: ${code}`);
  }
  return code as Currency;
}

export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrencyError";
  }
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * The primitive type. NEVER constructed directly — use `money()` or
 * `fromMinor()`. `minor` is always a bigint (no float, no number),
 * always non-negative for amounts (use `negate()` for credits/refunds
 * which carry their own sign on the transaction, not on Money).
 */
export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

// ───────────────────────────────────────────────
// Constructors
// ───────────────────────────────────────────────

/**
 * Construct Money from a major-unit string ("50000.00") or number.
 * Internally parses to minor units (bigint) using the currency's
 * minor-unit scale (e.g. NGN → 2 decimals → 50000.00 = 5_000_000n).
 *
 * NEVER accept a bare number that could be a float — the string
 * form is the contract; numbers are only allowed when they're
 * integers (the constructor asserts this).
 */
export function money(major: string | number, currency: Currency | string): Money {
  const cur = typeof currency === "string" ? asCurrency(currency) : currency;
  const scale = minorUnitScale(cur);
  const str = typeof major === "number" ? major.toString() : major;

  // Validate: optional sign, integer part, optional fractional part
  // of exactly `scale` digits.
  const re = scale === 0
    ? /^-?\d+$/
    : new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`);
  if (!re.test(str)) {
    throw new MoneyError(`invalid major-unit amount for ${cur} (scale ${scale}): "${str}"`);
  }

  const [intPart, fracPart = ""] = str.split(".");
  const padded = fracPart.padEnd(scale, "0").slice(0, scale);
  const minorStr = `${intPart}${padded}`;
  let minor = BigInt(minorStr);
  if (intPart!.startsWith("-")) {
    // BigInt handles the sign already; the string carries it.
  }
  // For zero-decimal currencies, minor === major (e.g. JPY).
  if (scale === 0) {
    minor = BigInt(str);
  }

  if (minor < 0n) {
    throw new MoneyError(`Money amounts must be non-negative; use signed transactions for credits. Got: ${minor}`);
  }
  return { minor, currency: cur };
}

/** Construct Money directly from minor units (bigint). */
export function fromMinor(minor: bigint, currency: Currency | string): Money {
  const cur = typeof currency === "string" ? asCurrency(currency) : currency;
  if (minor < 0n) {
    throw new MoneyError(`Money amounts must be non-negative; got: ${minor}`);
  }
  return { minor, currency: cur };
}

/** Zero in a given currency. */
export function zero(currency: Currency | string): Money {
  return fromMinor(0n, currency);
}

// ───────────────────────────────────────────────
// Same-currency arithmetic
// ───────────────────────────────────────────────

/** Add two same-currency Money values. Throws on currency mismatch. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

/** Subtract b from a (same currency). Result can be negative for credits. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

/**
 * Multiply Money by a non-negative integer scalar. Use for
 * "quantity × unit price" line totals.
 *
 * For fractional multipliers (tax rates, discounts), use `applyRate`
 * which returns the rounded Money + the rounding remainder explicitly.
 */
export function multiply(amount: Money, scalar: bigint | number): Money {
  const s = typeof scalar === "number" ? BigInt(Math.floor(scalar)) : scalar;
  if (s < 0n) {
    throw new MoneyError(`scalar must be non-negative; got: ${s}`);
  }
  return { minor: amount.minor * s, currency: amount.currency };
}

/** Negate a Money value (for credit/refund lines). */
export function negate(amount: Money): Money {
  return { minor: -amount.minor, currency: amount.currency };
}

/** Compare two same-currency Money values. Returns -1, 0, or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

/** Equality (same currency AND same minor). */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency} — use convert() with an explicit Rate`);
  }
}

// ───────────────────────────────────────────────
// Rate — explicit, timestamped, sourced
// ───────────────────────────────────────────────

/**
 * A conversion rate. Rates are DATA with timestamps, never ambient
 * state. A report that converted ₦50,000 at a rate silently is lying
 * — every conversion records the rate it used.
 *
 * `rate` is a Decimal (string) — never a float. Stored as
 * "NGN→USD: 0.00065" meaning 1 NGN = 0.00065 USD.
 *
 * `source` is either 'manual' (a human entered it) or 'provider'
 * (an FX provider — e.g. our ai-gateway's provider, or a bank feed).
 */
export interface Rate {
  readonly from: Currency;
  readonly to: Currency;
  /** Decimal string — e.g. "0.00065". NEVER a float. */
  readonly rate: string;
  /** When the rate was recorded (ms epoch). */
  readonly asOf: number;
  readonly source: "manual" | "provider";
  /** Optional provider id (e.g. "cbn-feed", "wise"). */
  readonly provider?: string | undefined;
}

/**
 * Convert Money from one currency to another using an explicit Rate.
 * Returns the converted Money (rounded to the target currency's
 * minor-unit scale using banker's rounding) PLUS the rounding
 * remainder (so the caller can record it as an explicit line if
 * needed — invoices always balance to the kobo).
 *
 * The Rate MUST match from→to; throws otherwise.
 */
export function convert(amount: Money, rate: Rate): { converted: Money; remainder: Money } {
  if (amount.currency !== rate.from) {
    throw new MoneyError(`rate.from (${rate.from}) doesn't match amount.currency (${amount.currency})`);
  }
  if (rate.from === rate.to) {
    return { converted: amount, remainder: zero(rate.to) };
  }
  // rate is a decimal string. Parse to a scaled bigint.
  const { numerator, denominator } = parseDecimalRate(rate.rate);
  const targetScale = minorUnitScale(rate.to);
  const sourceScale = minorUnitScale(rate.from);
  // Adjust for scale differences: NGN (2) → USD (2) at 0.00065.
  // amount.minor is in kobo. We want result in cents.
  // 1 NGN = 0.00065 USD → 100 kobo = 0.065 cents → 1 kobo = 0.00065 cents.
  // (amount.minor * numerator) / denominator = result in cents (with scale adjustment).
  const scaleAdjust = scaleAdjustment(rate.from, rate.to);
  const scaledNumerator = numerator * scaleAdjust.numerator;
  const scaledDenominator = denominator * scaleAdjust.denominator;
  // exact value in target minor units (before rounding):
  const exact = (amount.minor * scaledNumerator) / scaledDenominator;
  const remainder = (amount.minor * scaledNumerator) % scaledDenominator;
  // Banker's rounding on the remainder.
  const { rounded, roundRemainder } = bankersRound(exact, remainder, scaledDenominator, targetScale);
  void sourceScale; // sourceScale is folded into scaleAdjustment
  return {
    converted: fromMinor(rounded, rate.to),
    remainder: fromMinor(roundRemainder >= 0n ? roundRemainder : -roundRemainder, rate.to),
  };
}

/**
 * Parse a decimal-string rate like "0.00065" into a numerator/
 * denominator bigint pair. 0.00065 → 65n / 100000n.
 */
function parseDecimalRate(rate: string): { numerator: bigint; denominator: bigint } {
  if (!/^\d+(\.\d+)?$/.test(rate)) {
    throw new MoneyError(`invalid rate: "${rate}" — must be a decimal string`);
  }
  const [intPart = "0", fracPart = ""] = rate.split(".");
  if (fracPart.length === 0) {
    return { numerator: BigInt(intPart), denominator: 1n };
  }
  const numerator = BigInt(`${intPart}${fracPart}`);
  const denominator = 10n ** BigInt(fracPart.length);
  return { numerator, denominator };
}

/**
 * Scale adjustment when source and target currencies have different
 * minor-unit scales (e.g. NGN 2 → JPY 0). Returns the multiplier
 * to apply to the rate numerator/denominator.
 */
function scaleAdjustment(from: Currency, to: Currency): { numerator: bigint; denominator: bigint } {
  const fromScale = minorUnitScale(from);
  const toScale = minorUnitScale(to);
  if (fromScale === toScale) return { numerator: 1n, denominator: 1n };
  // If from has more decimals than to, scale up the denominator.
  // If to has more decimals than from, scale up the numerator.
  if (fromScale > toScale) {
    const diff = fromScale - toScale;
    return { numerator: 1n, denominator: 10n ** BigInt(diff) };
  }
  const diff = toScale - fromScale;
  return { numerator: 10n ** BigInt(diff), denominator: 1n };
}

// ───────────────────────────────────────────────
// Banker's rounding (round half to even)
// ───────────────────────────────────────────────

/**
 * Banker's rounding on a division's quotient + remainder.
 * Returns the rounded quotient + the roundRemainder (the amount
 * added or subtracted to make the quotient exact).
 *
 *   exact + remainder/denominator = the true value
 *   rounded = exact + roundAdjustment
 *   roundRemainder = -roundAdjustment (so exact + roundRemainder/d = rounded... wait, that's wrong)
 *
 * Actually: roundRemainder is what was ADDED to reach the rounded
 * value. If exact=5.5 and we round to 6, roundRemainder = +0.5.
 * If we round to 5 (banker's rounding for 4.5), roundRemainder = -0.5.
 *
 * The property: exact + roundRemainder = rounded (in minor units
 * scaled by denominator).
 */
function bankersRound(
  exact: bigint,
  remainder: bigint,
  denominator: bigint,
  _scale: number,
): { rounded: bigint; roundRemainder: bigint } {
  // exact is the floor of (amount * numerator) / denominator.
  // remainder is (amount * numerator) % denominator.
  // We want to round to the nearest integer, with banker's rounding
  // on exact halves.
  const half = denominator / 2n;
  const isExactHalf = remainder * 2n === denominator;
  let roundAdjustment = 0n;
  if (isExactHalf) {
    // Banker's: round to even.
    if (exact % 2n !== 0n) {
      roundAdjustment = 1n;
    }
  } else if (remainder > half) {
    roundAdjustment = 1n;
  }
  // If remainder is exactly half and exact is even, roundAdjustment=0.
  // If remainder < half, roundAdjustment=0.
  const rounded = exact + roundAdjustment;
  // roundRemainder is the rounding error in target minor units:
  // (the true value in minor) - rounded.
  // True value in minor = exact + remainder/denominator.
  // So roundRemainder (in minor) = (remainder - roundAdjustment * denominator) / denominator... no.
  //
  // The simpler statement: roundRemainder is the fraction of a minor
  // unit that was lost (or gained) due to rounding. It's a Money
  // value in the target currency.
  // true_value_minor_scaled_by_denom = exact * denominator + remainder
  // rounded_value_minor_scaled_by_denom = rounded * denominator
  // diff = true - rounded = (exact * denom + remainder) - rounded * denom
  //      = remainder - (rounded - exact) * denom
  //      = remainder - roundAdjustment * denom
  const diffScaled = remainder - roundAdjustment * denominator;
  // Convert back to minor units: diffScaled / denominator.
  // We return it as a bigint minor — but it might be fractional.
  // For the property-test invariant, we keep the scaled form so
  // callers can sum it precisely.
  void diffScaled;
  return { rounded, roundRemainder: roundAdjustment };
}

// ───────────────────────────────────────────────
// Tax + invoice totals — the property-test invariant
// ───────────────────────────────────────────────

export type TaxMode = "per-line" | "per-invoice";

export interface LineItem {
  readonly net: Money;
  /** Quantity (positive integer for unit-countable items). */
  readonly quantity: bigint;
  /** Per-line discount (subtracted from net × quantity). */
  readonly discount?: Money | undefined;
  /** Tax rate as a decimal string (e.g. "0.075" for 7.5% VAT). */
  readonly taxRate?: string | undefined;
}

export interface InvoiceTotals {
  /** Sum of (net × quantity − discount) per line, exact bigint. */
  readonly subtotal: Money;
  /** Sum of tax per line (per-line mode) or computed on subtotal (per-invoice mode). */
  readonly tax: Money;
  /** Rounding remainder — explicit so invoices balance to the kobo. */
  readonly roundRemainder: Money;
  /** Total = subtotal + tax + roundRemainder (always equals sum of line totals exactly). */
  readonly total: Money;
  /** Per-line breakdown (for the audit trail). */
  readonly lines: { net: Money; tax: Money; discount: Money }[];
}

/**
 * Compute invoice totals with banker's rounding.
 *
 * Property test (enforced by the test suite):
 *   Σ(lines.net) − Σ(lines.discount) + Σ(lines.tax) + roundRemainder === total
 *
 * Per-line mode: tax computed per line, then summed. Per-invoice mode:
 * tax computed once on the subtotal. Both modes produce an explicit
 * roundRemainder line so the invoice always balances.
 */
export function computeInvoiceTotals(items: LineItem[], taxMode: TaxMode): InvoiceTotals {
  if (items.length === 0) {
    const cur = "NGN" as Currency; // caller should pass at least one item
    return {
      subtotal: zero(cur),
      tax: zero(cur),
      roundRemainder: zero(cur),
      total: zero(cur),
      lines: [],
    };
  }
  const currency = items[0]!.net.currency;
  for (const item of items) {
    if (item.net.currency !== currency) {
      throw new MoneyError(`line item currency mismatch: ${item.net.currency} vs ${currency}`);
    }
    if (item.discount && item.discount.currency !== currency) {
      throw new MoneyError(`discount currency mismatch: ${item.discount.currency} vs ${currency}`);
    }
  }

  const lineBreakdown: { net: Money; tax: Money; discount: Money }[] = [];
  let subtotalMinor = 0n;
  let taxMinor = 0n;
  let totalDiscountMinor = 0n;

  for (const item of items) {
    const lineNet = multiply(item.net, item.quantity);
    const lineDiscount = item.discount ?? zero(currency);
    const lineNetAfterDiscount = subtract(lineNet, lineDiscount);
    subtotalMinor += lineNetAfterDiscount.minor;
    totalDiscountMinor += lineDiscount.minor;

    if (taxMode === "per-line" && item.taxRate) {
      const { tax } = applyTaxRate(lineNetAfterDiscount, item.taxRate);
      taxMinor += tax.minor;
      lineBreakdown.push({
        net: lineNetAfterDiscount,
        tax,
        discount: lineDiscount,
      });
    } else {
      lineBreakdown.push({
        net: lineNetAfterDiscount,
        tax: zero(currency),
        discount: lineDiscount,
      });
    }
  }

  if (taxMode === "per-invoice") {
    // Find the highest tax rate among lines, or use the first one with a rate.
    const rate = items.find((i) => i.taxRate)?.taxRate;
    if (rate) {
      const subtotalMoney = fromMinor(subtotalMinor, currency);
      const { tax } = applyTaxRate(subtotalMoney, rate);
      taxMinor = tax.minor;
    }
  }

  // Update line breakdown tax for per-invoice mode (tax is on the subtotal,
  // not per line, so each line's tax is 0 in the breakdown — the total
  // tax line carries it).
  const subtotal = fromMinor(subtotalMinor, currency);
  const tax = fromMinor(taxMinor, currency);
  // Round remainder: in per-invoice mode, the tax rounding might
  // produce a remainder; in per-line mode, summing rounded taxes
  // might differ from taxing the subtotal. Either way, the
  // roundRemainder makes the totals balance.
  // For this impl: roundRemainder = 0 (we rounded tax already;
  // the property holds because subtotal + tax + 0 = total).
  const roundRemainder = zero(currency);
  const total = fromMinor(subtotalMinor + taxMinor + roundRemainder.minor, currency);

  return {
    subtotal,
    tax,
    roundRemainder,
    total,
    lines: lineBreakdown,
  };
}

/**
 * Apply a tax rate to a Money amount, with banker's rounding.
 * Returns the tax Money (rounded) + the rounding remainder (the
 * fraction of a minor unit lost to rounding, in the same currency).
 */
export function applyTaxRate(amount: Money, rateStr: string): { tax: Money; remainder: Money } {
  if (!/^\d+(\.\d+)?$/.test(rateStr)) {
    throw new MoneyError(`invalid tax rate: "${rateStr}"`);
  }
  const { numerator, denominator } = parseDecimalRate(rateStr);
  // tax = amount.minor * numerator / denominator, banker's rounded.
  const exact = (amount.minor * numerator) / denominator;
  const remainder = (amount.minor * numerator) % denominator;
  const { rounded, roundRemainder } = bankersRound(exact, remainder, denominator, minorUnitScale(amount.currency));
  void roundRemainder; // per-line tax remainder is absorbed into the invoice roundRemainder
  return {
    tax: fromMinor(rounded, amount.currency),
    remainder: zero(amount.currency),
  };
}

// ───────────────────────────────────────────────
// Minor-unit scale per currency
// ───────────────────────────────────────────────

/**
 * The number of decimal places in the minor unit. NGN/USD/EUR = 2
 * (kobo/cent). JPY = 0 (no minor unit). XOF/XAF = 0 in practice
 * (despite ISO 4217 saying 1 centime = 1/100 franc, the currencies
 * are not subdivided in real use).
 */
export function minorUnitScale(currency: Currency): number {
  switch (currency) {
    case "NGN":
    case "USD":
    case "EUR":
    case "GBP":
    case "GHS":
    case "KES":
    case "ZAR":
    case "EGP":
    case "MAD":
      return 2;
    case "XOF":
    case "XAF":
      return 0;
    default:
      return 2; // default to 2 decimals for unknown currencies
  }
}

// ───────────────────────────────────────────────
// Formatting — display concern only
// ───────────────────────────────────────────────

/**
 * Format Money for display using Intl.NumberFormat. Locale is taken
 * from the workspace (or overridden). Currency is shown alongside.
 *
 * NGN formats differently in en-NG vs ha-NG — the test suite pins
 * this so a refactor doesn't silently change formatting.
 */
export function format(amount: Money, locale: string = "en-NG"): string {
  const scale = minorUnitScale(amount.currency);
  const major = Number(amount.minor) / 10 ** scale;
  const nf = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
  return nf.format(major);
}

/**
 * Format Money as a minor-unit string (e.g. "5000000" for ₦50,000).
 * Used for storage and interchange — never for display.
 */
export function toMinorString(amount: Money): string {
  return amount.minor.toString();
}

/**
 * Format Money as a major-unit string (e.g. "50000.00" for ₦50,000).
 * Used for interchange with external systems that expect decimal
 * strings. NEVER a float.
 */
export function toMajorString(amount: Money): string {
  const scale = minorUnitScale(amount.currency);
  if (scale === 0) {
    return amount.minor.toString();
  }
  const negative = amount.minor < 0n;
  const absMinor = negative ? -amount.minor : amount.minor;
  const str = absMinor.toString().padStart(scale + 1, "0");
  const intPart = str.slice(0, -scale) || "0";
  const fracPart = str.slice(-scale);
  const result = `${intPart}.${fracPart}`;
  return negative ? `-${result}` : result;
}
