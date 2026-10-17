/**
 * SSRF probe suite — URLs to fire at the egress proxy.
 *
 * Categories:
 *   - metadata: cloud metadata endpoints (the classic cloud kill)
 *   - loopback: 127/8 and ::1
 *   - private: RFC1918 ranges
 *   - link-local: 169.254/16 and fe80::/10
 *   - cgnat: 100.64/10
 *   - ipv4-mapped-ipv6: ::ffff:<internal>
 *   - scheme-injection: non-https schemes
 *   - hostname-tricks: metadata hostnames, decimal/octal IP encodings
 *   - redirect: redirect chains to internal IPs (contract test)
 *   - dns-rebinding: documented contract (DNS isn't available in unit tests)
 */

export interface SsrfProbe {
  name: string;
  url: string;
  /** Expected: blocked=true, with reason containing one of these substrings. */
  expectBlocked: boolean;
  expectReasonContains?: string;
}

export const SSRF_PROBES: SsrfProbe[] = [
  // ─── Cloud metadata ───
  {
    name: "aws-metadata-ipv4",
    url: "https://169.254.169.254/latest/meta-data/",
    expectBlocked: true,
    expectReasonContains: "link-local",
  },
  {
    name: "gcp-metadata-ipv4",
    url: "https://metadata.google.internal/computeMetadata/v1/",
    expectBlocked: true,
    expectReasonContains: "metadata hostname",
  },
  {
    name: "azure-metadata",
    url: "https://169.254.169.254/metadata/instance?api-version=2021-02-01",
    expectBlocked: true,
    expectReasonContains: "link-local",
  },

  // ─── Loopback ───
  {
    name: "loopback-ipv4",
    url: "https://127.0.0.1/",
    expectBlocked: true,
    expectReasonContains: "loopback",
  },
  {
    name: "loopback-ipv6",
    url: "https://[::1]/",
    expectBlocked: true,
    expectReasonContains: "loopback",
  },
  {
    name: "loopback-127-other",
    url: "https://127.0.0.2/",
    expectBlocked: true,
    expectReasonContains: "loopback",
  },

  // ─── RFC1918 ───
  {
    name: "private-10",
    url: "https://10.0.0.1/",
    expectBlocked: true,
    expectReasonContains: "RFC1918",
  },
  {
    name: "private-172",
    url: "https://172.16.0.1/",
    expectBlocked: true,
    expectReasonContains: "RFC1918",
  },
  {
    name: "private-192",
    url: "https://192.168.1.1/",
    expectBlocked: true,
    expectReasonContains: "RFC1918",
  },

  // ─── Link-local IPv6 ───
  {
    name: "link-local-ipv6",
    url: "https://[fe80::1]/",
    expectBlocked: true,
    expectReasonContains: "link-local",
  },

  // ─── Unique-local IPv6 ───
  {
    name: "unique-local-ipv6",
    url: "https://[fc00::1]/",
    expectBlocked: true,
    expectReasonContains: "unique-local",
  },
  {
    name: "unique-local-ipv6-fd",
    url: "https://[fd00::1]/",
    expectBlocked: true,
    expectReasonContains: "unique-local",
  },

  // ─── CGNAT ───
  {
    name: "cgnat",
    url: "https://100.64.0.1/",
    expectBlocked: true,
    expectReasonContains: "CGNAT",
  },

  // ─── IPv4-mapped IPv6 (the sneaky bypass) ───
  {
    name: "ipv4-mapped-metadata",
    url: "https://[::ffff:169.254.169.254]/latest/meta-data/",
    expectBlocked: true,
    expectReasonContains: "link-local",
  },
  {
    name: "ipv4-mapped-loopback",
    url: "https://[::ffff:127.0.0.1]/",
    expectBlocked: true,
    expectReasonContains: "loopback",
  },
  {
    name: "ipv4-mapped-private-10",
    url: "https://[::ffff:10.0.0.1]/",
    expectBlocked: true,
    expectReasonContains: "RFC1918",
  },

  // ─── Scheme injection ───
  {
    name: "http-not-https",
    url: "http://example.com/",
    expectBlocked: true,
    expectReasonContains: "scheme",
  },
  {
    name: "file-scheme",
    url: "file:///etc/passwd",
    expectBlocked: true,
    expectReasonContains: "scheme",
  },
  {
    name: "javascript-scheme",
    url: "javascript:alert(1)",
    expectBlocked: true,
    expectReasonContains: "scheme",
  },
  {
    name: "data-scheme",
    url: "data:text/html,<script>alert(1)</script>",
    expectBlocked: true,
    expectReasonContains: "scheme",
  },

  // ─── Malformed ───
  {
    name: "not-a-url",
    url: "this is not a url",
    expectBlocked: true,
    expectReasonContains: "malformed",
  },

  // ─── Allowed (sanity check — not all URLs blocked) ───
  {
    name: "https-public",
    url: "https://example.com/image.png",
    expectBlocked: false,
  },
  {
    name: "https-public-ipv4",
    url: "https://1.1.1.1/",
    expectBlocked: false,
  },
];

/**
 * IP-literal probes for `isBlockedIp()` — the lower-level check that
 * runs after DNS resolution.
 */
export const IP_LITERAL_PROBES: { ip: string; expectBlocked: boolean; reasonContains?: string }[] = [
  { ip: "169.254.169.254", expectBlocked: true, reasonContains: "link-local" },
  { ip: "127.0.0.1", expectBlocked: true, reasonContains: "loopback" },
  { ip: "10.0.0.1", expectBlocked: true, reasonContains: "RFC1918" },
  { ip: "172.16.0.1", expectBlocked: true, reasonContains: "RFC1918" },
  { ip: "172.31.255.255", expectBlocked: true, reasonContains: "RFC1918" },
  { ip: "172.32.0.0", expectBlocked: false },
  { ip: "192.168.1.1", expectBlocked: true, reasonContains: "RFC1918" },
  { ip: "100.64.0.1", expectBlocked: true, reasonContains: "CGNAT" },
  { ip: "0.0.0.0", expectBlocked: true, reasonContains: "0/8" },
  { ip: "8.8.8.8", expectBlocked: false },
  { ip: "1.1.1.1", expectBlocked: false },
  // IPv6
  { ip: "::1", expectBlocked: true, reasonContains: "loopback" },
  { ip: "fe80::1", expectBlocked: true, reasonContains: "link-local" },
  { ip: "fc00::1", expectBlocked: true, reasonContains: "unique-local" },
  { ip: "fd12:3456::1", expectBlocked: true, reasonContains: "unique-local" },
  { ip: "2606:4700:4700::1111", expectBlocked: false }, // Cloudflare DNS, public
  // IPv4-mapped IPv6
  { ip: "::ffff:169.254.169.254", expectBlocked: true, reasonContains: "link-local" },
  { ip: "::ffff:127.0.0.1", expectBlocked: true, reasonContains: "loopback" },
  { ip: "::ffff:10.0.0.1", expectBlocked: true, reasonContains: "RFC1918" },
  { ip: "::ffff:8.8.8.8", expectBlocked: false },
];
