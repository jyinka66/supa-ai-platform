/**
 * @supa/test-fixtures — the single maintained fixture package.
 *
 * Gathers every fuzz corpus and golden set from across the monorepo
 * into one package so they're reusable across CI jobs + packages.
 * This is the consolidation pass: no more scattered fixture files
 * in each package's tests/ dir — one source of truth, imported by
 * every test suite that needs them.
 *
 *   op-fuzz        — 5,000+ malformed/hostile ops (from @supa/security)
 *   injection      — prompt-injection + SVG XSS + billion-laughs corpus
 *   ssrf           — metadata IPs, rebinding, redirects, IPv4-mapped IPv6
 *   xss            — codegen XSS payloads across text/attr/url/js contexts
 *   golden         — golden render test harness (determinism + parity + RTL)
 *   dtcg           — W3C DTCG round-trip fixtures (from @supa/design-tokens)
 *   crash-replay   — crash-replay skeleton bridge (feeds canary gate's
 *                    buildReplaySchedule from crash taxonomy's op trail)
 *
 * Usage:
 *   import { OP_FUZZ_CORPUS } from "@supa/test-fixtures/op-fuzz";
 *   import { INJECTION_CORPUS } from "@supa/test-fixtures/injection";
 *
 * Every fixture is a frozen readonly array — tests can't accidentally
 * mutate the shared corpus.
 */

export { OP_FUZZ_CORPUS, generateOpFuzzCorpus } from "./op-fuzz.js";
export { INJECTION_CORPUS, AI_OUTPUT_CORPUS } from "./injection.js";
export { SSRF_PROBES, IP_LITERAL_PROBES } from "./ssrf.js";
export { XSS_CORPUS } from "./xss.js";
export { GOLDEN_TEST_CONFIG, GOLDEN_PARITY_RULES } from "./golden.js";
export { DTCG_ROUND_TRIP_FIXTURES } from "./dtcg.js";
export { CRASH_REPLAY_SKELETONS, buildCrashReplaySchedule } from "./crash-replay.js";
