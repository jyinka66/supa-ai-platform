/**
 * @supa/expenses/mileage
 * ----------------------------------------------------------------
 * Mileage: { trip distance, rate per km (workspace-settable,
 *   country-default provided), origin/destination optional } —
 *   computed to Money at entry time and written as an ordinary
 *   expense fact with the rate recorded. GPS capture is a
 *   convenience input, never a background tracker (battery and
 *   privacy both). The tax report reads mileage expenses like
 *   any other — no special case, because there is no special case.
 * ----------------------------------------------------------------
 */

import type { Money, Currency } from "@supa/money/money";
import { fromMinor } from "@supa/money/money";

// ───────────────────────────────────────────────
// Mileage rate — workspace-settable, country-default
// ───────────────────────────────────────────────

/**
 * Country-default mileage rates (per km, in the country's native
 * currency, as a decimal string). Workspace-settable — the owner
 * can override, but the country default is provided so they don't
 * have to research it.
 *
 * These are illustrative — production pulls from a maintained
 * rate table (tax authority per country). The point is: the rate
 * is RECORDED at entry time, so the tax report is reproducible
 * even if the rate changes next year.
 */
export const COUNTRY_DEFAULT_RATES: Readonly<Record<string, { currency: string; ratePerKm: string }>> = {
  NG: { currency: "NGN", ratePerKm: "65.00" }, // ₦65/km (illustrative)
  US: { currency: "USD", ratePerKm: "0.67" },  // $0.67/mile ≈ $0.42/km (illustrative)
  GB: { currency: "GBP", ratePerKm: "0.45" },  // £0.45/mile (illustrative)
  MA: { currency: "MAD", ratePerKm: "7.50" },  // 7.50 MAD/km (illustrative)
  KE: { currency: "KES", ratePerKm: "85.00" }, // KSh 85/km (illustrative)
  ZA: { currency: "ZAR", ratePerKm: "4.50" },  // R4.50/km (illustrative)
};

export function getCountryDefaultRate(countryCode: string): { currency: string; ratePerKm: string } | null {
  return COUNTRY_DEFAULT_RATES[countryCode] ?? null;
}

// ───────────────────────────────────────────────
// Mileage computation — distance × rate → Money
// ───────────────────────────────────────────────

export interface MileageEntry {
  /** Trip distance in km. */
  readonly distanceKm: number;
  /** Rate per km (decimal string, e.g. "65.00"). RECORDED at entry time. */
  readonly ratePerKm: string;
  /** Currency the rate is denominated in. */
  readonly currency: Currency;
  /** Origin (optional — GPS convenience, not required). */
  readonly origin: string | null;
  /** Destination (optional). */
  readonly destination: string | null;
}

/**
 * Compute the mileage amount = distance × ratePerKm, banker's
 * rounded to the currency's minor unit. The rate is RECORDED at
 * entry time — the tax report is reproducible even if the rate
 * changes next year.
 *
 * The result is an ordinary Money value, written as an expense
 * fact with `mileage: { distanceKm, ratePerKm, origin, destination }`.
 * The tax report reads mileage expenses like any other — no
 * special case, because there is no special case.
 */
export function computeMileageAmount(entry: MileageEntry): Money {
  if (entry.distanceKm < 0) {
    throw new Error(`distance must be ≥ 0; got: ${entry.distanceKm}`);
  }
  const { numerator, denominator } = parseDecimal(entry.ratePerKm);
  const scale = minorScale(entry.currency);
  // amount_minor = distance_km × rate_per_km × 10^scale
  // In bigint: (distance_km × 1000) × numerator × 10^scale / (denominator × 1000)
  const distanceMilli = BigInt(Math.round(entry.distanceKm * 1000));
  const scaleFactor = 10n ** BigInt(scale);
  const exact = (distanceMilli * numerator * scaleFactor) / denominator;
  const remainder = (distanceMilli * numerator * scaleFactor) % denominator;
  // Banker's rounding.
  const half = denominator / 2n;
  let adjustment = 0n;
  if (remainder > half || (remainder === half && exact % 2n !== 0n)) {
    adjustment = 1n;
  }
  // exact is in milli-minor-units; divide by 1000 to get minor units.
  const minor = (exact + adjustment) / 1000n;
  return fromMinor(minor, entry.currency);
}

function minorScale(currency: Currency): number {
  switch (currency) {
    case "NGN": case "USD": case "EUR": case "GBP":
    case "GHS": case "KES": case "ZAR": case "EGP": case "MAD":
      return 2;
    case "XOF": case "XAF":
      return 0;
    default:
      return 2;
  }
}

function parseDecimal(s: string): { numerator: bigint; denominator: bigint } {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid decimal: "${s}"`);
  }
  const [intPart = "0", fracPart = ""] = s.split(".");
  if (fracPart.length === 0) {
    return { numerator: BigInt(intPart), denominator: 1n };
  }
  return {
    numerator: BigInt(`${intPart}${fracPart}`),
    denominator: 10n ** BigInt(fracPart.length),
  };
}

// ───────────────────────────────────────────────
// GPS capture — convenience, never background tracker
// ───────────────────────────────────────────────

/**
 * GPS capture is a CONVENIENCE input — the user can capture their
 * trip distance via GPS, but it's never a background tracker.
 * Battery + privacy both: the system doesn't track location in
 * the background; GPS is only used when the user explicitly
 * starts a trip capture.
 */
export interface GpsTripCapture {
  readonly startedAt: number;
  readonly endedAt: number;
  /** Distance in km (computed from the GPS track). */
  readonly distanceKm: number;
  /** Origin address (reverse-geocoded, optional). */
  readonly originAddress: string | null;
  /** Destination address (reverse-geocoded, optional). */
  readonly destinationAddress: string | null;
}

/**
 * Convert a GPS trip capture to a MileageEntry. The user reviews
 * the captured distance + addresses, then confirms. The GPS
 * capture is a convenience — the user can edit the distance or
 * addresses before saving.
 */
export function gpsCaptureToEntry(
  capture: GpsTripCapture,
  ratePerKm: string,
  currency: Currency,
): MileageEntry {
  return {
    distanceKm: capture.distanceKm,
    ratePerKm,
    currency,
    origin: capture.originAddress,
    destination: capture.destinationAddress,
  };
}
