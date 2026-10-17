/**
 * Tests for the DOM scanner + inspector overlay.
 *
 * jsdom doesn't fully implement getBoundingClientRect (returns zeros), but
 * we can verify the scanning + classification + serialization logic by
 * building a fake DOM with `data-component-name` attributes.
 *
 * The overlay component is tested for:
 *   - Toggle button renders + flips state on click.
 *   - Tree updates when a postMessage is received.
 *   - Selection panel appears when a select message arrives.
 *
 * The postMessage bridge is not actually tested end-to-end (would need
 * a real iframe with same-origin, which jsdom doesn't support). Phase 2
 * will add Playwright e2e tests for the full inspector flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import {
  scanDom,
  flattenTree,
  isInspectorMessage,
  type SerializedComponentNode,
} from "@/lib/supa-os/dom-scanner";
import { InspectorOverlay } from "@/components/supa-os/inspector-overlay";

// ───────────────────────────────────────────────
// scanDom — pure-function tests with a fake DOM.
// ───────────────────────────────────────────────

describe("scanDom", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns an empty array when no component boundaries exist", () => {
    const div = document.createElement("div");
    div.innerHTML = "<p>plain text</p><span>more text</span>";
    expect(scanDom(div)).toEqual([]);
  });

  it("detects a component with data-component-name", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-component-name="Card">
        <div data-component-name="Button">Click me</div>
      </div>
    `;
    const tree = scanDom(root);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("Card");
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.name).toBe("Button");
  });

  it("categorizes Button as 'form'", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-component-name="Button">OK</div>`;
    const tree = scanDom(root);
    expect(tree[0]!.category).toBe("form");
  });

  it("categorizes Card as 'display'", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-component-name="Card">…</div>`;
    expect(scanDom(root)[0]!.category).toBe("display");
  });

  it("categorizes Sidebar as 'navigation'", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-component-name="Sidebar">…</div>`;
    expect(scanDom(root)[0]!.category).toBe("navigation");
  });

  it("categorizes Toast as 'feedback'", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-component-name="Toast">…</div>`;
    expect(scanDom(root)[0]!.category).toBe("feedback");
  });

  it("falls back to semantic tags when no data-component-name", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button>Click</button>`;
    const tree = scanDom(root);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("Button");
  });

  it("reads filePath + lineNumber from data-source-* attributes", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-component-name="Card" data-source-path="/app/src/Card.tsx" data-source-line="42">
        …
      </div>
    `;
    const tree = scanDom(root);
    expect(tree[0]!.filePath).toBe("/app/src/Card.tsx");
    expect(tree[0]!.lineNumber).toBe(42);
  });

  it("extracts props from element attributes", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-component-name="Button" class="primary" disabled>
        Click me
      </div>
    `;
    const tree = scanDom(root);
    expect(tree[0]!.props.className).toBe("primary");
    expect(tree[0]!.props.disabled).toBe("");
    expect(tree[0]!.props.children).toContain("Click me");
  });

  it("tags elements with data-inspector-id for later hover/click lookup", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-component-name="Card">…</div>`;
    const tree = scanDom(root);
    const firstChild = root.firstElementChild as Element;
    expect(firstChild.getAttribute("data-inspector-id")).toBe(tree[0]!.id);
  });

  it("marks business logic blocks via data-business-logic attribute", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-component-name="LoanCalculator" data-business-logic>…</div>
    `;
    const tree = scanDom(root);
    expect(tree[0]!.isBusinessLogic).toBe(true);
  });

  it("skips script + style elements", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <script>alert('x')</script>
      <style>.x { color: red; }</style>
      <div data-component-name="Card">…</div>
    `;
    const tree = scanDom(root);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("Card");
  });

  it("handles nested component trees deeply", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-component-name="App">
        <div data-component-name="Layout">
          <div data-component-name="Sidebar">
            <div data-component-name="NavItem">Home</div>
            <div data-component-name="NavItem">About</div>
          </div>
          <div data-component-name="Main">
            <div data-component-name="Button">Save</div>
          </div>
        </div>
      </div>
    `;
    const tree = scanDom(root);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("App");
    expect(tree[0]!.children[0]!.name).toBe("Layout");
    expect(tree[0]!.children[0]!.children[0]!.name).toBe("Sidebar");
    expect(tree[0]!.children[0]!.children[0]!.children).toHaveLength(2);
    expect(tree[0]!.children[0]!.children[1]!.name).toBe("Main");
    expect(tree[0]!.children[0]!.children[1]!.children[0]!.name).toBe("Button");
  });
});

// ───────────────────────────────────────────────
// flattenTree — flat lookup helper.
// ───────────────────────────────────────────────

describe("flattenTree", () => {
  it("flattens a nested tree into a flat array", () => {
    const tree: SerializedComponentNode[] = [
      {
        id: "1", name: "App", category: "layout", filePath: null, lineNumber: null,
        props: {}, isBusinessLogic: false, rect: null,
        children: [
          {
            id: "2", name: "Button", category: "form", filePath: null, lineNumber: null,
            props: {}, isBusinessLogic: false, rect: null, children: [],
          },
        ],
      },
    ];
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(2);
    expect(flat[0]!.id).toBe("1");
    expect(flat[1]!.id).toBe("2");
  });
});

// ───────────────────────────────────────────────
// isInspectorMessage — type guard for postMessage events.
// ───────────────────────────────────────────────

describe("isInspectorMessage", () => {
  it("accepts known message types", () => {
    expect(isInspectorMessage({ type: "inspector:tree", tree: [] })).toBe(true);
    expect(isInspectorMessage({ type: "inspector:hover", nodeId: "abc" })).toBe(true);
    expect(isInspectorMessage({ type: "inspector:select", nodeId: "abc" })).toBe(true);
    expect(isInspectorMessage({ type: "inspector:clear" })).toBe(true);
    expect(isInspectorMessage({ type: "inspector:error", message: "boom" })).toBe(true);
  });

  it("rejects unknown types + non-object data", () => {
    expect(isInspectorMessage({ type: "unknown" })).toBe(false);
    expect(isInspectorMessage(null)).toBe(false);
    expect(isInspectorMessage("string")).toBe(false);
    expect(isInspectorMessage(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────
// InspectorOverlay component — render + interaction tests.
// ───────────────────────────────────────────────

describe("InspectorOverlay", () => {
  function renderOverlay() {
    const iframeRef = React.createRef<HTMLIFrameElement>();
    const onSelect = vi.fn();
    const onHover = vi.fn();
    const result = render(
      <div>
        <iframe ref={iframeRef} />
        <InspectorOverlay iframeRef={iframeRef as React.RefObject<HTMLIFrameElement>} onSelect={onSelect} onHover={onHover} />
      </div>,
    );
    return { ...result, onSelect, onHover };
  }

  it("renders a toggle button initially off", () => {
    renderOverlay();
    expect(screen.getByText(/Inspector off/)).toBeTruthy();
  });

  it("flips to 'on' when the button is clicked", () => {
    renderOverlay();
    const btn = screen.getByText(/Inspector off/);
    fireEvent.click(btn);
    expect(screen.getByText(/Inspector on/)).toBeTruthy();
  });

  it("shows the properties panel when a select message is received", async () => {
    renderOverlay();
    // Enable first.
    fireEvent.click(screen.getByText(/Inspector off/));

    // Simulate an inspector:tree + inspector:select message from the iframe.
    const sampleNode: SerializedComponentNode = {
      id: "node_1", name: "Button", category: "form",
      filePath: "/app/src/Button.tsx", lineNumber: 12,
      props: { className: "primary", children: "Save" },
      children: [], isBusinessLogic: false,
      rect: { x: 100, y: 200, width: 80, height: 32 },
    };

    window.postMessage({ type: "inspector:tree", tree: [sampleNode] }, "*");
    window.postMessage({ type: "inspector:select", nodeId: "node_1" }, "*");

    await waitFor(() => {
      expect(screen.getByText("Button")).toBeTruthy();
      expect(screen.getByText("/app/src/Button.tsx:12")).toBeTruthy();
    });
  });

  it("displays an error toast when an inspector:error message arrives", async () => {
    renderOverlay();
    fireEvent.click(screen.getByText(/Inspector off/));
    window.postMessage({ type: "inspector:error", message: "scanner crashed" }, "*");
    await waitFor(() => {
      expect(screen.getByText(/scanner crashed/)).toBeTruthy();
    });
  });
});
