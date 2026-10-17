// ─────────────────────────────────────────────────────────────
// Template = doc + slots + theme. Slots reference nodes by id and declare
// what may change. Everything NOT in a slot is locked at instantiation —
// that's the product contract: "swap your photo, keep the design."
// ─────────────────────────────────────────────────────────────

import type { DesignDoc } from "@supa/design-model";

export type SlotKind = "text" | "image" | "color";

export interface TextSlot {
  kind: "text";
  nodeId: string;                    // text layer
  label: string;                     // "Headline", shown in the bind UI
  maxLength?: number;                // enforced at bind time + instantiation
  allowRichRuns: boolean;            // false → plain string replaces runs
  minFontSize?: number;              // autofit floor (see autofit.ts)
}

export interface ImageSlot {
  kind: "image";
  nodeId: string;                    // image layer
  label: string;
  fitLock: "inherit" | "cover" | "contain";  // inherit = template's fit wins
  aspectHint?: number;               // w/h shown to the cropper pre-upload
}

export interface ColorSlot {
  kind: "color";
  target: { nodeId: string; field: "fill" | "stroke" | "color" } | { themeKey: string };
  label: string;
}

export type Slot = TextSlot | ImageSlot | ColorSlot;

export interface Theme {
  tokens: Record<string, string>;    // name → hex; text/image layers may reference by token name
  palette: { name: string; colors: string[] }[];  // alt palettes for one-click reskin
}

export interface DesignTemplate {
  id: string;
  schemaVersion: number;
  name: string;
  doc: DesignDoc;                    // fully valid doc — renders on its own
  slots: Slot[];
  theme: Theme;
  tags: string[];                    // catalog facets
  sizeHint: { width: number; height: number; name: string };  // "IG Post 1080×1080"
  version: number;                   // bumped on republish; see publish path
}

// ============ HELPERS ============

/**
 * Returns all slots of a given kind.
 */
export function getSlotsByKind(template: DesignTemplate, kind: SlotKind): Slot[] {
  return template.slots.filter((s) => s.kind === kind);
}

/**
 * Returns the slot that targets a given node, or null if the node isn't slotted.
 */
export function getSlotForNode(template: DesignTemplate, nodeId: string): Slot | null {
  for (const slot of template.slots) {
    if (slot.kind === "color") {
      if ("nodeId" in slot.target && slot.target.nodeId === nodeId) return slot;
    } else {
      if (slot.nodeId === nodeId) return slot;
    }
  }
  return null;
}

/**
 * Returns true if a node is slotted (user-editable) vs locked (template-fixed).
 */
export function isNodeSlotted(template: DesignTemplate, nodeId: string): boolean {
  return getSlotForNode(template, nodeId) !== null;
}

/**
 * Returns all node IDs referenced by slots (the editable set).
 */
export function getSlottedNodeIds(template: DesignTemplate): Set<string> {
  const ids = new Set<string>();
  for (const slot of template.slots) {
    if (slot.kind === "color") {
      if ("nodeId" in slot.target) ids.add(slot.target.nodeId);
    } else {
      ids.add(slot.nodeId);
    }
  }
  return ids;
}

/**
 * Resolves a theme token to a hex color.
 * Returns null if the token isn't in the theme.
 */
export function resolveThemeToken(theme: Theme, tokenName: string): string | null {
  return theme.tokens[tokenName] ?? null;
}
