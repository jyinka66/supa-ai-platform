// ─────────────────────────────────────────────────────────────
// LayersPanel — virtualized layer list (800+ layers).
//
// Fixed row height, windowed render. Row: visibility toggle, lock toggle,
// type icon, name (double-click rename), indent for children.
//
// Interactions:
//   click → select (shift/cmd for multi); drag row → reorder
//   context menu → duplicate, delete, group, mask-with, move-to-page
// Auto-reveal: selection changes from canvas scroll the list to the
// selected row; selection from panel pans the canvas to reveal the node.
// ─────────────────────────────────────────────────────────────

"use client";

import { useRef, useState, useMemo, useCallback, useEffect, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { EditorStore, EditorState } from "./store";
import type { LayerNode, Page, NodeId } from "@supa/design-model";
import { isContainerNode, getChildren, flattenLayers } from "@supa/design-model";

// ============ CONSTANTS ============

const ROW_HEIGHT = 28; // px
const INDENT = 16; // px per depth level
const MAX_VISIBLE_ROWS = 100; // virtualization window

// ============ FLAT LAYER LIST ============

interface FlatLayer {
  node: LayerNode;
  depth: number;
  parentId: NodeId | null;
  hasChildren: boolean;
  isExpanded: boolean;
}

function flattenForList(page: Page, expanded: Set<string>): FlatLayer[] {
  const result: FlatLayer[] = [];

  function walk(node: LayerNode, depth: number, parentId: NodeId | null) {
    const hasChildren = isContainerNode(node) && (node.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(node.id);

    result.push({ node, depth, parentId, hasChildren, isExpanded });

    if (hasChildren && isExpanded && node.children) {
      for (const child of node.children) {
        walk(child, depth + 1, node.id);
      }
    }
  }

  // Layers are displayed top-to-bottom, but the array is back→front,
  // so we reverse for display (front = top of list).
  for (let i = page.layers.length - 1; i >= 0; i--) {
    walk(page.layers[i]!, 0, null);
  }

  return result;
}

// ============ LAYERS PANEL ============

interface LayersPanelProps {
  store: EditorStore;
}

export function LayersPanel({ store }: LayersPanelProps) {
  const state = useEditorState(store);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const page = state.doc.pages.find((p) => p.id === state.pageId);
  const flatLayers = useMemo(() => {
    if (!page) return [];
    return flattenForList(page, expanded);
  }, [page, expanded]);

  // ============ AUTO-REVEAL ============

  useEffect(() => {
    if (state.selection.length === 0) return;
    const selectedId = state.selection[0]!;
    const index = flatLayers.findIndex((l) => l.node.id === selectedId);
    if (index < 0) return;

    const rowTop = index * ROW_HEIGHT;
    const viewTop = scrollTop;
    const viewBottom = scrollTop + (scrollRef.current?.clientHeight ?? 0);

    if (rowTop < viewTop) {
      scrollRef.current?.scrollTo({ top: rowTop, behavior: "smooth" });
    } else if (rowTop + ROW_HEIGHT > viewBottom) {
      scrollRef.current?.scrollTo({ top: rowTop - (scrollRef.current?.clientHeight ?? 0) + ROW_HEIGHT, behavior: "smooth" });
    }
  }, [state.selection, flatLayers, scrollTop]);

  // ============ VIRTUALIZATION ============

  const viewportHeight = scrollRef.current?.clientHeight ?? 400;
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
  const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, flatLayers.length);
  const visibleLayers = flatLayers.slice(startIndex, endIndex);
  const totalHeight = flatLayers.length * ROW_HEIGHT;
  const offsetY = startIndex * ROW_HEIGHT;

  // ============ HANDLERS ============

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.shiftKey) {
      // Add to selection.
      const current = store.get().selection;
      if (current.includes(id)) {
        store.setSelection(current.filter((c) => c !== id));
      } else {
        store.setSelection([...current, id]);
      }
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle in selection.
      const current = store.get().selection;
      if (current.includes(id)) {
        store.setSelection(current.length === 1 ? [] : current.filter((c) => c !== id));
      } else {
        store.setSelection([...current, id]);
      }
    } else {
      // Single select.
      store.setSelection([id]);
    }
  }, [store]);

  const handleDoubleClick = useCallback((id: string) => {
    setRenamingId(id);
  }, []);

  const handleRename = useCallback((id: string, newName: string) => {
    const state = store.get();
    store.apply({
      op: "UPDATE_PROPS",
      pageId: state.pageId,
      id,
      props: { name: newName },
    });
    setRenamingId(null);
  }, [store]);

  const handleVisibilityToggle = useCallback((id: string, hidden: boolean) => {
    const state = store.get();
    store.apply({
      op: "UPDATE_PROPS",
      pageId: state.pageId,
      id,
      props: { hidden: !hidden },
    });
  }, [store]);

  const handleLockToggle = useCallback((id: string, locked: boolean) => {
    const state = store.get();
    store.apply({
      op: "UPDATE_PROPS",
      pageId: state.pageId,
      id,
      props: { locked: !locked },
    });
  }, [store]);

  // ============ DRAG & DROP REORDER ============

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = dragId ?? e.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const state = store.get();
    const flat = flattenForList(
      state.doc.pages.find((p) => p.id === state.pageId)!,
      expanded,
    );

    const sourceIdx = flat.findIndex((l) => l.node.id === sourceId);
    const targetIdx = flat.findIndex((l) => l.node.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;

    const target = flat[targetIdx]!;

    // Determine drop position: above or below the target row.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;

    // Move the source node.
    store.apply({
      op: "MOVE_NODES",
      pageId: state.pageId,
      ids: [sourceId],
      parentId: target.parentId, // same parent as the target
      index: isAbove ? targetIdx : targetIdx + 1,
    });

    setDragId(null);
    setDragOverId(null);
  }, [dragId, expanded, store]);

  // ============ CONTEXT MENU ============

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: id });
  }, []);

  // ============ RENDER ============

  if (!page) {
    return <div className="p-4 text-sm text-textMuted">No page</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-textMuted">Layers</h2>
        <span className="text-xs text-textMuted">{flatLayers.length}</span>
      </div>

      {/* Virtualized list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {/* Spacer for virtualization */}
        <div style={{ height: totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visibleLayers.map((flat) => (
              <LayerRow
                key={flat.node.id}
                flat={flat}
                isSelected={state.selection.includes(flat.node.id)}
                isRenaming={renamingId === flat.node.id}
                isDragOver={dragOverId === flat.node.id}
                onClick={(e) => handleClick(e, flat.node.id)}
                onDoubleClick={() => handleDoubleClick(flat.node.id)}
                onRename={(name) => handleRename(flat.node.id, name)}
                onToggleExpand={() => toggleExpand(flat.node.id)}
                onVisibilityToggle={() => handleVisibilityToggle(flat.node.id, flat.node.hidden)}
                onLockToggle={() => handleLockToggle(flat.node.id, flat.node.locked)}
                onDragStart={(e) => handleDragStart(e, flat.node.id)}
                onDragOver={(e) => handleDragOver(e, flat.node.id)}
                onDrop={(e) => handleDrop(e, flat.node.id)}
                onContextMenu={(e) => handleContextMenu(e, flat.node.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <LayerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          store={store}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ============ LAYER ROW ============

interface LayerRowProps {
  flat: FlatLayer;
  isSelected: boolean;
  isRenaming: boolean;
  isDragOver: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onRename: (name: string) => void;
  onToggleExpand: () => void;
  onVisibilityToggle: () => void;
  onLockToggle: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function LayerRow({
  flat,
  isSelected,
  isRenaming,
  isDragOver,
  onClick,
  onDoubleClick,
  onRename,
  onToggleExpand,
  onVisibilityToggle,
  onLockToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onContextMenu,
}: LayerRowProps) {
  const { node, depth, hasChildren, isExpanded } = flat;

  return (
    <div
      className={`flex items-center gap-1 border-b border-border/50 px-2 text-xs ${
        isSelected ? "bg-accent/15" : "hover:bg-surfaceMuted/50"
      } ${isDragOver ? "border-t-2 border-t-accent" : ""}`}
      style={{ height: ROW_HEIGHT, paddingLeft: depth * INDENT }}
      draggable={!isRenaming}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Expand/collapse toggle */}
      {hasChildren ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="flex h-4 w-4 items-center justify-center text-textMuted hover:text-text"
        >
          {isExpanded ? "▼" : "▶"}
        </button>
      ) : (
        <span className="w-4" />
      )}

      {/* Type icon */}
      <span className="flex h-4 w-4 items-center justify-center text-textMuted">
        <TypeIcon type={node.type} />
      </span>

      {/* Name (or rename input) */}
      {isRenaming ? (
        <input
          type="text"
          defaultValue={node.name}
          autoFocus
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename((e.target as HTMLInputElement).value);
            if (e.key === "Escape") onRename(node.name);
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-accent px-1 text-xs"
        />
      ) : (
        <span className={`flex-1 truncate ${node.hidden ? "opacity-40" : ""}`}>
          {node.name}
        </span>
      )}

      {/* Lock toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onLockToggle(); }}
        className="flex h-4 w-4 items-center justify-center text-textMuted hover:text-text"
        title={node.locked ? "Unlock" : "Lock"}
      >
        {node.locked ? "🔒" : ""}
      </button>

      {/* Visibility toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onVisibilityToggle(); }}
        className="flex h-4 w-4 items-center justify-center text-textMuted hover:text-text"
        title={node.hidden ? "Show" : "Hide"}
      >
        {node.hidden ? "🚫" : "👁"}
      </button>
    </div>
  );
}

// ============ TYPE ICON ============

function TypeIcon({ type }: { type: string }) {
  switch (type) {
    case "text": return "T";
    case "image": return "🖼";
    case "shape": return "▢";
    case "icon": return "★";
    case "container": return "□";
    case "group": return "⊕";
    default: return "•";
  }
}

// ============ CONTEXT MENU ============

interface LayerContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  store: EditorStore;
  onClose: () => void;
}

function LayerContextMenu({ x, y, nodeId, store, onClose }: LayerContextMenuProps) {
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [onClose]);

  const state = store.get();
  const page = state.doc.pages.find((p) => p.id === state.pageId);
  const node = page ? findLayerInPage(page, nodeId) : null;
  const selection = state.selection.length > 0 ? state.selection : [nodeId];

  const actions = [
    {
      label: "Duplicate",
      action: () => {
        if (!page) return;
        store.beginBatch("duplicate");
        for (const id of selection) {
          const original = findLayerInPage(page, id);
          if (!original) continue;
          const clone = structuredClone(original);
          clone.id = `n_${crypto.randomUUID().slice(0, 12)}`;
          clone.name = `${original.name} copy`;
          clone.rect = { ...original.rect, x: original.rect.x + 20, y: original.rect.y + 20 };
          store.apply({ op: "ADD_NODE", pageId: state.pageId, parentId: null, index: 0, node: clone });
        }
        store.endBatch();
      },
    },
    {
      label: "Delete",
      action: () => {
        store.apply({ op: "DELETE_NODES", pageId: state.pageId, ids: selection });
      },
    },
    {
      label: "Group",
      action: () => {
        if (selection.length < 2) return;
        store.apply({ op: "GROUP", pageId: state.pageId, ids: selection });
      },
    },
    {
      label: "Ungroup",
      action: () => {
        if (node?.type !== "group") return;
        store.apply({ op: "UNGROUP", pageId: state.pageId, groupId: nodeId });
      },
      disabled: node?.type !== "group",
    },
  ];

  return (
    <div
      className="fixed z-50 min-w-40 rounded-md border border-border bg-surface py-1 shadow-lg"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          disabled={a.disabled}
          onClick={() => { a.action(); onClose(); }}
          className="block w-full px-3 py-1 text-left text-xs hover:bg-surfaceMuted disabled:opacity-40"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ============ HELPERS ============

function findLayerInPage(page: Page, id: string): LayerNode | null {
  function search(node: LayerNode): LayerNode | null {
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }
  for (const layer of page.layers) {
    const found = search(layer);
    if (found) return found;
  }
  return null;
}

function useEditorState(store: EditorStore): EditorState {
  return useSyncExternalStore(store.subscribe, store.get);
}
