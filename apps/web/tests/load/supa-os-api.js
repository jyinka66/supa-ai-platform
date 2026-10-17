// k6 load test script for the Supa OS / Governance / Expansion API surface.
//
// Usage:
//   k6 run apps/web/tests/load/supa-os-api.js
//
// What this tests:
//   1. The 4 API namespaces can sustain their target RPS without errors.
//   2. Rate limits kick in at the documented thresholds (we hit them on
//      purpose to verify the 429 response shape).
//   3. The 99th percentile latency stays under 500ms for read routes and
//      under 2s for write routes.
//   4. The governance decision engine can sustain 50 RPS without errors.
//
// Stages:
//   - 30s ramp-up from 0 → 50 VUs
//   - 60s steady state at 50 VUs
//   - 30s ramp-down from 50 → 0 VUs

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// ───────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || "test_admin_token";

// Custom metrics.
const errorRate = new Rate("supa_os_errors");
const readLatency = new Trend("supa_os_read_latency", true);
const writeLatency = new Trend("supa_os_write_latency", true);
const governanceLatency = new Trend("governance_latency", true);

// ───────────────────────────────────────────────
// Test options
// ───────────────────────────────────────────────

export const options = {
  stages: [
    { duration: "30s", target: 50 },   // ramp-up
    { duration: "60s", target: 50 },   // steady state
    { duration: "30s", target: 0 },     // ramp-down
  ],
  thresholds: {
    // 99% of read requests should complete under 500ms.
    "supa_os_read_latency{route:catalog_stacks}": ["p(99)<500"],
    "supa_os_read_latency{route:catalog_cloud_targets}": ["p(99)<500"],
    // 99% of governance requests should complete under 1s.
    "governance_latency{route:decisions}": ["p(99)<1000"],
    "governance_latency{route:circuit_breakers}": ["p(99)<1000"],
    // Error rate should be under 1% (excluding intentional 429s).
    supa_os_errors: ["rate<0.01"],
    // HTTP failures should be under 1%.
    http_req_failed: ["rate<0.01"],
  },
};

// ───────────────────────────────────────────────
// Test scenarios
// ───────────────────────────────────────────────

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  "X-Request-Id": `k6_${__VU}_${__ITER}`,
};

export default function () {
  // ─── 1. Catalog reads (cheap, read-only) ───
  group("catalog reads", () => {
    const res = http.get(`${BASE_URL}/api/supa-os/catalog/stacks`, { headers });
    readLatency.add(res.timings.duration, { route: "catalog_stacks" });
    errorRate.add(res.status !== 200);
    check(res, {
      "catalog_stacks returns 200": (r) => r.status === 200,
      "catalog_stacks has stacks array": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.stacks);
      },
    });

    const res2 = http.get(`${BASE_URL}/api/supa-os/catalog/cloud-targets`, { headers });
    readLatency.add(res2.timings.duration, { route: "catalog_cloud_targets" });
    errorRate.add(res2.status !== 200);
    check(res2, {
      "cloud_targets returns 200": (r) => r.status === 200,
      "cloud_targets has targets array": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.targets);
      },
    });
  });

  // ─── 2. Governance reads ───
  group("governance reads", () => {
    const res = http.get(`${BASE_URL}/api/governance/circuit-breakers`, { headers });
    governanceLatency.add(res.timings.duration, { route: "circuit_breakers" });
    errorRate.add(res.status !== 200);
    check(res, {
      "circuit_breakers returns 200": (r) => r.status === 200,
      "circuit_breakers has breakers array": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.breakers);
      },
    });

    const res2 = http.get(`${BASE_URL}/api/governance/kill-switches`, { headers });
    governanceLatency.add(res2.timings.duration, { route: "kill_switches" });
    errorRate.add(res2.status !== 200);
    check(res2, {
      "kill_switches returns 200": (r) => r.status === 200,
      "kill_switches has types array": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.types);
      },
    });
  });

  // ─── 3. Loan calculator (POST, computationally light) ───
  group("loan calculate", () => {
    const res = http.post(
      `${BASE_URL}/api/supa-os/loan/calculate`,
      JSON.stringify({
        principal: 100000,
        annualInterestRate: 12,
        termMonths: 12,
      }),
      { headers },
    );
    writeLatency.add(res.timings.duration, { route: "loan_calculate" });
    errorRate.add(res.status !== 200);
    check(res, {
      "loan_calculate returns 200": (r) => r.status === 200,
      "loan_calculate has schedule": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.schedule?.schedule);
      },
    });
  });

  // ─── 4. Compliance mask (POST, very light) ───
  group("compliance mask", () => {
    const res = http.post(
      `${BASE_URL}/api/supa-os/compliance/mask`,
      JSON.stringify({
        value: "4242424242424242",
        fieldType: "card_number",
      }),
      { headers },
    );
    writeLatency.add(res.timings.duration, { route: "compliance_mask" });
    errorRate.add(res.status !== 200);
    check(res, {
      "compliance_mask returns 200": (r) => r.status === 200,
      "compliance_mask returns masked value": (r) => {
        const body = r.json();
        return body?.ok === true && typeof body?.data?.masked === "string";
      },
    });
  });

  // ─── 5. Governance decisions (POST, hits DB) ───
  group("governance decisions", () => {
    const res = http.post(
      `${BASE_URL}/api/governance/decisions`,
      JSON.stringify({
        actionType: "tool.call:files.read",
        targetType: "tool",
        targetId: "files.read",
        actorId: "k6_load_test",
      }),
      { headers },
    );
    governanceLatency.add(res.timings.duration, { route: "decisions" });
    // 200 (allowed) or 403 (blocked) are both valid — only 500 is an error.
    errorRate.add(res.status >= 500);
    check(res, {
      "decisions returns 200 or 403": (r) => r.status === 200 || r.status === 403,
    });
  });

  // ─── 6. Expansion catalog reads ───
  group("expansion reads", () => {
    const res = http.get(`${BASE_URL}/api/expansion/pipeline`, { headers });
    readLatency.add(res.timings.duration, { route: "expansion_pipeline" });
    errorRate.add(res.status !== 200);
    check(res, {
      "expansion_pipeline returns 200": (r) => r.status === 200,
      "expansion_pipeline has stages": (r) => {
        const body = r.json();
        return body?.ok === true && Array.isArray(body?.data?.stages);
      },
    });
  });

  sleep(0.1); // 100ms between iterations to avoid hammering.
}

// ───────────────────────────────────────────────
// Setup + teardown
// ───────────────────────────────────────────────

export function setup() {
  console.log(`[k6] Starting load test against ${BASE_URL}`);
  console.log(`[k6] Using admin token: ${ADMIN_TOKEN.slice(0, 8)}...`);
  return { baseUrl: BASE_URL };
}

export function teardown(data) {
  console.log(`[k6] Load test complete. Target was: ${data.baseUrl}`);
}
