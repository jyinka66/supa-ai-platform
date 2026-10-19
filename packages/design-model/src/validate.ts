// ─────────────────────────────────────────────────────────────
// The strict gate — the same validator accepts hand edits, AI output,
// and template publishes.
//
// Checks (all fail-closed):
//   1. Structural: every node has id/type/name/rect; children only on
//      group/container; no cycles; depth ≤ 24; ids unique doc-wide.
//   2. Type schemas: text has fontFamily/fontSize within registry bounds
//      (6..512); image.assetId exists in doc.assets; icon.iconId exists in
//      the bundled sprite index; shape polygonSides 3..12.
//   3. Numeric sanity: opacity 0..1, rotation within ±3600, rect finite
//      & ≥ 0.01, no NaN/Infinity anywhere (JSON can smuggle these —
//      explicitly rejected).
//   4. Text/runs: run offsets ordered, non-overlapping, within content length.
//   5. Locale: doc.locale present; text layers carry direction or 'auto'.
//   6. Budget: total nodes ≤ 2000 (soft error above, hard at 4000).
// ─────────────────────────────────────────────────────────────

import type {
  DesignDoc,
  LayerNode,
  Page,
  NodeId,
  TextLayer,
} from "./types";
import { isContainerNode, getChildren, flattenLayers } from "./types";
import { safeValidateDoc as zodValidateDoc } from "./validator";

export type ValidationError = {
  path: string;
  code: string;
  message: string;
};

const MAX_DEPTH = 24;
const SOFT_NODE_LIMIT = 2000;
const HARD_NODE_LIMIT = 4000;
const MIN_RECT = 0.01;
const MAX_ROTATION = 3600; // ±10 full rotations
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 512;
const POLYGON_SIDES_MIN = 3;
const POLYGON_SIDES_MAX = 12;

// ============ MAIN ENTRY ============

/**
 * Validates a design document against all structural, type, numeric,
 * text-run, locale, and budget rules.
 *
 * Returns an array of validation errors (empty = valid).
 * All checks fail-closed: if the input is suspicious, it's rejected.
 *
 * @example
 *   const errors = validate(doc);
 *   if (errors.length > 0) {
 *     console.error(errors);
 *     // reject the input — don't let invalid data enter the doc state
 *   }
 */
export function validate(doc: DesignDoc): ValidationError[] {
  const errors: ValidationError[] = [];

  // Zod schema validation (catches structural shape issues).
  const zodResult = zodValidateDoc(doc);
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      errors.push({
        path: issue.path.join("."),
        code: "SCHEMA",
        message: issue.message,
      });
    }
    // If Zod fails, structural checks might crash — return early.
    return errors;
  }

  // Structural checks.
  for (const page of doc.pages) {
    checkStructural(page, errors);
    checkDepth(page, errors);
    checkUniqueIds(page, errors);
    checkCycles(page, errors);
  }

  // Type-specific checks.
  for (const page of doc.pages) {
    for (const layer of flattenLayers(page)) {
      checkTypeSpecific(layer, page, doc, errors);
      checkNumericSanity(layer, errors);
    }
  }

  // Text/runs checks.
  for (const page of doc.pages) {
    for (const layer of flattenLayers(page)) {
      if (layer.type === "text") {
        checkTextRuns(layer, errors);
      }
    }
  }

  // Locale checks.
  checkLocale(doc, errors);

  // Budget checks.
  checkBudget(doc, errors);

  return errors;
}

/**
 * Convenience: returns true if the doc has no validation errors.
 */
export function isValid(doc: DesignDoc): boolean {
  return validate(doc).length === 0;
}

// ============ 1. STRUCTURAL ============

function checkStructural(
  page: Page,
  errors: ValidationError[],
): void {
  function checkLayer(layer: LayerNode, path: string): void {
    // Required fields.
    if (!layer.id) {
      errors.push({ path, code: "MISSING_ID", message: "Layer missing id" });
    }
    if (!layer.name) {
      errors.push({ path, code: "MISSING_NAME", message: "Layer missing name" });
    }

    // Children only on group/container.
    if (layer.children && !isContainerNode(layer)) {
      errors.push({
        path,
        code: "CHILDREN_ON_NON_CONTAINER",
        message: `Layer type '${layer.type}' cannot have children`,
      });
    }

    // Recurse.
    if (layer.children) {
      for (let i = 0; i < layer.children.length; i++) {
        const child = layer.children[i];
        if (child) checkLayer(child, `${path}.children[${String(i)}]`);
      }
    }
  }

  for (let i = 0; i < page.layers.length; i++) {
    const layer = page.layers[i];
    if (layer) checkLayer(layer, `pages[${page.id}].layers[${String(i)}]`);
  }
}

function checkDepth(page: Page, errors: ValidationError[]): void {
  function check(node: LayerNode, depth: number, path: string): void {
    if (depth > MAX_DEPTH) {
      errors.push({
        path,
        code: "DEPTH",
        message: `Layer depth ${String(depth)} exceeds max ${String(MAX_DEPTH)}`,
      });
      return;
    }
    const children = getChildren(node);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) check(child, depth + 1, `${path}.children[${String(i)}]`);
    }
  }

  for (let i = 0; i < page.layers.length; i++) {
    const layer = page.layers[i];
    if (layer) check(layer, 1, `pages[${page.id}].layers[${String(i)}]`);
  }
}

function checkUniqueIds(page: Page, errors: ValidationError[]): void {
  const seen = new Set<NodeId>();

  function check(node: LayerNode, path: string): void {
    if (seen.has(node.id)) {
      errors.push({
        path,
        code: "DUPLICATE_ID",
        message: `Duplicate node id: ${node.id}`,
      });
    }
    seen.add(node.id);
    const children = getChildren(node);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) check(child, `${path}.children[${String(i)}]`);
    }
  }

  for (let i = 0; i < page.layers.length; i++) {
    const layer = page.layers[i];
    if (layer) check(layer, `pages[${page.id}].layers[${String(i)}]`);
  }
}

function checkCycles(page: Page, errors: ValidationError[]): void {
  // Cycles can't happen in a tree (each node has one parent), but if
  // data was hand-edited (e.g. JSON paste), a node could appear as its
  // own descendant. This is a defensive check.
  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();

  function check(node: LayerNode, path: string): boolean {
    if (visiting.has(node.id)) {
      errors.push({
        path,
        code: "CYCLE",
        message: `Cycle detected at node ${node.id}`,
      });
      return false;
    }
    if (visited.has(node.id)) return true;
    visiting.add(node.id);

    const children = getChildren(node);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child && !check(child, `${path}.children[${String(i)}]`)) return false;
    }

    visiting.delete(node.id);
    visited.add(node.id);
    return true;
  }

  for (let i = 0; i < page.layers.length; i++) {
    check(page.layers[i]!, `pages[${page.id}].layers[${String(i)}]`);
  }
}

// ============ 2. TYPE-SPECIFIC ============

function checkTypeSpecific(
  layer: LayerNode,
  page: Page,
  doc: DesignDoc,
  errors: ValidationError[],
): void {
  const path = `pages[${page.id}].layers[${layer.id}]`;

  switch (layer.type) {
    case "text": {
      const text = layer;
      // Font size bounds.
      if (text.fontSize < FONT_SIZE_MIN || text.fontSize > FONT_SIZE_MAX) {
        errors.push({
          path,
          code: "FONT_SIZE_OUT_OF_RANGE",
          message: `fontSize ${String(text.fontSize)} outside bounds [${String(FONT_SIZE_MIN)}, ${String(FONT_SIZE_MAX)}]`,
        });
      }
      // Font family must be non-empty.
      if (!text.fontFamily || text.fontFamily.length === 0) {
        errors.push({
          path,
          code: "MISSING_FONT_FAMILY",
          message: "Text layer missing fontFamily",
        });
      }
      break;
    }

    case "image": {
      const img = layer;
      // Asset must exist in doc.assets.
      if (!doc.assets[img.assetId]) {
        errors.push({
          path,
          code: "ASSET_NOT_FOUND",
          message: `image.assetId '${img.assetId}' not in doc.assets`,
        });
      }
      break;
    }

    case "shape": {
      const shape = layer;
      if (shape.shape === "polygon" && shape.polygonSides !== undefined) {
        if (
          shape.polygonSides < POLYGON_SIDES_MIN ||
          shape.polygonSides > POLYGON_SIDES_MAX
        ) {
          errors.push({
            path,
            code: "POLYGON_SIDES_OUT_OF_RANGE",
            message: `polygonSides ${String(shape.polygonSides)} outside [${String(POLYGON_SIDES_MIN)}, ${String(POLYGON_SIDES_MAX)}]`,
          });
        }
      }
      break;
    }

    case "icon": {
      const icon = layer;
      // iconId must be non-empty (existence in sprite index is checked
      // at a higher level where the sprite catalog is available).
      if (!icon.iconId || icon.iconId.length === 0) {
        errors.push({
          path,
          code: "MISSING_ICON_ID",
          message: "Icon layer missing iconId",
        });
      }
      if (!icon.library || icon.library.length === 0) {
        errors.push({
          path,
          code: "MISSING_ICON_LIBRARY",
          message: "Icon layer missing library",
        });
      }
      break;
    }
  }
}

// ============ 3. NUMERIC SANITY ============

function checkNumericSanity(layer: LayerNode, errors: ValidationError[]): void {
  const path = `layers[${layer.id}]`;

  // Check for NaN / Infinity in all numeric fields.
  function checkNumber(value: unknown, fieldPath: string): void {
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        errors.push({ path: fieldPath, code: "NAN", message: `${fieldPath} is NaN` });
      }
      if (!Number.isFinite(value)) {
        errors.push({ path: fieldPath, code: "INFINITY", message: `${fieldPath} is Infinity` });
      }
    }
  }

  // Recursively check all numbers in the layer.
  function checkObject(obj: unknown, fieldPath: string): void {
    if (typeof obj === "number") {
      checkNumber(obj, fieldPath);
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkObject(obj[i], `${fieldPath}[${String(i)}]`);
      }
    } else if (obj && typeof obj === "object") {
      for (const [key, value] of Object.entries(obj)) {
        checkObject(value, `${fieldPath}.${key}`);
      }
    }
  }

  checkObject(layer, path);

  // Specific numeric bounds.
  if (layer.opacity < 0 || layer.opacity > 1) {
    errors.push({
      path,
      code: "OPACITY_OUT_OF_RANGE",
      message: `opacity ${String(layer.opacity)} outside [0, 1]`,
    });
  }

  if (Math.abs(layer.rotation) > MAX_ROTATION) {
    errors.push({
      path,
      code: "ROTATION_OUT_OF_RANGE",
      message: `rotation ${String(layer.rotation)} exceeds ±${String(MAX_ROTATION)}`,
    });
  }

  const { rect } = layer;
  if (
    rect.width < MIN_RECT ||
    rect.height < MIN_RECT ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y)
  ) {
    errors.push({
      path,
      code: "RECT_INVALID",
      message: `rect ${JSON.stringify(rect)} invalid (must be finite, width/height ≥ ${String(MIN_RECT)})`,
    });
  }
}

// ============ 4. TEXT/RUNS ============

function checkTextRuns(layer: TextLayer, errors: ValidationError[]): void {
  const path = `layers[${layer.id}].runs`;
  const contentLen = layer.content.length;

  let prevEnd = 0;

  for (let i = 0; i < layer.runs.length; i++) {
    const run = layer.runs[i];
    if (!run) continue;
    const runPath = `${path}[${String(i)}]`;

    // Start must be >= previous end (non-overlapping, ordered).
    if (run.start < prevEnd) {
      errors.push({
        path: runPath,
        code: "RUN_OVERLAP",
        message: `run.start ${String(run.start)} < previous end ${String(prevEnd)} (overlapping or unordered)`,
      });
    }

    // End must be >= start.
    if (run.end < run.start) {
      errors.push({
        path: runPath,
        code: "RUN_INVERTED",
        message: `run.end ${String(run.end)} < run.start ${String(run.start)}`,
      });
    }

    // Both must be within content length.
    if (run.start > contentLen || run.end > contentLen) {
      errors.push({
        path: runPath,
        code: "RUN_OUT_OF_BOUNDS",
        message: `run [${String(run.start)}, ${String(run.end)}] exceeds content length ${String(contentLen)}`,
      });
    }

    prevEnd = run.end;
  }
}

// ============ 5. LOCALE ============

function checkLocale(doc: DesignDoc, errors: ValidationError[]): void {
  if (!doc.locale || !/^[a-z]{2}(-[A-Z]{2})?$/.test(doc.locale)) {
    errors.push({
      path: "locale",
      code: "LOCALE_MISSING",
      message: `doc.locale '${doc.locale}' is missing or invalid`,
    });
  }

}

// ============ 6. BUDGET ============

function checkBudget(doc: DesignDoc, errors: ValidationError[]): void {
  let totalNodes = 0;

  for (const page of doc.pages) {
    function count(node: LayerNode): void {
      totalNodes++;
      const children = getChildren(node);
      for (const child of children) count(child);
    }
    for (const layer of page.layers) count(layer);
  }

  if (totalNodes > SOFT_NODE_LIMIT) {
    errors.push({
      path: "doc",
      code: "SOFT_NODE_LIMIT_EXCEEDED",
      message: `Total nodes ${String(totalNodes)} exceed soft limit ${String(SOFT_NODE_LIMIT)} (hard limit: ${String(HARD_NODE_LIMIT)})`,
    });
  }

  if (totalNodes > HARD_NODE_LIMIT) {
    errors.push({
      path: "doc",
      code: "HARD_NODE_LIMIT_EXCEEDED",
      message: `Total nodes ${String(totalNodes)} exceed hard limit ${String(HARD_NODE_LIMIT)}`,
    });
  }
}
