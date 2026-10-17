/**
 * Consolidation tests — verify the @supa/test-fixtures package is the
 * single source of truth for all fuzz corpora + golden sets.
 *
 * Covers:
 *   - op-fuzz corpus has 5,000+ entries + is deterministic
 *   - injection corpus has all categories
 *   - SSRF probes cover all blocked ranges + allowed sanity
 *   - XSS corpus covers all contexts
 *   - golden test config has correct defaults
 *   - DTCG fixtures round-trip stable
 *   - crash-replay skeletons produce correct fingerprints
 *   - all corpora are frozen (immutable)
 */

import { describe, it, expect } from "vitest";
import { OP_FUZZ_CORPUS, generateOpFuzzCorpus } from "../src/op-fuzz.js";
import { INJECTION_CORPUS, AI_OUTPUT_CORPUS } from "../src/injection.js";
import { SSRF_PROBES, IP_LITERAL_PROBES } from "../src/ssrf.js";
import { XSS_CORPUS } from "../src/xss.js";
import { GOLDEN_TEST_CONFIG, GOLDEN_PARITY_RULES, RTL_CANARY_CORPUS, compareGolden } from "../src/golden.js";
import { DTCG_ROUND_TRIP_FIXTURES, assertRoundTripStable } from "../src/dtcg.js";
import { CRASH_REPLAY_SKELETONS, buildCrashReplaySchedule, runCrashReplay, type OpTrailEntry } from "../src/crash-replay.js";

// ─── op-fuzz ───

describe("OP_FUZZ_CORPUS", () => {
  it("has 5,000+ entries", () => {
    expect(OP_FUZZ_CORPUS.length).toBeGreaterThanOrEqual(5000);
  });

  it("is deterministic (same seed → same corpus)", () => {
    const a = generateOpFuzzCorpus(42);
    const b = generateOpFuzzCorpus(42);
    expect(a.length).toBe(b.length);
    expect(a[1000]!.attack).toBe(b[1000]!.attack);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(OP_FUZZ_CORPUS)).toBe(true);
  });

  it("every entry has attack + payload + expectCode", () => {
    for (const op of OP_FUZZ_CORPUS) {
      expect(op.attack).toBeTruthy();
      expect(op).toHaveProperty("payload"); // property exists (value may be null/undefined)
      expect(op.expectCode).toBeTruthy();
    }
  });
});

// ─── injection ───

describe("INJECTION_CORPUS", () => {
  it("has all categories", () => {
    const categories = new Set(INJECTION_CORPUS.map((p) => p.category));
    expect(categories.has("prompt-injection")).toBe(true);
    expect(categories.has("svg-xss")).toBe(true);
    expect(categories.has("billion-laughs")).toBe(true);
    expect(categories.has("delimiter-injection")).toBe(true);
    expect(categories.has("prototype-pollution")).toBe(true);
    expect(categories.has("asset-url-injection")).toBe(true);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(INJECTION_CORPUS)).toBe(true);
  });
});

describe("AI_OUTPUT_CORPUS", () => {
  it("has both parsed + non-parsed cases", () => {
    const parsed = AI_OUTPUT_CORPUS.filter((o) => o.expectParsed);
    const notParsed = AI_OUTPUT_CORPUS.filter((o) => !o.expectParsed);
    expect(parsed.length).toBeGreaterThan(0);
    expect(notParsed.length).toBeGreaterThan(0);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(AI_OUTPUT_CORPUS)).toBe(true);
  });
});

// ─── ssrf ───

describe("SSRF_PROBES", () => {
  it("covers cloud metadata endpoints", () => {
    const names = SSRF_PROBES.map((p) => p.name);
    expect(names).toContain("aws-metadata-ipv4");
    expect(names).toContain("gcp-metadata-ipv4");
    expect(names).toContain("azure-metadata");
  });

  it("covers IPv4-mapped IPv6 bypass", () => {
    const names = SSRF_PROBES.map((p) => p.name);
    expect(names).toContain("ipv4-mapped-metadata");
    expect(names).toContain("ipv4-mapped-loopback");
    expect(names).toContain("ipv4-mapped-private-10");
  });

  it("has at least 2 allowed (non-blocked) probes for sanity", () => {
    const allowed = SSRF_PROBES.filter((p) => !p.expectBlocked);
    expect(allowed.length).toBeGreaterThanOrEqual(2);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SSRF_PROBES)).toBe(true);
  });
});

describe("IP_LITERAL_PROBES", () => {
  it("covers all blocked ranges", () => {
    const blocked = IP_LITERAL_PROBES.filter((p) => p.expectBlocked);
    expect(blocked.length).toBeGreaterThan(10);
  });

  it("has allowed IPs for sanity", () => {
    const allowed = IP_LITERAL_PROBES.filter((p) => !p.expectBlocked);
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(IP_LITERAL_PROBES)).toBe(true);
  });
});

// ─── xss ───

describe("XSS_CORPUS", () => {
  it("covers all contexts", () => {
    const contexts = new Set(XSS_CORPUS.map((p) => p.context));
    expect(contexts.has("text")).toBe(true);
    expect(contexts.has("attr")).toBe(true);
    expect(contexts.has("url")).toBe(true);
    expect(contexts.has("js-string")).toBe(true);
    expect(contexts.has("asset-url")).toBe(true);
  });

  it("every payload has forbidden substrings", () => {
    for (const p of XSS_CORPUS) {
      expect(p.forbiddenSubstrings.length).toBeGreaterThan(0);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(XSS_CORPUS)).toBe(true);
  });
});

// ─── golden ───

describe("GOLDEN_TEST_CONFIG", () => {
  it("has pixel-perfect tolerance by default", () => {
    expect(GOLDEN_TEST_CONFIG.pixelDiffTolerance).toBe(0);
  });

  it("tests both node + browser environments", () => {
    expect(GOLDEN_TEST_CONFIG.environments).toContain("node");
    expect(GOLDEN_TEST_CONFIG.environments).toContain("browser");
  });
});

describe("GOLDEN_PARITY_RULES", () => {
  it("has determinism + parity + rtl rules", () => {
    const categories = new Set(GOLDEN_PARITY_RULES.map((r) => r.category));
    expect(categories.has("determinism")).toBe(true);
    expect(categories.has("parity")).toBe(true);
    expect(categories.has("rtl")).toBe(true);
  });
});

describe("RTL_CANARY_CORPUS", () => {
  it("has Arabic + Hebrew snippets", () => {
    const names = RTL_CANARY_CORPUS.map((s) => s.name);
    expect(names).toContain("arabic-simple");
    expect(names).toContain("hebrew-simple");
  });

  it("has mixed-direction snippets", () => {
    const names = RTL_CANARY_CORPUS.map((s) => s.name);
    expect(names).toContain("mixed-ltr-in-rtl");
    expect(names).toContain("mixed-rtl-in-ltr");
  });
});

describe("compareGolden", () => {
  it("passes when SVG + dimensions match", () => {
    const result = compareGolden(
      { svg: "<svg/>", width: 100, height: 200 },
      { svg: "<svg/>", width: 100, height: 200 },
    );
    expect(result.passed).toBe(true);
  });

  it("fails when SVG differs", () => {
    const result = compareGolden(
      { svg: "<svg/>", width: 100, height: 200 },
      { svg: "<svg/>changed", width: 100, height: 200 },
    );
    expect(result.passed).toBe(false);
  });

  it("fails when dimensions differ beyond tolerance", () => {
    const result = compareGolden(
      { svg: "<svg/>", width: 101, height: 200 },
      { svg: "<svg/>", width: 100, height: 200 },
    );
    expect(result.passed).toBe(false);
  });
});

// ─── dtcg ───

describe("DTCG_ROUND_TRIP_FIXTURES", () => {
  it("has 5+ fixtures", () => {
    expect(DTCG_ROUND_TRIP_FIXTURES.length).toBeGreaterThanOrEqual(5);
  });

  it("every fixture has expected token ids + types", () => {
    for (const f of DTCG_ROUND_TRIP_FIXTURES) {
      expect(f.expectedTokenIds.length).toBeGreaterThan(0);
      expect(Object.keys(f.expectedTypes).length).toBeGreaterThan(0);
    }
  });
});

describe("assertRoundTripStable", () => {
  it("returns stable=true when ids match exactly", () => {
    const result = assertRoundTripStable(["a", "b"], ["a", "b"]);
    expect(result.stable).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("returns missing when original has more", () => {
    const result = assertRoundTripStable(["a", "b", "c"], ["a", "b"]);
    expect(result.stable).toBe(false);
    expect(result.missing).toEqual(["c"]);
  });

  it("returns extra when imported has more", () => {
    const result = assertRoundTripStable(["a"], ["a", "b"]);
    expect(result.stable).toBe(false);
    expect(result.extra).toEqual(["b"]);
  });
});

// ─── crash-replay ───

describe("CRASH_REPLAY_SKELETONS", () => {
  it("has 5+ curated skeletons", () => {
    expect(CRASH_REPLAY_SKELETONS.length).toBeGreaterThanOrEqual(5);
  });

  it("every skeleton has opTypes + sources + fingerprint", () => {
    for (const s of CRASH_REPLAY_SKELETONS) {
      expect(s.opTypes.length).toBeGreaterThan(0);
      expect(s.sources.length).toBe(s.opTypes.length);
      expect(s.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("covers all crash classes", () => {
    const classes = new Set(CRASH_REPLAY_SKELETONS.map((s) => s.crashClass));
    expect(classes.has("E_EDITOR")).toBe(true);
    expect(classes.has("E_RENDERER")).toBe(true);
    expect(classes.has("E_AI")).toBe(true);
    expect(classes.has("E_SYNC")).toBe(true);
  });
});

describe("buildCrashReplaySchedule", () => {
  it("builds a schedule from an op trail", () => {
    const trail: OpTrailEntry[] = [
      { type: "InsertLayer", source: "local", latencyMs: 5 },
      { type: "SetStyle", source: "local", latencyMs: 3 },
      { type: "DeleteLayer", source: "local", latencyMs: 2 },
    ];
    const schedule = buildCrashReplaySchedule(trail);
    expect(schedule.opTypes).toEqual(["InsertLayer", "SetStyle", "DeleteLayer"]);
    expect(schedule.sources).toEqual(["local", "local", "local"]);
    expect(schedule.totalLatencyMs).toBe(10);
    expect(schedule.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces the same fingerprint for the same op-type chain", () => {
    const trail1: OpTrailEntry[] = [
      { type: "InsertLayer", source: "local", latencyMs: 5 },
      { type: "DeleteLayer", source: "remote", latencyMs: 10 },
    ];
    const trail2: OpTrailEntry[] = [
      { type: "InsertLayer", source: "ai", latencyMs: 100 },
      { type: "DeleteLayer", source: "local", latencyMs: 200 },
    ];
    const s1 = buildCrashReplaySchedule(trail1);
    const s2 = buildCrashReplaySchedule(trail2);
    expect(s1.fingerprint).toBe(s2.fingerprint); // same op-type chain → same fingerprint
  });

  it("produces different fingerprints for different op-type chains", () => {
    const trail1: OpTrailEntry[] = [{ type: "InsertLayer", source: "local", latencyMs: 5 }];
    const trail2: OpTrailEntry[] = [{ type: "DeleteLayer", source: "local", latencyMs: 5 }];
    const s1 = buildCrashReplaySchedule(trail1);
    const s2 = buildCrashReplaySchedule(trail2);
    expect(s1.fingerprint).not.toBe(s2.fingerprint);
  });
});

describe("runCrashReplay", () => {
  it("returns fixed=true when replay doesn't throw", () => {
    const skeleton = CRASH_REPLAY_SKELETONS[0]!;
    const result = runCrashReplay(skeleton, () => {
      // no-op — doesn't throw
    });
    expect(result.reproduced).toBe(false);
    expect(result.fixed).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns reproduced=true when replay throws", () => {
    const skeleton = CRASH_REPLAY_SKELETONS[0]!;
    const result = runCrashReplay(skeleton, () => {
      throw new Error("invariant violation");
    });
    expect(result.reproduced).toBe(true);
    expect(result.fixed).toBe(false);
    expect(result.error).toContain("invariant violation");
  });
});
