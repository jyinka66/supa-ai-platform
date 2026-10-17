// Search Console integration — impressions, clicks, positions, errors.
//
// The spec: "Search Console integration — impressions, clicks, positions,
// errors monitored automatically."
//
// In production, this would use the Google Search Console API (with OAuth +
// a service account). For now, this is a stub that returns the data shape
// the admin dashboard expects. The real impl would:
//   1. Authenticate via a Google service account (GOOGLE_APPLICATION_CREDENTIALS).
//   2. Query the Search Console API for the site's performance over a date range.
//   3. Aggregate by page, query, country, device.
//   4. Store snapshots in a `search_console_snapshots` table (for trend tracking).
//
// This module provides the types + the stub. The admin route reads from it.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface SearchConsoleMetrics {
  impressions: number;
  clicks: number;
  position: number; // average position.
  ctr: number; // click-through rate (clicks / impressions).
}

export interface SearchConsolePageMetrics extends SearchConsoleMetrics {
  url: string;
}

export interface SearchConsoleQueryMetrics extends SearchConsoleMetrics {
  query: string;
}

export interface SearchConsoleReport {
  dateRange: { from: string; to: string };
  totals: SearchConsoleMetrics;
  topPages: SearchConsolePageMetrics[];
  topQueries: SearchConsoleQueryMetrics[];
  errors: Array<{ url: string; type: string; message: string; firstDetected: string }>;
  coverage: { indexed: number; notIndexed: number; errors: number };
}

// ───────────────────────────────────────────────
// Stub implementation — returns empty data.
//
// The real impl would call:
//   GET https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//   GET https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/urlCrawlErrorsCounts/query
// ───────────────────────────────────────────────

/**
 * Get the Search Console report for a date range.
 *
 * @param fromTs — start of the range.
 * @param toTs — end of the range (default: now).
 *
 * STUB: returns empty data. The real impl queries the Google Search Console API
 * via a service account. The structure matches what the admin dashboard expects.
 */
export async function getSearchConsoleReport(
  fromTs: Date,
  toTs: Date = new Date(),
): Promise<SearchConsoleReport> {
  // STUB: the real impl would call the Search Console API.
  // For now, return empty data (the dashboard shows "no data" gracefully).
  return {
    dateRange: { from: fromTs.toISOString(), to: toTs.toISOString() },
    totals: { impressions: 0, clicks: 0, position: 0, ctr: 0 },
    topPages: [],
    topQueries: [],
    errors: [],
    coverage: { indexed: 0, notIndexed: 0, errors: 0 },
  };
}

/**
 * Get the site's indexing coverage (how many URLs are indexed vs not indexed vs errored).
 *
 * STUB: returns zeros.
 */
export async function getIndexingCoverage(): Promise<{
  indexed: number;
  notIndexed: number;
  errors: number;
}> {
  // STUB: the real impl queries the Search Console URL inspection API.
  return { indexed: 0, notIndexed: 0, errors: 0 };
}

/**
 * Get the top-performing pages (by clicks).
 *
 * STUB: returns empty.
 */
export async function getTopPages(
  _fromTs: Date,
  _toTs: Date = new Date(),
  _limit: number = 20,
): Promise<SearchConsolePageMetrics[]> {
  // STUB.
  return [];
}

/**
 * Get the top-performing queries (by impressions).
 *
 * STUB: returns empty.
 */
export async function getTopQueries(
  _fromTs: Date,
  _toTs: Date = new Date(),
  _limit: number = 20,
): Promise<SearchConsoleQueryMetrics[]> {
  // STUB.
  return [];
}

/**
 * Check if Search Console is configured (the service account credentials exist).
 */
export function isSearchConsoleConfigured(): boolean {
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
