// ─────────────────────────────────────────────────────────────
// Geometry. Convention: a node's rect is in parent space; world transform
// composes parent→child downward. Rotation is around rect center, degrees
// clockwise (SVG y-down, so clockwise = positive angle in rotate()).
// ─────────────────────────────────────────────────────────────
import type { LayerNode, Page, Rect } from "@supa/design-model";

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mul(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function trs(rect: Rect, rotationDeg: number): Matrix {
  // translate → rotate(around center) — scale is applied by children, not here.
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy };
}

export function worldTransform(page: Page, id: string): Matrix {
  // Walk root→node once per hit test / anchor draw; cached per doc rev
  // in the RenderCache below when used in hot paths.
  const path = pathTo(page, id);
  return path.reduce((m, node) => mul(m, trs(node.rect, node.rotation)), IDENTITY);
}

export function applyToPoint(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    // Singular matrix — return identity to avoid NaN propagation.
    return IDENTITY;
  }
  return {
    a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det,
  };
}

// AABB of a transformed rect — used for group bounds, selection box,
// and cheap reject in hit testing.
export function aabb(rect: Rect, rotationDeg: number): Rect {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const w = rect.width * cos + rect.height * sin;
  const h = rect.width * sin + rect.height * cos;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/**
 * Hit test: returns the topmost layer at the given world-space point.
 * Iterates layers back→front (front = last in array = drawn on top).
 */
export function hitTest(page: Page, x: number, y: number): LayerNode | null {
  // Iterate in reverse (top-most first).
  for (let i = page.layers.length - 1; i >= 0; i--) {
    const layer = page.layers[i];
    if (!layer) continue;
    const hit = hitTestNode(layer, x, y);
    if (hit) return hit;
  }
  return null;
}

function hitTestNode(node: LayerNode, x: number, y: number): LayerNode | null {
  // Check children first (top-most child is on top).
  if (node.children) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (!child) continue;
      const hit = hitTestNode(child, x, y);
      if (hit) return hit;
    }
  }

  // Transform point into this node's local space.
  const m = invert(trs(node.rect, node.rotation));
  const local = applyToPoint(m, x, y);

  // Check if inside the node's rect (local space: 0..width, 0..height).
  if (local.x >= 0 && local.x <= node.rect.width && local.y >= 0 && local.y <= node.rect.height) {
    return node;
  }

  return null;
}

function pathTo(page: Page, id: string): LayerNode[] {
  const stack: { node: LayerNode; path: LayerNode[] }[] =
    page.layers.map((n) => ({ node: n, path: [n] }));
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, path } = entry;
    if (node.id === id) return path;
    if (node.children) for (const c of node.children) stack.push({ node: c, path: [...path, c] });
  }
  throw new Error(`pathTo: id ${id} not on page ${page.id}`);
}
