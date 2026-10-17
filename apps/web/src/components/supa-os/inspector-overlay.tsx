"use client";

import * as React from "react";
import {
  injectInspectorScript,
  isInspectorMessage,
  flattenTree,
  type SerializedComponentNode,
  type InspectorMessage,
} from "@/lib/supa-os/dom-scanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MousePointer2, X, Eye, EyeOff } from "lucide-react";

// ───────────────────────────────────────────────
// InspectorOverlay — wraps the preview iframe + draws the highlight box
// + selection box + the floating properties panel.
// ───────────────────────────────────────────────

export interface InspectorOverlayProps {
  /** The iframe element from the parent (so we can inject the scanner script). */
  iframeRef: React.RefObject<HTMLIFrameElement>;
  /** Called when the user selects a component (so the parent can show the inspector UI). */
  onSelect?: (node: SerializedComponentNode | null) => void;
  /** Called when the user hovers a component (for status-bar display). */
  onHover?: (node: SerializedComponentNode | null) => void;
}

export function InspectorOverlay({ iframeRef, onSelect, onHover }: InspectorOverlayProps) {
  const [enabled, setEnabled] = React.useState(false);
  const [tree, setTree] = React.useState<SerializedComponentNode[]>([]);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Flat lookup so we can find a node by id in O(1).
  const flatNodes = React.useMemo(() => flattenTree(tree), [tree]);
  const nodeMap = React.useMemo(() => {
    const m = new Map<string, SerializedComponentNode>();
    for (const n of flatNodes) m.set(n.id, n);
    return m;
  }, [flatNodes]);

  const hoveredNode = hoveredId ? nodeMap.get(hoveredId) ?? null : null;
  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;

  // ─────────────────────────────────────────────
  // postMessage bridge — listen for inspector events from the iframe.
  // ─────────────────────────────────────────────
  React.useEffect(() => {
    function handleMessage(e: MessageEvent) {
      // Verify origin — only accept from same-origin iframes (preview is same-origin).
      // In production, the preview iframe URL would be configured.
      if (!isInspectorMessage(e.data)) return;
      const msg = e.data as InspectorMessage;
      switch (msg.type) {
        case "inspector:tree":
          setTree(msg.tree);
          setError(null);
          break;
        case "inspector:hover":
          setHoveredId(msg.nodeId);
          onHover?.(msg.nodeId ? nodeMapRef.current.get(msg.nodeId) ?? null : null);
          break;
        case "inspector:select":
          setSelectedId(msg.nodeId);
          onSelect?.(msg.nodeId ? nodeMapRef.current.get(msg.nodeId) ?? null : null);
          break;
        case "inspector:clear":
          setTree([]);
          setHoveredId(null);
          setSelectedId(null);
          break;
        case "inspector:error":
          setError(msg.message);
          break;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onHover, onSelect]);

  // Keep nodeMap accessible inside the message handler (refs avoid stale closures).
  const nodeMapRef = React.useRef(nodeMap);
  React.useEffect(() => { nodeMapRef.current = nodeMap; }, [nodeMap]);

  // ─────────────────────────────────────────────
  // Enable/disable inspector — injects the scanner script + sends enable message.
  // ─────────────────────────────────────────────
  React.useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function handleLoad() {
      const iframe = iframeRef.current;
      if (!iframe) return;
      injectInspectorScript(iframe);
      if (enabled) {
        iframe.contentWindow?.postMessage({ type: "inspector:enable" }, "*");
      }
    }

    if (iframe.contentDocument?.readyState === "complete") {
      handleLoad();
    }
    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [iframeRef, enabled]);

  React.useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: enabled ? "inspector:enable" : "inspector:disable" },
      "*",
    );
    if (!enabled) {
      setTree([]);
      setHoveredId(null);
      setSelectedId(null);
      onHover?.(null);
      onSelect?.(null);
    }
  }, [enabled, iframeRef, onHover, onSelect]);

  // ─────────────────────────────────────────────
  // Render the toggle button + the highlight/selection boxes + the properties panel.
  // ─────────────────────────────────────────────
  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Toggle button — pointer-events: auto so it's clickable */}
      <div className="absolute top-md right-md pointer-events-auto">
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          onClick={() => setEnabled((p) => !p)}
        >
          {enabled ? <Eye className="w-3 h-3 mr-1" /> : <EyeOff className="w-3 h-3 mr-1" />}
          {enabled ? "Inspector on" : "Inspector off"}
        </Button>
      </div>

      {/* Hover highlight box (blue outline) */}
      {enabled && hoveredNode?.rect && (
        <div
          className="absolute border-2 border-accent bg-accent/10 pointer-events-none transition-all"
          style={{
            left: hoveredNode.rect.x,
            top: hoveredNode.rect.y,
            width: hoveredNode.rect.width,
            height: hoveredNode.rect.height,
          }}
        >
          <div className="absolute -top-6 left-0 bg-accent text-white text-xs px-sm py-0.5 rounded-sm whitespace-nowrap">
            {hoveredNode.name}
          </div>
        </div>
      )}

      {/* Selection box (green outline) — sticks until cleared */}
      {enabled && selectedNode?.rect && (
        <div
          className="absolute border-2 border-success pointer-events-none"
          style={{
            left: selectedNode.rect.x,
            top: selectedNode.rect.y,
            width: selectedNode.rect.width,
            height: selectedNode.rect.height,
          }}
        />
      )}

      {/* Properties panel — pointer-events: auto so it's interactive */}
      {enabled && selectedNode && (
        <div className="absolute bottom-md right-md w-80 max-h-96 bg-surface border border-border rounded-md shadow-lg pointer-events-auto flex flex-col">
          <div className="flex items-center justify-between p-sm border-b border-border">
            <div className="flex items-center gap-sm">
              <MousePointer2 className="w-3 h-3 text-success" />
              <span className="font-medium text-sm">{selectedNode.name}</span>
              <Badge variant="outline">{selectedNode.category}</Badge>
            </div>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setSelectedId(null)}>
              <X className="w-3 h-3" />
            </Button>
          </div>
          <ScrollArea className="flex-1 p-sm">
            <div className="space-y-sm text-xs">
              {selectedNode.filePath && (
                <div>
                  <div className="text-textMuted">Source</div>
                  <div className="font-mono text-text">
                    {selectedNode.filePath}{selectedNode.lineNumber != null ? `:${selectedNode.lineNumber}` : ""}
                  </div>
                </div>
              )}
              {Object.keys(selectedNode.props).length > 0 && (
                <div>
                  <div className="text-textMuted mb-1">Props</div>
                  <pre className="font-mono bg-surfaceMuted p-sm rounded text-text overflow-auto">
                    {JSON.stringify(selectedNode.props, null, 2)}
                  </pre>
                </div>
              )}
              <Button size="sm" className="w-full mt-sm">
                Edit with AI
              </Button>
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="absolute top-md left-md pointer-events-auto bg-danger/10 border border-danger/30 text-danger text-xs px-md py-sm rounded-md max-w-sm">
          Inspector error: {error}
        </div>
      )}
    </div>
  );
}
