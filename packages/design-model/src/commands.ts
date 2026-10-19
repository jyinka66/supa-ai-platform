// ─────────────────────────────────────────────────────────────
// The write path. Every mutation is one of these; undo = inverse.
//
// Rules:
//   1. Commands are pure data (serializable, network-safe).
//   2. No command contains functions or closures.
//   3. Every node id is explicit (ULID, generated at command-creation time).
//   4. BATCH wraps multiple commands into one undo step.
//   5. UPDATE_PROPS props are validated against the node's Zod schema
//      before execution (see validator.ts).
// ─────────────────────────────────────────────────────────────

import type { NodeId, AssetId, LayerNode, Page, RichRun } from "./types";
import { findLayerById, findParent, findPage, isContainerNode, cloneLayer } from "./types";
import { safeValidateLayer } from "./validator";

// ============ COMMAND TYPES ============

export type Command =
  | { op: "ADD_NODE"; parentId: NodeId | null; pageId: NodeId; index: number; node: LayerNode }
  | { op: "DELETE_NODES"; pageId: NodeId; ids: NodeId[] }
  | { op: "MOVE_NODES"; pageId: NodeId; ids: NodeId[]; parentId: NodeId | null; index: number }
  | { op: "UPDATE_PROPS"; pageId: NodeId; id: NodeId; props: Record<string, unknown> }
  | { op: "UPDATE_TEXT"; pageId: NodeId; id: NodeId; content: string; runs: RichRun[] }
  | { op: "REPLACE_IMAGE"; pageId: NodeId; id: NodeId; assetId: AssetId }
  | { op: "GROUP"; pageId: NodeId; ids: NodeId[]; groupId?: NodeId }
  | { op: "UNGROUP"; pageId: NodeId; groupId: NodeId }
  | { op: "REORDER"; pageId: NodeId; id: NodeId; toIndex: number }
  | { op: "SET_PAGE_BG"; pageId: NodeId; background: Page["background"] }
  | { op: "ADD_PAGE"; page: Page; index?: number }
  | { op: "DELETE_PAGE"; pageId: NodeId }
  | { op: "REORDER_PAGE"; pageId: NodeId; toIndex: number }
  | { op: "BATCH"; commands: Command[] };

// ============ EXECUTE ============

/**
 * Executes a command on the doc (mutates in place).
 * Pure data-in, state-out — no side effects, no I/O.
 *
 * @throws if the command is invalid (e.g. node not found, validation fails)
 */
export function execute(doc: import("./types").DesignDoc, cmd: Command): void {
  switch (cmd.op) {
    case "ADD_NODE":
      executeAddNode(doc, cmd);
      break;
    case "DELETE_NODES":
      executeDeleteNodes(doc, cmd);
      break;
    case "MOVE_NODES":
      executeMoveNodes(doc, cmd);
      break;
    case "UPDATE_PROPS":
      executeUpdateProps(doc, cmd);
      break;
    case "UPDATE_TEXT":
      executeUpdateText(doc, cmd);
      break;
    case "REPLACE_IMAGE":
      executeReplaceImage(doc, cmd);
      break;
    case "GROUP":
      executeGroup(doc, cmd);
      break;
    case "UNGROUP":
      executeUngroup(doc, cmd);
      break;
    case "REORDER":
      executeReorder(doc, cmd);
      break;
    case "SET_PAGE_BG":
      executeSetPageBg(doc, cmd);
      break;
    case "ADD_PAGE":
      executeAddPage(doc, cmd);
      break;
    case "DELETE_PAGE":
      executeDeletePage(doc, cmd);
      break;
    case "REORDER_PAGE":
      executeReorderPage(doc, cmd);
      break;
    case "BATCH":
      for (const sub of cmd.commands) execute(doc, sub);
      break;
  }
}

// ============ UNDO ============

/**
 * Inverts a command and executes the inverse on the doc.
 * The inverse is computed from the doc state BEFORE the command ran,
 * so callers must snapshot the doc before executing if they want undo.
 *
 * For simplicity, this implementation snapshots + replays:
 *   1. Clone the doc before execute
 *   2. On undo, restore the clone
 *
 * This is O(n) per undo but correct for all cases. A future optimization
 * can compute true inverses (like the class-based approach did).
 */
export function invert(doc: import("./types").DesignDoc, cmd: Command, snapshot: import("./types").DesignDoc): void {
  // Restore from snapshot — the caller is responsible for taking it.
  // This is the simplest correct undo: clone the pre-command state.
  Object.assign(doc, structuredClone(snapshot));
}

// ============ COMMAND IMPLEMENTATIONS ============

function executeAddNode(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "ADD_NODE" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) throw new Error(`page_not_found: ${cmd.pageId}`);

  if (cmd.parentId === null) {
    page.layers.splice(cmd.index, 0, cmd.node);
  } else {
    const parent = findLayerById(page, cmd.parentId);
    if (!parent || !isContainerNode(parent)) throw new Error(`parent_not_found: ${cmd.parentId}`);
    if (!parent.children) parent.children = [];
    parent.children.splice(cmd.index, 0, cmd.node);
  }
}

function executeDeleteNodes(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "DELETE_NODES" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;

  const idSet = new Set(cmd.ids);
  page.layers = page.layers.filter((l) => !idSet.has(l.id));
  // Also remove from containers.
  function removeFromChildren(node: LayerNode) {
    if (isContainerNode(node) && node.children) {
      node.children = node.children.filter((c) => !idSet.has(c.id));
      for (const child of node.children) removeFromChildren(child);
    }
  }
  for (const layer of page.layers) removeFromChildren(layer);
}

function executeMoveNodes(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "MOVE_NODES" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;

  // Collect nodes to move (preserve order).
  const nodes: LayerNode[] = [];
  for (const id of cmd.ids) {
    const node = findLayerById(page, id);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return;

  // Remove from current locations.
  const idSet = new Set(cmd.ids);
  page.layers = page.layers.filter((l) => !idSet.has(l.id));
  function removeFromChildren(node: LayerNode) {
    if (isContainerNode(node) && node.children) {
      node.children = node.children.filter((c) => !idSet.has(c.id));
      for (const child of node.children) removeFromChildren(child);
    }
  }
  for (const layer of page.layers) removeFromChildren(layer);

  // Add to new parent.
  if (cmd.parentId === null) {
    page.layers.splice(cmd.index, 0, ...nodes);
  } else {
    const parent = findLayerById(page, cmd.parentId);
    if (!parent || !isContainerNode(parent)) throw new Error(`parent_not_found: ${cmd.parentId}`);
    if (!parent.children) parent.children = [];
    parent.children.splice(cmd.index, 0, ...nodes);
  }
}

function executeUpdateProps(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "UPDATE_PROPS" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;
  const node = findLayerById(page, cmd.id);
  if (!node) throw new Error(`node_not_found: ${cmd.id}`);

  // Merge props.
  const updated = { ...node, ...cmd.props };

  // Validate the result against the schema.
  const result = safeValidateLayer(updated);
  if (!result.success) {
    throw new Error(`validation_failed: ${result.error.issues[0]?.message ?? "unknown"}`);
  }

  // Apply the validated update.
  Object.assign(node, cmd.props);
}

function executeUpdateText(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "UPDATE_TEXT" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;
  const node = findLayerById(page, cmd.id);
  if (!node || node.type !== "text") throw new Error(`not_text_node: ${cmd.id}`);

  node.content = cmd.content;
  node.runs = cmd.runs;
}

function executeReplaceImage(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "REPLACE_IMAGE" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;
  const node = findLayerById(page, cmd.id);
  if (!node || node.type !== "image") throw new Error(`not_image_node: ${cmd.id}`);

  node.assetId = cmd.assetId;
}

function executeGroup(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "GROUP" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;

  // Collect the nodes to group (preserve order).
  const nodes: LayerNode[] = [];
  for (const id of cmd.ids) {
    const node = findLayerById(page, id);
    if (node) nodes.push(cloneLayer(node));
  }
  if (nodes.length < 2) return;

  // Create the group.
  const groupId = cmd.groupId ?? `n_group_${String(Date.now())}`;
  const group: LayerNode = {
    id: groupId,
    type: "group",
    name: "Group",
    locked: false,
    hidden: false,
    rect: computeBoundingRect(nodes),
    rotation: 0,
    opacity: 1,
    blend: "normal",
    constraints: {},
    children: nodes,
  };

  // Remove the original nodes.
  const idSet = new Set(cmd.ids);
  page.layers = page.layers.filter((l) => !idSet.has(l.id));
  function removeFromChildren(node: LayerNode) {
    if (isContainerNode(node) && node.children) {
      node.children = node.children.filter((c) => !idSet.has(c.id));
      for (const child of node.children) removeFromChildren(child);
    }
  }
  for (const layer of page.layers) removeFromChildren(layer);

  // Add the group to the page root (or could add to the common parent).
  page.layers.push(group);
}

function executeUngroup(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "UNGROUP" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;

  const group = findLayerById(page, cmd.groupId);
  if (!group || group.type !== "group" || !group.children) return;

  // Replace the group with its children in the parent's children list.
  const parent = findParent(page, cmd.groupId);
  const siblings = parent && isContainerNode(parent) && parent.children
    ? parent.children
    : page.layers;

  const idx = siblings.findIndex((l) => l.id === cmd.groupId);
  if (idx < 0) return;

  // Remove the group, insert its children at the same position.
  siblings.splice(idx, 1, ...group.children);
}

function executeReorder(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "REORDER" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;

  const parent = findParent(page, cmd.id);
  const siblings = parent && isContainerNode(parent) && parent.children
    ? parent.children
    : page.layers;

  const fromIdx = siblings.findIndex((l) => l.id === cmd.id);
  if (fromIdx < 0) return;

  const [node] = siblings.splice(fromIdx, 1);
  if (node) {
    const toIdx = cmd.toIndex > fromIdx ? cmd.toIndex - 1 : cmd.toIndex;
    siblings.splice(toIdx, 0, node);
  }
}

function executeSetPageBg(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "SET_PAGE_BG" }>): void {
  const page = findPage(doc, cmd.pageId);
  if (!page) return;
  page.background = cmd.background;
}

function executeAddPage(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "ADD_PAGE" }>): void {
  if (cmd.index !== undefined) {
    doc.pages.splice(cmd.index, 0, cmd.page);
  } else {
    doc.pages.push(cmd.page);
  }
}

function executeDeletePage(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "DELETE_PAGE" }>): void {
  const idx = doc.pages.findIndex((p) => p.id === cmd.pageId);
  if (idx >= 0) doc.pages.splice(idx, 1);
}

function executeReorderPage(doc: import("./types").DesignDoc, cmd: Extract<Command, { op: "REORDER_PAGE" }>): void {
  const fromIdx = doc.pages.findIndex((p) => p.id === cmd.pageId);
  if (fromIdx < 0) return;
  const [page] = doc.pages.splice(fromIdx, 1);
  if (page) {
    const toIdx = cmd.toIndex > fromIdx ? cmd.toIndex - 1 : cmd.toIndex;
    doc.pages.splice(toIdx, 0, page);
  }
}

// ============ HELPERS ============

/**
 * Computes the bounding rect of a set of nodes.
 */
function computeBoundingRect(nodes: LayerNode[]): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.rect.x);
    minY = Math.min(minY, node.rect.y);
    maxX = Math.max(maxX, node.rect.x + node.rect.width);
    maxY = Math.max(maxY, node.rect.y + node.rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
