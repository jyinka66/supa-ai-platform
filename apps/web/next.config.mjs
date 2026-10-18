import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next build` type-checks only application code. Tests are still covered by
  // `bun run typecheck` (tsconfig.json), so type errors in them do not block deploys.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Vercel creates its own serverless output. Keep standalone output for the Docker deployment.
  ...(process.env.VERCEL === "1" ? {} : { output: "standalone" }),
  // The TypeScript source uses NodeNext-style ".js" specifiers for local modules.
  // Next/Webpack does not map those to the corresponding .ts/.tsx files by default.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
