// SEO generation — sitemaps, metadata, hreflang, JSON-LD.
//
// The spec: "SEO is generated, not hand-written. Sitemaps, metadata, OG images,
// JSON-LD, canonical URLs, and hreflang are all generated from content and
// page structure. No drift."
//
// All SEO artifacts are generated from a single source of truth (the page
// registry) — no hand-written metadata that can drift from the actual page.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface SeoPage {
  path: string;              // e.g. '/', '/dashboard', '/chat'
  title: string;             // the page title (locale-specific via SeoPageLocalized).
  description: string;       // the meta description.
  locale: string;            // the locale this entry is for.
  alternates: string[];      // other locales for this page (for hreflang).
  lastModified: string;      // ISO 8601 (for sitemap <lastmod>).
  changeFrequency: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority: number;          // 0.0 to 1.0.
  noindex?: boolean;         // if true, exclude from sitemap + add noindex meta.
  ogImage?: string;          // the OG image URL.
  jsonLd?: Record<string, unknown>; // structured data (JSON-LD).
}

// ───────────────────────────────────────────────
// Sitemap generation (XML)
// ───────────────────────────────────────────────

/**
 * Generate an XML sitemap from a list of pages.
 *
 * Format: https://www.sitemaps.org/protocol.html
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
 *           xmlns:xhtml="http://www.w3.org/1999/xhtml">
 *     <url>
 *       <loc>https://supa.ai/en</loc>
 *       <lastmod>2026-10-06</lastmod>
 *       <changefreq>weekly</changefreq>
 *       <priority>1.0</priority>
 *       <xhtml:link rel="alternate" hreflang="en" href="https://supa.ai/en" />
 *       <xhtml:link rel="alternate" hreflang="fr" href="https://supa.ai/fr" />
 *       <xhtml:link rel="alternate" hreflang="x-default" href="https://supa.ai/en" />
 *     </url>
 *   </urlset>
 */
export function generateSitemap(baseUrl: string, pages: SeoPage[]): string {
  const urlSet = pages
    .filter((p) => !p.noindex)
    .map((p) => {
      const loc = `${baseUrl}/${p.locale}${p.path === "/" ? "" : p.path}`;
      const alternates = p.alternates
        .map((alt) => `<xhtml:link rel="alternate" hreflang="${alt}" href="${baseUrl}/${alt}${p.path === "/" ? "" : p.path}" />`)
        .join("\n    ");
      const xDefault = `<xhtml:link rel="alternate" hreflang="x-default" href="${baseUrl}/en${p.path === "/" ? "" : p.path}" />`;
      return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${p.lastModified.split("T")[0]}</lastmod>
    <changefreq>${p.changeFrequency}</changefreq>
    <priority>${p.priority.toFixed(1)}</priority>
    ${alternates}
    ${xDefault}
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlSet}
</urlset>`;
}

// ───────────────────────────────────────────────
// Metadata generation (for Next.js generateMetadata)
// ───────────────────────────────────────────────

export interface PageMetadata {
  title: string;
  description: string;
  canonical: string;
  alternates: { languages: Record<string, string> };
  openGraph: {
    title: string;
    description: string;
    url: string;
    siteName: string;
    images: Array<{ url: string; width: number; height: number; alt: string }>;
  };
  twitter: {
    card: "summary_large_image" | "summary";
    title: string;
    description: string;
    images: string[];
  };
  robots: { index: boolean; follow: boolean };
  jsonLd?: Record<string, unknown> | undefined;
}

/**
 * Generate Next.js-compatible metadata for a page.
 */
export function generateMetadata(
  baseUrl: string,
  page: SeoPage,
): PageMetadata {
  const url = `${baseUrl}/${page.locale}${page.path === "/" ? "" : page.path}`;
  const languages: Record<string, string> = {};
  for (const alt of page.alternates) {
    languages[alt] = `${baseUrl}/${alt}${page.path === "/" ? "" : page.path}`;
  }
  languages["x-default"] = `${baseUrl}/en${page.path === "/" ? "" : page.path}`;

  return {
    title: page.title,
    description: page.description,
    canonical: url,
    alternates: { languages },
    openGraph: {
      title: page.title,
      description: page.description,
      url,
      siteName: "Supa AI",
      images: page.ogImage
        ? [{ url: page.ogImage, width: 1200, height: 630, alt: page.title }]
        : [],
    },
    twitter: {
      card: page.ogImage ? "summary_large_image" : "summary",
      title: page.title,
      description: page.description,
      images: page.ogImage ? [page.ogImage] : [],
    },
    robots: { index: !page.noindex, follow: true },
    jsonLd: page.jsonLd,
  };
}

// ───────────────────────────────────────────────
// JSON-LD generation (structured data)
// ───────────────────────────────────────────────

/**
 * Generate JSON-LD for the organization (for the homepage).
 */
export function generateOrganizationJsonLd(baseUrl: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Supa AI",
    url: baseUrl,
    logo: `${baseUrl}/logo.png`,
    sameAs: [
      "https://twitter.com/supaai",
      "https://github.com/supaai",
      "https://linkedin.com/company/supaai",
    ],
  };
}

/**
 * Generate JSON-LD for a software application (for the product page).
 */
export function generateSoftwareAppJsonLd(baseUrl: string, name: string, description: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name,
    description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    url: baseUrl,
  };
}

/**
 * Generate JSON-LD for a breadcrumb trail.
 */
export function generateBreadcrumbJsonLd(items: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Generate JSON-LD for an FAQ page.
 */
export function generateFaqJsonLd(faqs: Array<{ question: string; answer: string }>): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.answer,
      },
    })),
  };
}

// ───────────────────────────────────────────────
// Robots.txt generation
// ───────────────────────────────────────────────

/**
 * Generate robots.txt content.
 */
export function generateRobotsTxt(baseUrl: string, sitemapPath: string = "/sitemap.xml"): string {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /settings/
Disallow: /dashboard/

Sitemap: ${baseUrl}${sitemapPath}
`;
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
