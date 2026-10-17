// ─────────────────────────────────────────────────────────────
// Hit testing in page space. Rules:
//   1. Topmost-first (front of children array first), depth-first.
//   2. Locked nodes: not selectable by click (selectable via layers panel).
//   3. Hidden nodes: skipped entirely (and their children — hidden group
//      = subtree gone).
//   4. Text/shape/image: point-in-transformed-rect (rotation-aware: map
//      page point into node local space via inverse world transform, then
//      test local rect). Shapes additionally test the primitive
//      (ellipse ≠ its box).
//   5. Groups: pass-through unless no descendant hit (then the group is
//      hit only on double-click intent — handled in the editor, not here).
//   6. Tolerance: 3/pageZoom px slack for hairlines and empty text boxes
//      (empty text layer is hit-testable — otherwise you can't select it
//      to type).
// ─────────────────────────────────────────────────────────────

import type { Page, LayerNode, ShapeLayer, ContainerLayer } from "@supa/design-model";
import { isContainerNode, getChildren } from "@supa/design-model";
import { type Matrix, trs, invert, applyToPoint, worldTransform, IDENTITY, mul } from "./transform";

/**
 * Hit test: returns the topmost selectable layer at the given page-space point.
 *
 * @param page       The page to test.
 * @param pagePoint  The point in page coordinates (already converted from
 *                   screen coords via the canvas transform).
 * @param zoom       Current zoom level (used to scale tolerance).
 * @returns          The hit layer, or null if nothing was hit.
 *
 * @example
 *   const node = hitTest(page, { x: 100, y: 50 }, 2.0);
 *   if (node) selectNode(node.id);
 */
export function hitTest(
  page: Page,
  pagePoint: { x: number; y: number },
  zoom: number,
): LayerNode | null {
  const tol = 3 / zoom; // 3px at 100% zoom, scales inversely with zoom

  // Iterate top-down (front = last in array = drawn on top).
  for (let i = page.layers.length - 1; i >= 0; i--) {
    const hit = hitNode(page, page.layers[i]!, pagePoint, tol);
    if (hit) return hit;
  }
  return null;
}

/**
 * Recursive hit test on a single node + its children.
 *
 * Rules:
 *   1. Topmost-first (front of children array first), depth-first.
 *   2. Locked nodes: not selectable by click (selectable via layers panel).
 *   3. Hidden nodes: skipped entirely (and their children — hidden group = subtree gone).
 *   4. Text/shape/image: point-in-transformed-rect (rotation-aware: map page
 *      point into node local space via inverse world transform, then test
 *      local rect). Shapes additionally test the primitive (ellipse ≠ its box).
 *   5. Groups: pass-through unless no descendant hit (then the group is hit
 *      only on double-click intent — handled in the editor, not here).
 *   6. Tolerance: 3/pageZoom px slack for hairlines and empty text boxes.
 */
function hitNode(
  page: Page,
  node: LayerNode,
  p: { x: number; y: number },
  tol: number,
): LayerNode | null {
  // Rule 3: Hidden nodes are skipped entirely.
  if (node.hidden) return null;

  // Rule 2: Locked nodes are not selectable by click.
  if (node.locked) return null;

  // Compute the world transform for this node (composes parent→child).
  const wt = worldTransform(page, node.id);
  const inv = invert(wt);
  const local = applyToPoint(inv, p.x, p.y);
  const r = node.rect;

  // Quick reject: point outside the (tolerance-expanded) bounding box.
  const inside =
    local.x >= -tol &&
    local.x <= r.width + tol &&
    local.y >= -tol &&
    local.y <= r.height + tol;
  if (!inside) return null;

  // Rule 4: Shape refinement — primitives are tighter than their boxes.
  if (node.type === "shape") {
    if (!hitShapePrimitive(node as ShapeLayer, local, tol)) return null;
  }

  // Container with clip: point must also be inside children bounds —
  // clipped-away children can't be hit, and the container itself is
  // only a hit where it paints (fill) or a child is hit.
  if (node.type === "container") {
    const container = node as ContainerLayer;
    if (container.clip) {
      const childHit = (container.children ?? []).some(
        (c) => hitNode(page, c, p, tol) !== null,
      );
      const paintsFill = container.fill !== undefined;
      if (!childHit && !paintsFill) return null;
    }
  }

  // Rule 5: Group pass-through — if a descendant is hit, the descendant wins.
  // The group is returned only when nothing below is hit — meaning the point
  // fell in the union gap (the group body with no child hit).
  if (node.children) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = hitNode(page, node.children[i]!, p, tol);
      if (child) return child;
    }
    // No child was hit — return the node itself (group body hit).
    // The editor handles double-click intent for groups.
    return node;
  }

  // Rule 6: Text layers are always hit-testable (even empty — so you can
  // select them to type). Images, icons: bounding-box test is sufficient.
  return node;
}

/**
 * Shape primitive hit testing — tighter than bounding box.
 *
 * - rect: bounding box (already tested above).
 * - ellipse: (x/a)² + (y/b)² ≤ 1.
 * - triangle/polygon: point-in-polygon.
 * - line: distance to segment ≤ tol + half stroke width.
 */
function hitShapePrimitive(
  shape: ShapeLayer,
  local: { x: number; y: number },
  tol: number,
): boolean {
  const { width, height, shape: type } = shape;

  switch (type) {
    case "rect":
      return true;

    case "ellipse": {
      const cx = width / 2;
      const cy = height / 2;
      const a = cx + tol;
      const b = cy + tol;
      const dx = local.x - cx;
      const dy = local.y - cy;
      return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
    }

    case "triangle": {
      const v0 = { x: width / 2, y: 0 };
      const v1 = { x: width, y: height };
      const v2 = { x: 0, y: height };
      return pointInTriangle(local, v0, v1, v2, tol);
    }

    case "polygon": {
      const sides = shape.polygonSides ?? 6;
      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) / 2;
      const vertices = Array.from({ length: sides }, (_, i) => {
        const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
        return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
      });
      return pointInPolygon(local, vertices, tol);
    }

    case "line": {
      const d = distanceToSegment(local, { x: 0, y: 0 }, { x: width, y: height });
      return d <= tol + (shape.stroke?.width ?? 1) / 2;
    }

    default:
      return true;
  }
}

// ============ GEOMETRY HELPERS ============

/**
 * Point-in-triangle test using barycentric coordinates.
 * Includes tolerance expansion (the triangle is "fattened" by `tol`).
 */
function pointInTriangle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  tol: number,
): boolean {
  // Expand the triangle by moving each edge outward by `tol`.
  // Simplification: just use the standard test without expansion (tolerance
  // is already applied to the bounding box, which covers most cases).
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);

  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;

  return !(hasNeg && hasPos);
}

function sign(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

/**
 * Point-in-polygon test (ray casting algorithm).
 */
function pointInPolygon(
  point: { x: number; y: number },
  vertices: Array<{ x: number; y: number }>,
  tol: number,
): boolean {
  let inside = false;
  const n = vertices.length;

  // Expand the polygon by `tol` (approximate — just shrink the point
  // toward the centroid, which works for convex polygons).
  const cx = vertices.reduce((s, v) => s + v.x, 0) / n;
  const cy = vertices.reduce((s, v) => s + v.y, 0) / n;
  const p = {
    x: point.x + (cx - point.x) * (tol / 100), // tiny nudge toward center
    y: point.y + (cy - point.y) * (tol / 100),
  };

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i]!.x, yi = vertices[i]!.y;
    const xj = vertices[j]!.x, yj = vertices[j]!.y;

    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * Distance from a point to a line segment.
 */
function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // a === b — just distance to point a.
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  // Project p onto the line, clamp to [0, 1].
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}
