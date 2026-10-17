// DOM scanner — walks the rendered DOM inside the preview iframe and
// produces a ComponentNode[] tree that the inspector overlay can render.
//
// Strategy: React attaches `data-reactroot` to mounted roots + each
// component instance gets a fiber with `_owner`/`_debugSource` info.
// For non-React builds (Vue, Angular, plain HTML), we fall back to
// `data-component-name` attributes that Supa OS-generated code emits.
//
// The scanner runs INSIDE the iframe (the preview) — it walks the DOM,
// finds component boundaries, and reports back to the parent window via
// `postMessage`. The parent (Supa OS dashboard) listens for these
// messages and updates the inspector overlay.
//
// What this file exports:
//   - scanDom(root: Element): ComponentNode[] — the scanner itself
//   - injectInspectorScript(iframe: HTMLIFrameElement): void — bootstraps
//     the scanner inside the preview iframe + sets up postMessage bridge
//   - InspectorMessage types — the postMessage protocol

import type { ComponentNode, ComponentCategory } from "@/lib/supa-os/component-inspector";

// ───────────────────────────────────────────────
// Types — the postMessage protocol between the
// preview iframe (scanner) and the parent (overlay).
// ───────────────────────────────────────────────

export type InspectorMessage =
  | { type: "inspector:tree"; tree: SerializedComponentNode[] }
  | { type: "inspector:hover"; nodeId: string | null }
  | { type: "inspector:select"; nodeId: string }
  | { type: "inspector:clear" }
  | { type: "inspector:error"; message: string };

/** A simplified ComponentNode shape for postMessage (no methods, no cycles). */
export interface SerializedComponentNode {
  id: string;
  name: string;
  category: ComponentCategory;
  filePath: string | null;
  lineNumber: number | null;
  props: Record<string, unknown>;
  children: SerializedComponentNode[];
  isBusinessLogic: boolean;
  /** The DOM rect (in iframe-local coordinates) for the overlay to draw. */
  rect: { x: number; y: number; width: number; height: number } | null;
}

// ───────────────────────────────────────────────
// Category detection — map a DOM element to a ComponentCategory.
// ───────────────────────────────────────────────

const LAYOUT_TAGS = new Set(["div", "section", "article", "aside", "header", "footer", "main", "nav", "form"]);
const FORM_TAGS = new Set(["input", "button", "select", "textarea", "label", "fieldset", "option"]);
const DISPLAY_TAGS = new Set(["table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "dl", "dt", "dd"]);
const NAV_TAGS = new Set(["nav", "a"]);
const FEEDBACK_TAGS = new Set(["dialog", "alert"]);
const MEDIA_TAGS = new Set(["img", "video", "audio", "picture", "svg", "canvas"]);

function detectCategory(el: Element): ComponentCategory {
  const name = el.getAttribute("data-component-name");
  if (name) {
    // Heuristics on the component name (PascalCase React/Vue components).
    if (/^(Button|Input|Select|Checkbox|Radio|Form|Field)/.test(name)) return "form";
    if (/^(Card|Table|Chart|Badge|Stat|Avatar)/.test(name)) return "display";
    if (/^(Sidebar|Tabs|Breadcrumb|Pagination|Menu)/.test(name)) return "navigation";
    if (/^(Toast|Modal|Alert|Spinner|Dialog)/.test(name)) return "feedback";
    if (/^(DataTable|List|TreeView)/.test(name)) return "data";
    if (/^(Image|Video|Audio)/.test(name)) return "media";
    return "layout"; // default for custom components
  }
  const tag = el.tagName.toLowerCase();
  if (FORM_TAGS.has(tag)) return "form";
  if (DISPLAY_TAGS.has(tag)) return "display";
  if (NAV_TAGS.has(tag)) return "navigation";
  if (FEEDBACK_TAGS.has(tag)) return "feedback";
  if (MEDIA_TAGS.has(tag)) return "media";
  if (LAYOUT_TAGS.has(tag)) return "layout";
  // Unknown tags like custom elements default to layout.
  return "layout";
}

// ───────────────────────────────────────────────
// Component boundary detection.
//
// A DOM element is a "component boundary" if any of:
//   - It has a `data-component-name` attribute (Supa OS-generated convention).
//   - It has a React fiber with a name (`__reactFiber$*` → `_owner.type.name`).
//   - It's a known semantic element (button, input, table, etc.).
// ───────────────────────────────────────────────

function getComponentName(el: Element): string | null {
  // Supa OS-generated convention — takes precedence.
  const explicitName = el.getAttribute("data-component-name");
  if (explicitName) return explicitName;

  // React fiber (dev mode).
  const reactFiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (reactFiberKey) {
    const fiber = (el as unknown as Record<string, { _owner?: { type?: { name?: string } }; type?: { name?: string } }>)[reactFiberKey];
    const ownerName = fiber?._owner?.type?.name;
    const typeName = fiber?.type?.name;
    if (ownerName && /^[A-Z]/.test(ownerName)) return ownerName;
    if (typeName && /^[A-Z]/.test(typeName)) return typeName;
  }

  // Semantic fallback.
  const tag = el.tagName.toLowerCase();
  if (["button", "input", "select", "textarea", "table", "img", "video", "audio"].includes(tag)) {
    return tag.charAt(0).toUpperCase() + tag.slice(1);
  }

  return null;
}

function getComponentSource(el: Element): { filePath: string | null; lineNumber: number | null } {
  // React dev mode: fiber._debugSource has { fileName, lineNumber }.
  const reactFiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (reactFiberKey) {
    const fiber = (el as unknown as Record<string, { _debugSource?: { fileName: string; lineNumber: number } }>)[reactFiberKey];
    if (fiber?._debugSource) {
      return { filePath: fiber._debugSource.fileName, lineNumber: fiber._debugSource.lineNumber };
    }
  }
  // Supa OS convention — emit data-source-path + data-source-line.
  const filePath = el.getAttribute("data-source-path");
  const lineNumber = el.getAttribute("data-source-line");
  return {
    filePath,
    lineNumber: lineNumber ? parseInt(lineNumber, 10) : null,
  };
}

// ───────────────────────────────────────────────
// Props extraction — read the visible props from the DOM.
// ───────────────────────────────────────────────

function extractProps(el: Element): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  // Direct attributes (className → className, not 'class').
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === "data-component-name" || attr.name.startsWith("data-source-")) continue;
    const propKey = attr.name === "class" ? "className" : attr.name;
    props[propKey] = attr.value;
  }
  // Text content for leaf nodes (truncated for display).
  if (el.children.length === 0 && el.textContent && el.textContent.trim().length > 0) {
    props.children = el.textContent.trim().slice(0, 100);
  }
  return props;
}

// ───────────────────────────────────────────────
// Rect extraction — the overlay needs the position to draw the highlight.
// ───────────────────────────────────────────────

function getRect(el: Element): SerializedComponentNode["rect"] {
  const r = el.getBoundingClientRect();
  // Round to integers + zero out negative sizes (hidden elements).
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)),
    height: Math.max(0, Math.round(r.height)),
  };
}

// ───────────────────────────────────────────────
// scanDom — the scanner. Walks the DOM tree and produces a SerializedComponentNode[].
//
// Only includes elements that are component boundaries (have a name).
// Walks depth-first; children are nested under their parent component.
// ───────────────────────────────────────────────

export function scanDom(root: Element): SerializedComponentNode[] {
  const tree: SerializedComponentNode[] = [];
  walk(root, tree);
  return tree;
}

function walk(el: Element, accumulator: SerializedComponentNode[]): void {
  // Skip text nodes, comments, scripts, styles.
  if (el.nodeType !== 1) return; // 1 = ELEMENT_NODE
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "link", "meta", "head", "title"].includes(tag)) return;

  const name = getComponentName(el);
  if (name) {
    // This element is a component boundary — record + recurse into children.
    const { filePath, lineNumber } = getComponentSource(el);
    const children: SerializedComponentNode[] = [];
    for (const child of Array.from(el.children)) {
      walk(child, children);
    }
    const isBusinessLogic = el.hasAttribute("data-business-logic");
    const node: SerializedComponentNode = {
      id: el.getAttribute("data-inspector-id") ?? `${name}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      category: detectCategory(el),
      filePath,
      lineNumber,
      props: extractProps(el),
      children,
      isBusinessLogic,
      rect: getRect(el),
    };
    // Tag the DOM element with the inspector id so hover/click can find it later.
    el.setAttribute("data-inspector-id", node.id);
    accumulator.push(node);
  } else {
    // Not a boundary — recurse into children, don't add a node.
    for (const child of Array.from(el.children)) {
      walk(child, accumulator);
    }
  }
}

// ───────────────────────────────────────────────
// injectInspectorScript — bootstraps the scanner inside the preview iframe.
//
// After injecting, the iframe:
//   1. Listens for `inspector:enable` messages from the parent.
//   2. On enable: attaches mouseover + click listeners that find the
//      nearest component boundary under the cursor + post a hover/select
//      message back.
//   3. Periodically rescans the DOM (every 2s) so the tree stays fresh
//      as the preview re-renders.
//   4. Posts the initial tree on enable.
// ───────────────────────────────────────────────

export function injectInspectorScript(iframe: HTMLIFrameElement): void {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;

  // The script source — kept as a string so we can inject it across
  // the iframe boundary (it runs in the iframe's context, not the parent's).
  const scriptSource = `
    (function() {
      var enabled = false;
      var scanInterval = null;
      var currentHover = null;

      function findComponentBoundary(el) {
        var node = el;
        while (node && node !== document.body) {
          if (node.getAttribute && node.getAttribute('data-component-name')) {
            return node;
          }
          if (node.tagName && /^[A-Z]/.test(node.tagName)) {
            // Custom element (web component).
            return node;
          }
          // Semantic tags.
          var tag = (node.tagName || '').toLowerCase();
          if (['button', 'input', 'select', 'textarea', 'table', 'img', 'video', 'audio', 'nav', 'form'].indexOf(tag) !== -1) {
            return node;
          }
          node = node.parentElement;
        }
        return null;
      }

      function handleMouseOver(e) {
        if (!enabled) return;
        var target = findComponentBoundary(e.target);
        if (!target) return;
        var id = target.getAttribute('data-inspector-id');
        if (id === currentHover) return; // dedupe
        currentHover = id;
        // Highlight visually (overlay drawing is done by the parent).
        target.style.outline = '2px solid #3b82f6';
        // Auto-remove outline on mouseout.
        target.addEventListener('mouseout', function remove() {
          target.style.outline = '';
          target.removeEventListener('mouseout', remove);
        }, { once: true });
        parent.postMessage({ type: 'inspector:hover', nodeId: id }, '*');
      }

      function handleClick(e) {
        if (!enabled) return;
        var target = findComponentBoundary(e.target);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        var id = target.getAttribute('data-inspector-id');
        parent.postMessage({ type: 'inspector:select', nodeId: id }, '*');
      }

      function scan() {
        if (!enabled) return;
        try {
          var tree = window.__supaInspectorScan(document.body);
          parent.postMessage({ type: 'inspector:tree', tree: tree }, '*');
        } catch (err) {
          parent.postMessage({ type: 'inspector:error', message: String(err) }, '*');
        }
      }

      window.addEventListener('message', function(e) {
        if (e.data.type === 'inspector:enable') {
          if (enabled) return;
          enabled = true;
          document.body.addEventListener('mouseover', handleMouseOver, true);
          document.body.addEventListener('click', handleClick, true);
          scan();
          scanInterval = setInterval(scan, 2000);
        } else if (e.data.type === 'inspector:disable') {
          if (!enabled) return;
          enabled = false;
          document.body.removeEventListener('mouseover', handleMouseOver, true);
          document.body.removeEventListener('click', handleClick, true);
          if (scanInterval) clearInterval(scanInterval);
          scanInterval = null;
          currentHover = null;
          parent.postMessage({ type: 'inspector:clear' }, '*');
        }
      });
    })();
  `;

  // Inject the runtime script.
  const script = doc.createElement("script");
  script.textContent = scriptSource;
  doc.body?.appendChild(script);

  // Also inject the scanner function (so the inline script can call it).
  // We use eval-like approach because we need the function in the iframe's
  // scope, not the parent's.
  const scannerScript = doc.createElement("script");
  scannerScript.textContent = `
    window.__supaInspectorScan = ${scanDom.toString()};
  `;
  doc.body?.appendChild(scannerScript);
}

// ───────────────────────────────────────────────
// Parent-side message handler — converts inbound
// postMessage events to typed InspectorMessage values.
// ───────────────────────────────────────────────

export function isInspectorMessage(data: unknown): data is InspectorMessage {
  if (typeof data !== "object" || data === null) return false;
  const type = (data as { type?: string }).type;
  return (
    type === "inspector:tree" ||
    type === "inspector:hover" ||
    type === "inspector:select" ||
    type === "inspector:clear" ||
    type === "inspector:error"
  );
}

// ───────────────────────────────────────────────
// Helper: convert a SerializedComponentNode[] back to a flat list for the
// overlay's hover/select lookup.
// ───────────────────────────────────────────────

export function flattenTree(nodes: SerializedComponentNode[]): SerializedComponentNode[] {
  const flat: SerializedComponentNode[] = [];
  function visit(n: SerializedComponentNode) {
    flat.push(n);
    for (const c of n.children) visit(c);
  }
  for (const n of nodes) visit(n);
  return flat;
}
