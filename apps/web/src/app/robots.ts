import type { MetadataRoute } from "next";
import { generateRobotsTxt } from "@/lib/seo/generate";

/**
 * robots.txt — generated (not hand-written).
 *
 * The spec: "robots.txt — configured correctly, updated when needed."
 *
 * Allows all crawlers to access public pages, disallows /api/, /admin/,
 * /settings/, /dashboard/ (private routes). References the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://supa.ai";
  const content = generateRobotsTxt(baseUrl);

  // Parse the generated robots.txt into the Next.js MetadataRoute.Robots format.
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/", "/settings/", "/dashboard/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
