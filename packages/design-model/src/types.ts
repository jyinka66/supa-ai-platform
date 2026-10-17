// ─────────────────────────────────────────────────────────────
// Design Document Model — single source of truth.
// Rules (from the spec):
//   1. Every node is immutable. Mutations = commands → new doc.
//   2. Commands are the ONLY write path. No component writes doc directly.
//   3. Every node carries id, type, name, locked, hidden, rev.
//   4. Pages are first-class (multi-page docs, presentations).
//   5. No nondeterminism: no timestamps, no random inside content.
// ─────────────────────────────────────────────────────────────

import { newId } from "./id";

export type NodeId = string;            // ULID
export type AssetId = string;

export const LAYER_TYPES = [
  'page', 'group', 'container', 'text', 'image',
  'shape', 'icon',
] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export type Color = { hex: string; opacity?: number };          // #RRGGBBAA resolved separately
export type GradientStop = { offset: number; color: Color };    // offset 0..1
export type Gradient = { kind: 'linear' | 'radial'; stops: GradientStop[]; angle?: number };

export type Fill = { type: 'solid'; color: Color } | { type: 'gradient'; gradient: Gradient };
export type Stroke = { color: Color; width: number; align?: 'inside' | 'center' | 'outside' };

export type Constraints = {
  horizontal?: 'left' | 'right' | 'center' | 'scale';
  vertical?: 'top' | 'bottom' | 'center' | 'scale';
};

export type RichRun = {
  start: number; end: number;                  // code-unit offsets into `content`
  bold?: boolean; italic?: boolean;
  color?: Color; link?: string;
  fontFamily?: string; fontSize?: number;
};

export type AutoLayout = {
  direction: 'horizontal' | 'vertical';
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  alignMain: 'start' | 'center' | 'end' | 'space-between';
  alignCross: 'start' | 'center' | 'end' | 'stretch';
  wrap?: boolean;
};

export interface Rect { x: number; y: number; width: number; height: number }

export interface LayerBase {
  id: NodeId;
  type: LayerType;
  name: string;
  locked: boolean;
  hidden: boolean;
  rect: Rect;                                  // page-space coords
  rotation: number;                            // degrees, clockwise
  opacity: number;                             // 0..1
  blend: string;                               // normal, multiply, screen…
  constraints: Constraints;
  children?: LayerNode[];                      // group/container only; ordered back→front
}

export interface TextLayer extends LayerBase {
  type: 'text';
  content: string;                             // plain text, runs reference offsets
  runs: RichRun[];
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;                          // unitless multiplier
  letterSpacing: { value: number; unit: 'px' | 'em' | '%' };
  align: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end';
  direction: 'ltr' | 'rtl' | 'auto';
  autoResize: 'none' | 'width' | 'height' | 'both';
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  assetId: AssetId;
  fit: 'cover' | 'contain' | 'fill';
  crop?: Rect;                                 // normalized 0..1 source crop
  filters?: { brightness?: number; contrast?: number; saturation?: number; blur?: number };
  altText: string;                             // a11y; empty = warn, not block
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line';
  fill?: Fill;
  stroke?: Stroke;
  cornerRadius?: number;
  polygonSides?: number;                       // shape=polygon, 3..12
}

export interface IconLayer extends LayerBase {
  type: 'icon';
  library: string;                             // 'heroicons' | 'lucide'
  iconId: string;
  color: Color;
}

export interface ContainerLayer extends LayerBase {
  type: 'container';
  layout: AutoLayout;
  fill?: Fill;
  cornerRadius?: number;
  clip: boolean;
}

export interface GroupLayer extends LayerBase {
  type: 'group';
}

export type LayerNode =
  | GroupLayer | ContainerLayer | TextLayer
  | ImageLayer | ShapeLayer | IconLayer;

export interface Page {
  id: NodeId;
  name: string;
  size: { width: number; height: number };     // px at 1x
  background: Fill | 'transparent';
  bleed?: number;                              // px, print kinds
  layers: LayerNode[];                         // top-level, back→front
}

export interface DesignDoc {
  schemaVersion: number;                       // migrations key off this
  id: string;
  kind: string;                                // 'flyer' | 'logo' | 'presentation' | …
  name: string;
  isTemplate: boolean;
  templateVersion?: string;                    // semver, templates only
  locale: string;                              // primary locale, e.g. 'ar', 'en'
  pages: Page[];
  assets: Record<AssetId, { kind: 'raster' | 'svg'; ref: string }>;
  a11y: { issues: string[] };                  // advisory checklist ids
  brandKitId?: string;
}

// ============ HELPERS ============

export function isContainerNode(node: LayerNode): node is GroupLayer | ContainerLayer {
  return node.type === "group" || node.type === "container";
}

export function getChildren(node: LayerNode): LayerNode[] {
  if (isContainerNode(node)) return node.children ?? [];
  return [];
}

export function findLayerById(page: Page, id: NodeId): LayerNode | null {
  for (const layer of page.layers) {
    if (layer.id === id) return layer;
    const found = findInChildren(layer, id);
    if (found) return found;
  }
  return null;
}

function findInChildren(node: LayerNode, id: NodeId): LayerNode | null {
  for (const child of getChildren(node)) {
    if (child.id === id) return child;
    const found = findInChildren(child, id);
    if (found) return found;
  }
  return null;
}

export function findParent(page: Page, childId: NodeId): LayerNode | null {
  for (const layer of page.layers) {
    if (findInChildren(layer, childId)) return layer;
    const parent = findParentInChildren(layer, childId);
    if (parent) return parent;
  }
  return null;
}

function findParentInChildren(node: LayerNode, childId: NodeId): LayerNode | null {
  for (const child of getChildren(node)) {
    if (child.id === childId) return node;
    const found = findParentInChildren(child, childId);
    if (found) return found;
  }
  return null;
}

export function findPage(doc: DesignDoc, pageId: NodeId): Page | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

/**
 * Generates a new node ID using monotonic ULID.
 * IDs are structure (not content) — deterministic re-creation of a doc
 * from a command replay requires seeded ids; command payloads always
 * carry explicit ids.
 */
export function generateNodeId(): NodeId {
  return `n_${newId()}`;
}

/**
 * Deep-clones a layer node (for undo/redo snapshots).
 * Uses structured cloning — safe for plain data objects (no functions, no DOM).
 */
export function cloneLayer(node: LayerNode): LayerNode {
  return structuredClone(node);
}

/**
 * Returns all layers in a page (flattened, depth-first).
 */
export function flattenLayers(page: Page): LayerNode[] {
  const result: LayerNode[] = [];
  function walk(node: LayerNode) {
    result.push(node);
    for (const child of getChildren(node)) walk(child);
  }
  for (const layer of page.layers) walk(layer);
  return result;
}

/**
 * Returns the z-index (stacking order) of a layer within its parent.
 * 0 = bottom, length-1 = top.
 */
export function getZIndex(page: Page, layerId: NodeId): number {
  const parent = findParent(page, layerId);
  const siblings = parent ? getChildren(parent) : page.layers;
  return siblings.findIndex((s) => s.id === layerId);
}
