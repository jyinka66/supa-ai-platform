// Content freshness + broken link detection.
//
// The spec: "Automated content freshness — pages that haven't been updated in
// 12 months flagged for review." + "Automated broken link detection — internal
// and external links checked regularly."

import { db } from "@supa/db";
import { blogPosts, helpArticles, changelogEntries } from "@supa/db/schema";
import { sql } from "drizzle-orm";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ContentType = "blog" | "help" | "changelog";

export interface StaleContent {
  type: ContentType;
  id: string;
  slug: string;
  locale: string;
  title: string;
  updatedAt: Date;
  daysStale: number;
}

export interface BrokenLink {
  url: string;
  sourceType: ContentType;
  sourceId: string;
  sourceSlug: string;
  status: number | null;
  error: string | null;
}

export interface FreshnessReport {
  staleCount: number;
  staleItems: StaleContent[];
}

export interface BrokenLinkReport {
  checkedCount: number;
  brokenCount: number;
  brokenLinks: BrokenLink[];
}

// ───────────────────────────────────────────────
// Content freshness
// ───────────────────────────────────────────────

const STALE_THRESHOLD_DAYS = 365;

export { STALE_THRESHOLD_DAYS };

export async function findStaleContent(): Promise<FreshnessReport> {
  const staleItems: StaleContent[] = [];
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 86400000);

  const staleBlog = await db
    .select({
      id: blogPosts.id,
      slug: blogPosts.slug,
      locale: blogPosts.locale,
      title: blogPosts.title,
      updatedAt: blogPosts.updatedAt,
    })
    .from(blogPosts)
    .where(sql`${blogPosts.status} = 'published' and ${blogPosts.updatedAt} < ${cutoff}`);

  for (const post of staleBlog) {
    const daysStale = Math.floor((Date.now() - post.updatedAt.getTime()) / 86400000);
    staleItems.push({
      type: "blog",
      id: post.id as string,
      slug: post.slug,
      locale: post.locale,
      title: post.title,
      updatedAt: post.updatedAt,
      daysStale,
    });
  }

  const staleHelp = await db
    .select({
      id: helpArticles.id,
      slug: helpArticles.slug,
      locale: helpArticles.locale,
      title: helpArticles.title,
      updatedAt: helpArticles.updatedAt,
    })
    .from(helpArticles)
    .where(sql`${helpArticles.status} = 'published' and ${helpArticles.updatedAt} < ${cutoff}`);

  for (const article of staleHelp) {
    const daysStale = Math.floor((Date.now() - article.updatedAt.getTime()) / 86400000);
    staleItems.push({
      type: "help",
      id: article.id as string,
      slug: article.slug,
      locale: article.locale,
      title: article.title,
      updatedAt: article.updatedAt,
      daysStale,
    });
  }

  const staleChangelog = await db
    .select({ id: changelogEntries.id, slug: changelogEntries.slug, locale: changelogEntries.locale, title: changelogEntries.title, updatedAt: changelogEntries.createdAt })
    .from(changelogEntries)
    .where(sql`${changelogEntries.status} = 'published' and ${changelogEntries.createdAt} < ${cutoff}`);
  for (const entry of staleChangelog) {
    staleItems.push({ type: "changelog", id: entry.id as string, slug: entry.slug, locale: entry.locale, title: entry.title, updatedAt: entry.updatedAt, daysStale: Math.floor((Date.now() - entry.updatedAt.getTime()) / 86400000) });
  }

  return { staleCount: staleItems.length, staleItems };
}

// ───────────────────────────────────────────────
// Broken link detection
// ───────────────────────────────────────────────

export function extractLinks(content: string): string[] {
  const links: string[] = [];
  const mdPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdPattern.exec(content)) !== null) {
    const url = match[2];
    if (url) links.push(url);
  }
  const htmlPattern = /<a\s[^>]*href=["']([^"']+)["']/gi;
  while ((match = htmlPattern.exec(content)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  return [...new Set(links)];
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    const c = parts[2] ?? -1;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))) ) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)) ) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (isIP(normalized) === 6) {
    // IPv4-mapped IPv6 addresses must be judged by the embedded IPv4 address.
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      if (isIP(mapped) === 4) return isPrivateAddress(mapped);
      const groups = mapped.split(":");
      if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
        const high = Number.parseInt(groups[0]!, 16);
        const low = Number.parseInt(groups[1]!, 16);
        return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return true;
    }
    // Reject loopback, unspecified, link-local, unique-local, multicast and
    // IPv4-compatible transition ranges. Public IPv6 addresses are allowed.
    return normalized === "::" || normalized === "::1" ||
      /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) ||
      /^ff/.test(normalized) || /^2002:/.test(normalized) ||
      /^2001:db8:/.test(normalized) || /^100:/.test(normalized);
  }
  return true;
}

async function validatePublicHttpUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("unsupported_url");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) {
    throw new Error("private_host_blocked");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("private_ip_blocked");
    return { url, address: host, family: isIP(host) };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("private_or_unresolvable_host_blocked");
  }
  // Pin the chosen, validated address in the HTTP request below. This avoids a
  // second DNS lookup and prevents DNS-rebinding between validation and fetch.
  return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}

async function requestPinned(url: URL, address: string, family: number, method: "HEAD" | "GET", timeoutMs: number): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    const pinnedLookup = (_hostname: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
      if (options?.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const requestOptions = {
      method,
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      timeout: timeoutMs,
      servername: url.protocol === "https:" && !isIP(url.hostname.replace(/^\[|\]$/g, "")) ? url.hostname : undefined,
      lookup: pinnedLookup as never,
    } as import("node:https").RequestOptions;
    const onResponse = (res: import("node:http").IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      res.destroy();
      resolve({ status, location });
    };
    const req = url.protocol === "https:"
      ? httpsRequest(url, requestOptions, onResponse)
      : httpRequest(url, requestOptions, onResponse);
    req.on("timeout", () => req.destroy(new Error("link_check_timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function checkLink(rawUrl: string): Promise<{ status: number | null; error: string | null }> {
  if (!/^https?:\/\//i.test(rawUrl)) return { status: null, error: null };
  const deadline = Date.now() + 10_000;
  try {
    let current = rawUrl;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = await validatePublicHttpUrl(current);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("link_check_timeout");
      let response = await requestPinned(target.url, target.address, target.family, "HEAD", remaining);
      if (response.status === 405 || response.status === 501) {
        const remainingForGet = deadline - Date.now();
        if (remainingForGet <= 0) throw new Error("link_check_timeout");
        response = await requestPinned(target.url, target.address, target.family, "GET", remainingForGet);
      }
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) return { status: response.status, error: "redirect_without_location" };
        if (redirects === 5) return { status: response.status, error: "too_many_redirects" };
        current = new URL(response.location, target.url).toString();
        continue;
      }
      return { status: response.status, error: null };
    }
    return { status: null, error: "too_many_redirects" };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkContentLinks(
  content: string,
  sourceType: ContentType,
  sourceId: string,
  sourceSlug: string,
): Promise<BrokenLink[]> {
  const links = extractLinks(content);
  const broken: BrokenLink[] = [];
  for (const url of links) {
    const { status, error } = await checkLink(url);
    if (status !== null && (status >= 400 || status < 200 || (status >= 300 && status < 400 && error !== null))) {
      broken.push({ url, sourceType, sourceId, sourceSlug, status, error });
    } else if (status === null && error !== null && !["localhost_blocked", "private_ip_blocked", "private_host_blocked", "private_or_unresolvable_host_blocked"].includes(error)) {
      broken.push({ url, sourceType, sourceId, sourceSlug, status: null, error });
    }
  }
  return broken;
}

export async function checkAllLinks(): Promise<BrokenLinkReport> {
  const [blogs, help, changelog] = await Promise.all([
    db.select({ id: blogPosts.id, slug: blogPosts.slug, body: blogPosts.body }).from(blogPosts).where(sql`${blogPosts.status} = 'published'`),
    db.select({ id: helpArticles.id, slug: helpArticles.slug, body: helpArticles.body }).from(helpArticles).where(sql`${helpArticles.status} = 'published'`),
    db.select({ id: changelogEntries.id, slug: changelogEntries.slug, body: changelogEntries.body }).from(changelogEntries).where(sql`${changelogEntries.status} = 'published'`),
  ]);
  const sources: Array<{ type: ContentType; id: string; slug: string; body: string }> = [
    ...blogs.map((r: { id: string; slug: string; body: string }) => ({ type: "blog" as const, id: String(r.id), slug: r.slug, body: r.body })),
    ...help.map((r: { id: string; slug: string; body: string }) => ({ type: "help" as const, id: String(r.id), slug: r.slug, body: r.body })),
    ...changelog.map((r: { id: string; slug: string; body: string }) => ({ type: "changelog" as const, id: String(r.id), slug: r.slug, body: r.body })),
  ];
  const siteOrigin = process.env.NEXT_PUBLIC_APP_URL;
  const links = sources.flatMap((source) => extractLinks(source.body).flatMap((raw) => {
    if (/^https?:\/\//i.test(raw)) return [{ ...source, url: raw }];
    if (siteOrigin && raw.startsWith("/") && !raw.startsWith("//")) {
      try { return [{ ...source, url: new URL(raw, siteOrigin).toString() }]; } catch { return []; }
    }
    return [];
  }));
  // Keep outbound checks bounded so a large content corpus cannot create an
  // unbounded number of concurrent network requests.
  const results: Array<BrokenLink | null> = new Array(links.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= links.length) return;
      const link = links[index]!;
      const result = await checkLink(link.url);
      const blocked = result.error === "private_host_blocked" || result.error === "private_ip_blocked" || result.error === "private_or_unresolvable_host_blocked";
      const isBroken = (result.status !== null && (result.status >= 400 || result.status < 200 || (result.status >= 300 && result.status < 400 && result.error !== null))) || (result.status === null && result.error !== null && !blocked);
      results[index] = isBroken ? { url: link.url, sourceType: link.type, sourceId: link.id, sourceSlug: link.slug, status: result.status, error: result.error } : null;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, links.length) }, () => worker()));
  const brokenLinks = results.filter((r): r is BrokenLink => r !== null);
  return { checkedCount: links.length, brokenCount: brokenLinks.length, brokenLinks };
}

// ───────────────────────────────────────────────
// Audit helpers
// ───────────────────────────────────────────────

export async function auditContentFreshness(report: FreshnessReport): Promise<void> {
  if (report.staleCount === 0) return;
  try {
    await adminAudit({
      actor: "system",
      action: "content.freshness.stale",
      target: {
        count: report.staleCount,
        types: [...new Set(report.staleItems.map((i) => i.type))],
        oldestDays: Math.max(...report.staleItems.map((i) => i.daysStale)),
      },
      justification: `nightly freshness check — ${report.staleCount} items not updated in > 365 days`,
    });
  } catch {
    // Audit failure must not fail the cron.
  }
}

export async function auditBrokenLinks(report: BrokenLinkReport): Promise<void> {
  if (report.brokenCount === 0) return;
  try {
    await adminAudit({
      actor: "system",
      action: "content.links.broken",
      target: {
        checked: report.checkedCount,
        broken: report.brokenCount,
        urls: report.brokenLinks.slice(0, 20).map((l) => l.url),
      },
      justification: `nightly broken link check — ${report.brokenCount} broken links found`,
    });
  } catch {
    // Audit failure must not fail the cron.
  }
}
