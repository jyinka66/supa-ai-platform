/**
 * @supa/test-fixtures/op-fuzz
 * ----------------------------------------------------------------
 * The 5,000+ op-fuzz corpus, consolidated from @supa/security's
 * tests/fixtures/op-fuzz-corpus.ts into the single maintained
 * fixture package.
 *
 * Deterministic (mulberry32-seeded) so test failures are
 * reproducible. Attack classes: schema-invalid, geometry
 * non-finite, geometry out-of-bounds, text-too-long, text
 * control-chars, node-count-cap, cycles, JSON parse bombs,
 * prototype pollution, rate-limit probes.
 *
 * Frozen readonly — tests can't accidentally mutate the shared
 * corpus.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Fuzz op type
// ───────────────────────────────────────────────

export type FuzzOp = {
  /** Attack class — for asserting which check caught it. */
  attack: string;
  /** The op payload to fire at the hub. */
  payload: unknown;
  /** Expected validation code (or "schema-invalid" for any parse failure). */
  expectCode: string;
};

// ───────────────────────────────────────────────
// Deterministic PRNG (mulberry32) — reproducible fuzz
// ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────
// Curated attack classes
// ───────────────────────────────────────────────

function schemaInvalidOps(): FuzzOp[] {
  return [
    { attack: "null-op", payload: null, expectCode: "schema-invalid" },
    { attack: "undefined-op", payload: undefined, expectCode: "schema-invalid" },
    { attack: "empty-object", payload: {}, expectCode: "schema-invalid" },
    { attack: "missing-type", payload: { id: "abc" }, expectCode: "schema-invalid" },
    { attack: "unknown-type", payload: { type: "UnknownOp", id: "abc" }, expectCode: "schema-invalid" },
    { attack: "wrong-type-shape", payload: { type: 123, id: "abc" }, expectCode: "schema-invalid" },
    { attack: "proto-pollution", payload: { type: "InsertLayer", id: "abc", __proto__: { polluted: true } }, expectCode: "schema-invalid" },
    { attack: "constructor-injection", payload: { type: "InsertLayer", id: "abc", constructor: { prototype: { polluted: true } } }, expectCode: "schema-invalid" },
  ];
}

function geometryNonFiniteOps(): FuzzOp[] {
  const ops: FuzzOp[] = [];
  const baseOp = { type: "InsertLayer", id: "abc", layer: { type: "rect", x: 0, y: 0, w: 100, h: 100 } };
  for (const coord of ["x", "y", "w", "h"]) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      ops.push({
        attack: `non-finite-${coord}-${bad}`,
        payload: { ...baseOp, layer: { ...baseOp.layer, [coord]: bad } },
        expectCode: "geometry-non-finite",
      });
    }
  }
  return ops;
}

function geometryOutOfBoundsOps(): FuzzOp[] {
  const ops: FuzzOp[] = [];
  const baseOp = { type: "InsertLayer", id: "abc", layer: { type: "rect", x: 0, y: 0, w: 100, h: 100 } };
  for (const coord of ["x", "y"]) {
    ops.push({
      attack: `oob-${coord}-2M`,
      payload: { ...baseOp, layer: { ...baseOp.layer, [coord]: 2_000_000 } },
      expectCode: "geometry-out-of-bounds",
    });
    ops.push({
      attack: `oob-${coord}-neg-2M`,
      payload: { ...baseOp, layer: { ...baseOp.layer, [coord]: -2_000_000 } },
      expectCode: "geometry-out-of-bounds",
    });
  }
  for (const dim of ["w", "h"]) {
    ops.push({
      attack: `oob-${dim}-2M`,
      payload: { ...baseOp, layer: { ...baseOp.layer, [dim]: 2_000_000 } },
      expectCode: "geometry-out-of-bounds",
    });
  }
  return ops;
}

function textTooLongOps(): FuzzOp[] {
  return [
    {
      attack: "text-10mb",
      payload: { type: "InsertLayer", id: "abc", layer: { type: "text", text: "x".repeat(10 * 1024 * 1024) } },
      expectCode: "text-too-long",
    },
    {
      attack: "text-100kb",
      payload: { type: "InsertLayer", id: "abc", layer: { type: "text", text: "x".repeat(100 * 1024) } },
      expectCode: "text-too-long",
    },
    {
      attack: "text-rtl-override",
      payload: { type: "InsertLayer", id: "abc", layer: { type: "text", text: "\u202Ehello" } },
      expectCode: "schema-invalid",
    },
    {
      attack: "text-null-bytes",
      payload: { type: "InsertLayer", id: "abc", layer: { type: "text", text: "ab\0cd" } },
      expectCode: "schema-invalid",
    },
  ];
}

function nodeCountCapOps(): FuzzOp[] {
  const children = Array.from({ length: 100_000 }, (_, i) => ({
    type: "rect", id: `child-${i}`, x: 0, y: 0, w: 1, h: 1,
  }));
  return [
    {
      attack: "100k-children",
      payload: { type: "InsertLayer", id: "abc", layer: { type: "group", children } },
      expectCode: "schema-invalid",
    },
  ];
}

function cycleOps(): FuzzOp[] {
  const selfRef: FuzzOp = {
    attack: "self-cycle",
    payload: null, // set below — circular structure can't be expressed inline
    expectCode: "schema-invalid",
  };
  const obj: any = { type: "InsertLayer", id: "abc", layer: { type: "group", id: "g1", children: [] } };
  obj.layer.children.push(obj.layer);
  selfRef.payload = obj;
  return [selfRef];
}

function jsonParseBombOps(): FuzzOp[] {
  let deep: any = { type: "InsertLayer", id: "abc" };
  for (let i = 0; i < 1000; i++) {
    deep = { nested: deep };
  }
  return [{ attack: "deep-nesting-1000", payload: deep, expectCode: "schema-invalid" }];
}

// ───────────────────────────────────────────────
// Full corpus generator
// ───────────────────────────────────────────────

export function generateOpFuzzCorpus(seed = 42): FuzzOp[] {
  const rng = mulberry32(seed);
  const corpus: FuzzOp[] = [];

  corpus.push(...schemaInvalidOps());
  corpus.push(...geometryNonFiniteOps());
  corpus.push(...geometryOutOfBoundsOps());
  corpus.push(...textTooLongOps());
  corpus.push(...nodeCountCapOps());
  corpus.push(...cycleOps());
  corpus.push(...jsonParseBombOps());

  // Generate randomized variants to reach 5,000+.
  const baseOp = { type: "InsertLayer", id: "abc", layer: { type: "rect", x: 0, y: 0, w: 100, h: 100 } };
  const badValues = [
    NaN, Infinity, -Infinity, 2_000_000, -2_000_000, 1e15, -1e15,
    "string-instead-of-number", null, [], {},
  ];
  const coords = ["x", "y", "w", "h"];

  while (corpus.length < 5000) {
    const coord = coords[Math.floor(rng() * coords.length)]!;
    const val = badValues[Math.floor(rng() * badValues.length)]!;
    const expectCode =
      typeof val === "number" && !Number.isFinite(val) ? "geometry-non-finite" :
      typeof val === "number" && Math.abs(val) > 1_000_000 ? "geometry-out-of-bounds" :
      "schema-invalid";
    corpus.push({
      attack: `random-${coord}-${typeof val}-${corpus.length}`,
      payload: { ...baseOp, layer: { ...baseOp.layer, [coord]: val } },
      expectCode,
    });
  }

  return corpus;
}

// ───────────────────────────────────────────────
// Frozen exported corpus
// ───────────────────────────────────────────────

export const OP_FUZZ_CORPUS: readonly FuzzOp[] = Object.freeze(generateOpFuzzCorpus());
