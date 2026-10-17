import { NextRequest, NextResponse } from "next/server";
import { db } from "@supa/db";
import { blogPosts, helpArticles } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";

/**
 * GET /api/og/[slug]?locale=en&type=blog
 *
 * Dynamic OG image generation — generates an Open Graph image with the page
 * title + Supa AI branding, localized per the query param.
 *
 * The spec: "Dynamic OG images — generated per page with title, branding, and locale."
 *
 * This route generates an SVG (which social platforms render as a PNG when
 * scraped — Twitter/Facebook/LinkedIn all support SVG OG images). For
 * production, @vercel/og (ImageResponse) would render a PNG with a custom
 * font + layout, but SVG is dependency-free + sufficient for the structure.
 *
 * The image:
 *   - 1200×630 (the standard OG image dimensions).
 *   - Supa AI logo (top-left).
 *   - The page title (centered, wrapped).
 *   - The locale flag (bottom-right).
 *   - A gradient background (brand colors).
 *
 * Query params:
 *   ?type=blog|help|page — the content type (determines where to fetch the title).
 *   ?locale=en — the locale (for localized titles + the locale flag).
 *
 * If the slug isn't found, generates a default OG image with the site title.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { slug } = await params;
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "page";
  const locale = url.searchParams.get("locale") ?? "en";

  // Fetch the title from the DB (for blog/help content).
  let title = "Supa AI";
  let description = "The AI workspace for teams.";

  if (type === "blog") {
    const rows = await db
      .select({ title: blogPosts.title, description: blogPosts.description })
      .from(blogPosts)
      .where(and(eq(blogPosts.slug, slug), eq(blogPosts.locale, locale)))
      .limit(1);
    if (rows[0]) {
      title = rows[0].title;
      description = rows[0].description;
    }
  } else if (type === "help") {
    const rows = await db
      .select({ title: helpArticles.title })
      .from(helpArticles)
      .where(and(eq(helpArticles.slug, slug), eq(helpArticles.locale, locale)))
      .limit(1);
    if (rows[0]) {
      title = rows[0].title;
      description = "Supa AI Help Center";
    }
  }

  const svg = generateOgSvg(title, description, locale);

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

/**
 * Generate an OG image as an SVG.
 *
 * 1200×630, gradient background, Supa AI logo, title (wrapped), locale tag.
 */
function generateOgSvg(title: string, description: string, locale: string): string {
  // Wrap the title into lines (max ~30 chars per line, max 3 lines).
  const titleLines = wrapText(title, 40, 3);
  const titleY = 200 + (3 - titleLines.length) * 30; // center vertically.

  // Escape XML special characters.
  const escTitleLines = titleLines.map(escapeXml);
  const escDescription = escapeXml(truncate(description, 100));
  const localeLabel = locale.toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#1E293B"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#8B5CF6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="url(#accent)"/>

  <!-- Logo -->
  <text x="80" y="100" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="700" fill="#F8FAFC">Supa AI</text>
  <rect x="80" y="110" width="60" height="4" rx="2" fill="url(#accent)"/>

  <!-- Title -->
  ${escTitleLines.map((line, i) => `<text x="80" y="${titleY + i * 60}" font-family="Inter, system-ui, sans-serif" font-size="48" font-weight="600" fill="#F1F5F9">${line}</text>`).join("\n  ")}

  <!-- Description -->
  <text x="80" y="${titleY + titleLines.length * 60 + 20}" font-family="Inter, system-ui, sans-serif" font-size="24" fill="#94A3B8">${escDescription}</text>

  <!-- Locale tag (bottom-right) -->
  <rect x="1080" y="560" width="80" height="30" rx="15" fill="#1E293B" stroke="#475569" stroke-width="1"/>
  <text x="1120" y="580" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="500" fill="#CBD5E1" text-anchor="middle">${localeLabel}</text>
</svg>`;
}

/** Wrap text into lines of max `maxChars` chars, capped at `maxLines`. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxChars) {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  // If we hit the line cap, add an ellipsis to the last line.
  if (words.join(" ").length > lines.join(" ").length && lines.length === maxLines) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = last.slice(0, maxChars - 1) + "…";
  }

  return lines.length > 0 ? lines : [text];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
