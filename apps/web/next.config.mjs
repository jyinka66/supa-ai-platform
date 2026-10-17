/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'nonce-{NONCE}' https://eu.i.posthog.com",
      "style-src 'self' 'unsafe-inline'", // tokens-inlined CSS; tightened in Phase 0 week 3
      "img-src 'self' data: blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Vercel creates its own serverless output. Keep standalone output for the Docker deployment.\n  ...(process.env.VERCEL === "1" ? {} : { output: "standalone" }),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
