/**
 * SSRF probe suite against the egress proxy.
 *
 * Fires the SSRF_PROBES corpus against `preCheckUrl` (URL pre-check)
 * and `isBlockedIp` (post-DNS IP-literal check). Each probe asserts
 * that the egress proxy blocks (or allows) the URL as expected.
 *
 * Categories covered:
 *   - cloud metadata endpoints (AWS/GCP/Azure)
 *   - loopback (IPv4 + IPv6)
 *   - RFC1918 private ranges
 *   - link-local (incl. 169.254.169.254)
 *   - unique-local IPv6
 *   - CGNAT
 *   - IPv4-mapped IPv6 (the sneaky bypass)
 *   - scheme injection (http:, file:, javascript:, data:)
 *   - malformed URLs
 *   - public URLs (sanity — not all blocked)
 */

import { describe, it, expect } from "vitest";
import { SSRF_PROBES, IP_LITERAL_PROBES } from "./fixtures/ssrf-probes.js";
import { isBlockedIp, preCheckUrl, DEFAULT_EGRESS_CONFIG } from "../src/boundary-5-platform.js";

// ───────────────────────────────────────────────
// IP-literal probes
// ───────────────────────────────────────────────

describe("SSRF egress — IP-literal blocking (post-DNS resolution)", () => {
  for (const probe of IP_LITERAL_PROBES) {
    it(`isBlockedIp("${probe.ip}") → ${probe.expectBlocked ? "blocked" : "allowed"}`, () => {
      const result = isBlockedIp(probe.ip);
      expect(result.blocked).toBe(probe.expectBlocked);
      if (probe.expectBlocked && probe.reasonContains) {
        expect(result.reason?.toLowerCase()).toContain(probe.reasonContains.toLowerCase());
      }
    });
  }

  it("IPv4-mapped IPv6 bypass attempt fails for metadata IP", () => {
    // The classic cloud kill via IPv4-mapped IPv6.
    const result = isBlockedIp("::ffff:169.254.169.254");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("link-local");
  });

  it("IPv4-mapped IPv6 bypass attempt fails for loopback", () => {
    const result = isBlockedIp("::ffff:127.0.0.1");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("loopback");
  });

  it("public IPs are not blocked", () => {
    expect(isBlockedIp("8.8.8.8").blocked).toBe(false);
    expect(isBlockedIp("1.1.1.1").blocked).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111").blocked).toBe(false);
  });
});

// ───────────────────────────────────────────────
// URL pre-check probes
// ───────────────────────────────────────────────

describe("SSRF egress — URL pre-check (pre-DNS)", () => {
  for (const probe of SSRF_PROBES) {
    it(`preCheckUrl("${probe.name}") → ${probe.expectBlocked ? "blocked" : "allowed"}`, () => {
      const result = preCheckUrl(probe.url);
      expect(result.blocked).toBe(probe.expectBlocked);
      if (probe.expectBlocked && probe.expectReasonContains) {
        expect(result.reason?.toLowerCase()).toContain(
          probe.expectReasonContains.toLowerCase(),
        );
      }
    });
  }

  it("cloud metadata IP is blocked", () => {
    // Use https — http would be caught by the scheme check, hiding
    // the IP-class failure we're testing.
    const result = preCheckUrl("https://169.254.169.254/latest/meta-data/");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("link-local");
  });

  it("cloud metadata hostname is blocked (defense in depth)", () => {
    const result = preCheckUrl("https://metadata.google.internal/computeMetadata/v1/");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("metadata hostname");
  });

  it("non-https schemes are blocked", () => {
    expect(preCheckUrl("http://example.com/").blocked).toBe(true);
    expect(preCheckUrl("file:///etc/passwd").blocked).toBe(true);
    expect(preCheckUrl("javascript:alert(1)").blocked).toBe(true);
    expect(preCheckUrl("data:text/html,<script>").blocked).toBe(true);
  });

  it("https public URLs are allowed", () => {
    expect(preCheckUrl("https://example.com/image.png").blocked).toBe(false);
    expect(preCheckUrl("https://1.1.1.1/").blocked).toBe(false);
  });

  it("malformed URLs are blocked", () => {
    expect(preCheckUrl("not a url").blocked).toBe(true);
    expect(preCheckUrl("").blocked).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Egress config defaults
// ───────────────────────────────────────────────

describe("SSRF egress — config defaults", () => {
  it("max redirects is 3 (DNS-rebinding defense via redirect re-check)", () => {
    expect(DEFAULT_EGRESS_CONFIG.maxRedirects).toBe(3);
  });

  it("connect timeout is 5s", () => {
    expect(DEFAULT_EGRESS_CONFIG.connectTimeoutMs).toBe(5_000);
  });

  it("read timeout is 30s", () => {
    expect(DEFAULT_EGRESS_CONFIG.readTimeoutMs).toBe(30_000);
  });

  it("max response size is 50 MiB", () => {
    expect(DEFAULT_EGRESS_CONFIG.maxResponseBytes).toBe(50 * 1024 * 1024);
  });
});

// ───────────────────────────────────────────────
// DNS-rebinding contract (documented, not runnable in unit tests)
// ───────────────────────────────────────────────

describe("SSRF egress — DNS-rebinding contract", () => {
  it("documented contract: resolve-then-connect on pinned IP", () => {
    // The egress proxy contract requires:
    //   1. Resolve hostname to IP.
    //   2. Pin the IP — don't re-resolve at connect time.
    //   3. Run isBlockedIp on the resolved IP.
    //   4. Connect to the pinned IP, with Host header set to original.
    //
    // This defends against DNS-rebinding where an attacker's DNS
    // returns a public IP at first resolution (passes the check) and
    // an internal IP at second resolution (the actual connect).
    //
    // We can't test the actual DNS path in unit tests, but we test
    // that the IP check catches all the internal IPs an attacker
    // would rebind to:
    const rebindTargets = [
      "169.254.169.254", // cloud metadata
      "127.0.0.1",       // loopback
      "10.0.0.1",         // private
      "192.168.1.1",      // private
      "::1",              // IPv6 loopback
      "fe80::1",          // IPv6 link-local
    ];
    for (const ip of rebindTargets) {
      expect(isBlockedIp(ip).blocked).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────
// Redirect caps contract
// ───────────────────────────────────────────────

describe("SSRF egress — redirect cap contract", () => {
  it("maxRedirects=3 means no chain longer than 3 hops", () => {
    // The egress proxy follows redirects itself (not the caller).
    // Each hop re-runs isBlockedIp on the resolved IP.
    // A redirect chain to internal IPs is blocked at every hop.
    //
    // We can't test the actual HTTP path in unit tests, but the
    // contract is: maxRedirects=3, and each redirect's Location URL
    // is preCheckUrl'd before following.
    expect(DEFAULT_EGRESS_CONFIG.maxRedirects).toBe(3);
    // Verify each hop's URL would be checked:
    expect(preCheckUrl("http://169.254.169.254/").blocked).toBe(true);
    expect(preCheckUrl("http://10.0.0.1/").blocked).toBe(true);
    expect(preCheckUrl("http://127.0.0.1/").blocked).toBe(true);
  });
});
