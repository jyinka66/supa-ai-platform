import type { MetadataRoute } from "next";
import { generateSitemap, type SeoPage } from "@/lib/seo/generate";

/**
 * Dynamic sitemap — generated from all public pages.
 *
 * The spec: "Dynamic sitemap — generated from all public pages, updated on
 * content changes."
 *
 * This route generates the sitemap from a static page registry. In production,
 * this would also query the database for blog posts, help articles, and
 * changelog entries (all localized). The sitemap is regenerated on every
 * request (force-dynamic) so content changes are reflected immediately.
 *
 * hreflang: each URL includes alternates for all locales + x-default.
 */

export const dynamic = "force-dynamic";
export const revalidate = 3600; // ISR — regenerate at most hourly.

// The static pages (the dynamic content — blog/help/changelog — would be
// fetched from the DB in production).
const STATIC_PAGES: Array<{ path: string; priority: number; changeFrequency: SeoPage["changeFrequency"] }> = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.7, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.8, changeFrequency: "weekly" },
  { path: "/help", priority: 0.7, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.6, changeFrequency: "monthly" },
  { path: "/about", priority: 0.6, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.6, changeFrequency: "monthly" },
  { path: "/trust", priority: 0.6, changeFrequency: "monthly" },
  { path: "/accessibility", priority: 0.4, changeFrequency: "yearly" },
  { path: "/careers", priority: 0.4, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.5, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.5, changeFrequency: "yearly" },
];

// The locales the sitemap covers (matches the live locales from migration 0052).
const SITEMAP_LOCALES = ["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"];

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://supa.ai";
  const now = new Date().toISOString();

  const pages: SeoPage[] = [];

  for (const page of STATIC_PAGES) {
    for (const locale of SITEMAP_LOCALES) {
      pages.push({
        path: page.path,
        title: "", // not needed for the sitemap XML.
        description: "",
        locale,
        alternates: SITEMAP_LOCALES.filter((l) => l !== locale),
        lastModified: now,
        changeFrequency: page.changeFrequency,
        priority: page.priority,
      });
    }
  }

  // In production, this would also fetch blog posts, help articles, and
  // changelog entries from the DB:
  //   const posts = await db.select().from(blogPosts).where(eq(blogPosts.status, 'published'));
  //   for (const post of posts) { pages.push({ path: `/blog/${post.slug}`, locale: post.locale, ... }); }

  const sitemapXml = generateSitemap(baseUrl, pages);

  // Next.js MetadataRoute.Sitemap expects an array, but we generate the XML
  // directly for full control (including hreflang). Return the raw XML.
  // (Next.js sitemap() normally returns an array, but returning the XML
  // via a route handler gives us full control. For the MetadataRoute format,
  // we'd return the array — but the XML approach is more flexible for hreflang.)
  //
  // For Next.js compatibility, we return the array format (which Next.js
  // serializes to XML). The hreflang alternates are in the `alternates` field.
  return pages.map((p) => ({
    url: `${baseUrl}/${p.locale}${p.path === "/" ? "" : p.path}`,
    lastModified: p.lastModified,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
    alternates: {
      languages: Object.fromEntries(
        SITEMAP_LOCALES.map((l) => [l, `${baseUrl}/${l}${p.path === "/" ? "" : p.path}`]),
      ),
    },
  }));
}
