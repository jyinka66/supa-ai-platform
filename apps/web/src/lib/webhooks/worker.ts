// Webhook delivery worker — SSRF-safe delivery with HMAC signing + retry.
//
//   deliver(hook, body) — the core delivery function:
//     1. Parse the URL + resolve the hostname via DNS.
//     2. assertPublic(ip) for each resolved IP — reject RFC1918, loopback,
//        link-local, 169.254 (cloud metadata), IPv6 ULA.
//     3. fetchWithPinnedDns(url, ips, { timeout: 10s, maxRedirects: 0 }) —
//        connect to the resolved IP directly (DNS rebinding defense: the
//        hostname resolves to a public IP, but a second DNS query could
//        resolve to an internal IP — pinning prevents this).
//     4. maxRedirects: 0 — a 3xx could bounce to an internal address after
//        pinning. Reject all redirects.
//     5. Record the delivery result (status code, latency).
//
//   Signature: X-Signature header:
//     `t=<unix_timestamp>, v1=hmac_sha256(secret, t + "." + body)`
//     The recipient verifies: recompute hmac_sha256(secret, t + "." + body)
//     and compare with v1 (constant-time). The timestamp allows the recipient
//     to reject stale deliveries (replay defense).
//
//   Retry: exponential 1m/5m/30m/2h/6h → dead-letter after 5 failures.
//     The webhook is flagged as `active=false` (circuit breaker) after 5
//     consecutive failures. The admin re-enables via the UI.
//
//   processPendingV2(batchSize) — the cron worker that polls pending
//     deliveries + calls `deliver` for each.
//
// SSRF defenses (the DNS-rebinding class):
//   1. DNS resolve: get all IPs for the hostname.
//   2. assertPublic: reject private/loopback/link-local/metadata IPs.
//   3. Pin DNS: connect to the resolved IP directly (not re-resolve).
//   4. No redirects: maxRedirects=0 (a redirect could bypass the pin).

import { db } from "@supa/db";
import { webhooks, webhookDeliveriesV2 } from "@supa/db/schema";
import { eq, and, isNull, sql, lte } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface WebhookRow {
  id: string;
  url: string;
  secret: Buffer;
  events: string[];
  active: boolean;
}

export interface DeliveryResult {
  statusCode: number;
  delivered: boolean;
  error?: string;
}

export interface ProcessPendingResult {
  processed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000; // 10s.
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600]; // 1m, 5m, 30m, 2h, 6h.
const MAX_SIGNATURE_AGE_SECONDS = 300; // 5 min (recipient rejects stale signatures).

// ───────────────────────────────────────────────
// SSRF defenses
// ───────────────────────────────────────────────

/**
 * Check if an IP address is public (not private, loopback, link-local, or
 * cloud metadata). Rejects:
 *   - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
 *   - Loopback: 127.0.0.0/8.
 *   - Link-local: 169.254.0.0/16 (includes AWS/GCP metadata 169.254.169.254).
 *   - IPv6: ::1 (loopback), fe80::/10 (link-local), fc00::/7 (ULA).
 *   - 0.0.0.0 (unspecified).
 */
export function assertPublic(ip: string): void {
  // IPv4.
  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      throw new Error(`invalid_ip:${ip}`);
    }
    const [a, b] = parts;
    const aNum = a as number;
    const bNum = b as number;
    // 0.0.0.0/8.
    if (aNum === 0) throw new Error(`ip_blocked:unspecified:${ip}`);
    // 10.0.0.0/8.
    if (aNum === 10) throw new Error(`ip_blocked:private:${ip}`);
    // 127.0.0.0/8.
    if (aNum === 127) throw new Error(`ip_blocked:loopback:${ip}`);
    // 169.254.0.0/16 (cloud metadata, link-local).
    if (aNum === 169 && bNum === 254) throw new Error(`ip_blocked:link_local:${ip}`);
    // 172.16.0.0/12.
    if (aNum === 172 && bNum! >= 16 && bNum! <= 31) throw new Error(`ip_blocked:private:${ip}`);
    // 192.168.0.0/16.
    if (aNum === 192 && bNum === 168) throw new Error(`ip_blocked:private:${ip}`);
    // 100.64.0.0/10 (CGNAT).
    if (aNum === 100 && bNum! >= 64 && bNum! <= 127) throw new Error(`ip_blocked:cgnat:${ip}`);
    return;
  }

  // IPv6.
  if (ip === "::1") throw new Error(`ip_blocked:loopback:${ip}`);
  if (ip === "::") throw new Error(`ip_blocked:unspecified:${ip}`);
  if (ip.startsWith("fe80:")) throw new Error(`ip_blocked:link_local:${ip}`);
  if (ip.startsWith("fc") || ip.startsWith("fd")) throw new Error(`ip_blocked:ula:${ip}`);
}

/**
 * Resolve a hostname to IP addresses via DNS.
 * Returns all A + AAAA records.
 */
async function resolve(hostname: string): Promise<string[]> {
  try {
    const records = await dnsLookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    throw new Error(`dns_resolve_failed:${hostname}`);
  }
}

/**
 * Fetch with pinned DNS — connect to the resolved IP directly (not re-resolve).
 *
 * This is the DNS-rebinding defense: the hostname may resolve to a public IP
 * on the first query, but a second DNS query (by `fetch`) could resolve to
 * an internal IP. Pinning the IP prevents this.
 *
 * Implementation: set the `Host` header to the original hostname + replace
 * the hostname in the URL with the resolved IP. The `Host` header ensures
 * the target server routes the request correctly (virtual hosting).
 *
 * maxRedirects: 0 — a 3xx could bounce to an internal address after pinning.
 *
 * Stub — the real impl would use a custom `Agent` that connects to the pinned
 * IP. The `fetch` API doesn't support IP pinning natively (it re-resolves
 * the hostname). In production, use `undici` with a custom `connect` option
 * or `node:http` with a custom `lookup` function.
 */
async function fetchWithPinnedDns(
  url: string,
  ips: string[],
  opts: { timeout: number; maxRedirects: number },
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  // Validate: no redirects allowed.
  if (opts.maxRedirects !== 0) {
    throw new Error("redirects_not_allowed");
  }

  // Pin: use the first resolved IP. Replace the hostname in the URL.
  const pinnedIp = ips[0]!;
  const parsedUrl = new URL(url);
  const originalHost = parsedUrl.host;
  const pinnedUrl = new URL(url);
  // For IPv6, wrap in brackets: [::1] → [2001:db8::1].
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;

  // Fetch with the pinned URL + Host header (for virtual hosting).
  // Note: this is a simplification — `fetch` may still re-resolve the hostname.
  // In production, use `undici` with `connect: { lookup: () => pinnedIp }`.
  const response = await fetch(pinnedUrl, {
    method: "POST",
    headers: {
      ...headers,
      Host: originalHost, // preserve the original Host header.
    },
    body,
    signal: AbortSignal.timeout(opts.timeout),
    redirect: "error", // reject redirects (maxRedirects: 0).
  });

  return { status: response.status };
}

// ───────────────────────────────────────────────
// HMAC signature
// ───────────────────────────────────────────────

/**
 * Sign a webhook delivery body.
 *
 * Format: `t=<unix_timestamp>, v1=<hmac_hex>`
 *   - `t` is the Unix timestamp (seconds) when the delivery was sent.
 *   - `v1` is the HMAC-SHA256 of `t + "." + body` using the webhook's secret.
 *
 * The recipient verifies:
 *   1. Split the header: `t=<ts>, v1=<hmac>`.
 *   2. Check `t` is within MAX_SIGNATURE_AGE_SECONDS (5 min) — reject stale.
 *   3. Recompute `hmac_sha256(secret, t + "." + body)`.
 *   4. Constant-time compare with `v1`.
 */
export function signDelivery(secret: Buffer, body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const hmac = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp}, v1=${hmac}`;
}

/**
 * Verify a webhook signature (constant-time compare).
 * Used by our own verification tooling (for testing webhook delivery).
 */
export function verifySignature(
  header: string,
  body: string,
  secret: Buffer,
  maxAgeSeconds: number = MAX_SIGNATURE_AGE_SECONDS,
): boolean {
  // Parse: t=<ts>, v1=<hmac>.
  const match = header.match(/^t=(\d+), v1=([a-f0-9]+)$/);
  if (!match) return false;

  const timestamp = parseInt(match[1]!, 10);
  const signature = match[2]!;

  // Check timestamp freshness.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxAgeSeconds) return false;

  // Recompute HMAC.
  const signedPayload = `${timestamp}.${body}`;
  const expectedHmac = createHmac("sha256", secret).update(signedPayload).digest("hex");

  // Constant-time compare.
  if (expectedHmac.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// deliver — the core delivery function (SSRF-safe)
// ───────────────────────────────────────────────

/**
 * Deliver a webhook. SSRF-safe:
 *   1. Parse the URL + resolve the hostname.
 *   2. assertPublic for each resolved IP.
 *   3. fetchWithPinnedDns (pin the IP, no redirects, 10s timeout).
 *   4. Record the result.
 *
 * The delivery is signed: `X-Signature: t=<unix>, v1=hmac_sha256(secret, t + "." + body)`.
 * The recipient verifies the signature + checks the timestamp freshness.
 */
export async function deliver(
  hook: WebhookRow,
  body: string,
): Promise<DeliveryResult> {
  try {
    // Parse the URL.
    const parsedUrl = new URL(hook.url);
    const host = parsedUrl.hostname;

    // DNS resolve.
    const ips = await resolve(host);
    if (ips.length === 0) {
      return { statusCode: 0, delivered: false, error: "dns_no_records" };
    }

    // SSRF defense: reject private/loopback/link-local IPs.
    for (const ip of ips) {
      assertPublic(ip);
    }

    // Sign the delivery.
    const signature = signDelivery(hook.secret, body);

    // Fetch with pinned DNS (no redirects, 10s timeout).
    const result = await fetchWithPinnedDns(hook.url, ips, {
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
    }, body, {
      "Content-Type": "application/json",
      "X-Signature": signature,
    });

    if (result.status >= 200 && result.status < 300) {
      return { statusCode: result.status, delivered: true };
    }

    // Non-2xx → failure (will be retried by processPendingV2).
    return { statusCode: result.status, delivered: false, error: `http_${result.status}` };
  } catch (err: any) {
    // Network error / SSRF block / timeout.
    return {
      statusCode: 0,
      delivered: false,
      error: err?.message ?? "unknown_error",
    };
  }
}

// ───────────────────────────────────────────────
// processPendingV2 — the cron worker
// ───────────────────────────────────────────────

/**
 * Process pending webhook deliveries (v2). Polls deliveries with
 * `delivered_at IS NULL` AND (`next_retry_at IS NULL` OR `next_retry_at <= now()`).
 *
 * For each:
 *   1. Fetch the webhook row (url, secret, active).
 *   2. If the webhook is inactive (circuit breaker) → skip (mark delivery as skipped).
 *   3. Call `deliver(hook, body)`.
 *   4. On success: set `delivered_at`, `last_status`.
 *   5. On failure: increment `attempt`, set `next_retry_at` (exponential backoff).
 *      If `attempt >= MAX_ATTEMPTS`: set `last_status` + flag webhook as
 *      `active=false` (dead-letter / circuit breaker).
 *
 * Returns a summary.
 */
export async function processPendingV2(
  batchSize: number = 50,
): Promise<ProcessPendingResult> {
  const result: ProcessPendingResult = {
    processed: 0,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
  };

  // Fetch pending deliveries.
  const pending = await db
    .select({
      id: webhookDeliveriesV2.id,
      webhookId: webhookDeliveriesV2.webhookId,
      eventType: webhookDeliveriesV2.eventType,
      payload: webhookDeliveriesV2.payload,
      attempt: webhookDeliveriesV2.attempt,
    })
    .from(webhookDeliveriesV2)
    .where(
      and(
        isNull(webhookDeliveriesV2.deliveredAt),
        sql`(${webhookDeliveriesV2.nextRetryAt} is null or ${webhookDeliveriesV2.nextRetryAt} <= now())`,
      ),
    )
    .limit(batchSize);

  for (const delivery of pending) {
    // Fetch the webhook.
    const hookRows = await db
      .select({
        id: webhooks.id,
        url: webhooks.url,
        secret: webhooks.secret,
        events: webhooks.events,
        active: webhooks.active,
      })
      .from(webhooks)
      .where(eq(webhooks.id, delivery.webhookId as any))
      .limit(1);
    const hook = hookRows[0];
    if (!hook || !hook.active) {
      // Webhook deleted or inactive (circuit breaker) → skip.
      await db
        .update(webhookDeliveriesV2)
        .set({ lastStatus: 0, nextRetryAt: null })
        .where(eq(webhookDeliveriesV2.id, delivery.id as any));
      result.processed++;
      continue;
    }

    // Deliver.
    const body = JSON.stringify(delivery.payload);
    const res = await deliver(hook as unknown as WebhookRow, body);

    if (res.delivered) {
      // Success.
      await db
        .update(webhookDeliveriesV2)
        .set({
          deliveredAt: new Date(),
          lastStatus: res.statusCode,
          nextRetryAt: null,
        })
        .where(eq(webhookDeliveriesV2.id, delivery.id as any));
      result.delivered++;
    } else {
      // Failure.
      const newAttempt = (delivery.attempt ?? 0) + 1;
      if (newAttempt >= MAX_ATTEMPTS) {
        // Dead-letter: mark delivery as failed + deactivate webhook.
        await db
          .update(webhookDeliveriesV2)
          .set({
            attempt: newAttempt,
            lastStatus: res.statusCode,
            nextRetryAt: null,
          })
          .where(eq(webhookDeliveriesV2.id, delivery.id as any));

        // Circuit breaker: deactivate the webhook.
        await db
          .update(webhooks)
          .set({ active: false })
          .where(eq(webhooks.id, hook.id as any));

        result.deadLettered++;
      } else {
        // Retry with exponential backoff.
        const backoffIndex = Math.min(newAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1);
        const backoffSeconds = RETRY_BACKOFF_SECONDS[backoffIndex]!;
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000);

        await db
          .update(webhookDeliveriesV2)
          .set({
            attempt: newAttempt,
            lastStatus: res.statusCode,
            nextRetryAt: nextRetry,
          })
          .where(eq(webhookDeliveriesV2.id, delivery.id as any));
      }
      result.failed++;
    }
    result.processed++;
  }

  return result;
}
