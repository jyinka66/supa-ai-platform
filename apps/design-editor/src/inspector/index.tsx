// ─────────────────────────────────────────────────────────────
// Inspector — right panel.
//
// Sections render per selection composition:
//   - single text layer: font family (catalog, lazy-loaded faces),
//     size, weight, color, align, line-height, letter-spacing, opacity
//   - image: fit (cover/contain/fill), crop button, replace (asset
//     picker), corner radius
//   - shape: fill/stroke, corner radius, opacity
//   - multi-select: aligned buttons (align-left/center/right/top/middle/
//     bottom + distribute-h/v), combined opacity
//   - page: background, size presets
//
// Every input is CONTROLLED BY THE STORE, not local state:
//   onChange → apply(op, { ephemeral: true }) for continuous inputs
//   (sliders, number scrubbing, color gradient drag) with 300ms idle
//   → endTransaction(); discrete inputs (select, toggle) apply directly.
// ─────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { EditorStore } from "../store";
import type { LayerNode, TextLayer, ImageLayer, ShapeLayer, Page, DesignDoc, Color, Fill } from "@supa/design-model";
import { findLayerById, findPage } from "@supa/design-model";

// ============ SHARED PRIMITIVES ============

interface InspectorProps {
  store: EditorStore;
}

export function Inspector({ store }: InspectorProps) {
  const state = useEditorState(store);
  const page = state.doc.pages.find((p) => p.id === state.pageId);

  if (!page) return <div className="p-4 text-sm text-textMuted">No page</div>;

  if (state.selection.length === 0) {
    return <PageInspector store={store} page={page} />;
  }

  if (state.selection.length === 1) {
    const node = findLayerById(page, state.selection[0]!);
    if (!node) return <div className="p-4 text-sm text-textMuted">Node not found</div>;
    return <SingleNodeInspector store={store} node={node} pageId={state.pageId} />;
  }

  return <MultiSelectInspector store={store} selection={state.selection} pageId={state.pageId} />;
}

// ============ SINGLE NODE INSPECTOR ============

function SingleNodeInspector({
  store,
  node,
  pageId,
}: {
  store: EditorStore;
  node: LayerNode;
  pageId: string;
}) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3 text-sm">
      <Section title="Layer">
        <Field label="Name">
          <TextInput
            value={node.name}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { name: v } })}
          />
        </Field>
        <Field label="Opacity">
          <SliderInput
            value={node.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { opacity: v } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
        <Field label="Visible">
          <Toggle
            checked={!node.hidden}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { hidden: !v } })}
          />
        </Field>
        <Field label="Locked">
          <Toggle
            checked={node.locked}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { locked: v } })}
          />
        </Field>
      </Section>

      <PositionSection store={store} node={node} pageId={pageId} />

      {node.type === "text" && <TextSection store={store} node={node as TextLayer} pageId={pageId} />}
      {node.type === "image" && <ImageSection store={store} node={node as ImageLayer} pageId={pageId} />}
      {node.type === "shape" && <ShapeSection store={store} node={node as ShapeLayer} pageId={pageId} />}
    </div>
  );
}

// ============ TEXT SECTION ============

function TextSection({ store, node, pageId }: { store: EditorStore; node: TextLayer; pageId: string }) {
  return (
    <Section title="Text">
      <Field label="Font">
        <SelectInput
          value={node.fontFamily}
          options={["Inter", "Roboto", "Noto Sans", "Noto Sans Arabic", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC"]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { fontFamily: v } })}
        />
      </Field>
      <Field label="Size">
        <DragNumber
          value={node.fontSize}
          min={6}
          max={512}
          suffix="px"
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { fontSize: v } }, { ephemeral: true })}
          onCommit={() => store.endTransaction()}
        />
      </Field>
      <Field label="Weight">
        <SelectInput
          value={String(node.fontWeight)}
          options={["100", "200", "300", "400", "500", "600", "700", "800", "900"]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { fontWeight: parseInt(v, 10) } })}
        />
      </Field>
      <Field label="Align">
        <ButtonGroup
          value={node.align}
          options={[
            { value: "left", label: "L" },
            { value: "center", label: "C" },
            { value: "right", label: "R" },
            { value: "justify", label: "J" },
          ]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { align: v as TextLayer["align"] } })}
        />
      </Field>
      <Field label="Line H">
        <DragNumber
          value={node.lineHeight}
          min={0.5}
          max={10}
          step={0.1}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { lineHeight: v } }, { ephemeral: true })}
          onCommit={() => store.endTransaction()}
        />
      </Field>
      <Field label="Tracking">
        <DragNumber
          value={node.letterSpacing.value}
          min={-50}
          max={50}
          suffix={node.letterSpacing.unit}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { letterSpacing: { ...node.letterSpacing, value: v } } }, { ephemeral: true })}
          onCommit={() => store.endTransaction()}
        />
      </Field>
      <Field label="Direction">
        <ButtonGroup
          value={node.direction}
          options={[
            { value: "ltr", label: "LTR" },
            { value: "rtl", label: "RTL" },
            { value: "auto", label: "Auto" },
          ]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { direction: v as TextLayer["direction"] } })}
        />
      </Field>
    </Section>
  );
}

// ============ IMAGE SECTION ============

function ImageSection({ store, node, pageId }: { store: EditorStore; node: ImageLayer; pageId: string }) {
  return (
    <Section title="Image">
      <Field label="Fit">
        <ButtonGroup
          value={node.fit}
          options={[
            { value: "cover", label: "Cover" },
            { value: "contain", label: "Contain" },
            { value: "fill", label: "Fill" },
          ]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { fit: v as ImageLayer["fit"] } })}
        />
      </Field>
      <Field label="Alt text">
        <TextInput
          value={node.altText}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { altText: v } })}
        />
      </Field>
      {node.filters && (
        <Field label="Brightness">
          <SliderInput
            value={node.filters.brightness ?? 1}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { filters: { ...node.filters, brightness: v } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      )}
    </Section>
  );
}

// ============ SHAPE SECTION ============

function ShapeSection({ store, node, pageId }: { store: EditorStore; node: ShapeLayer; pageId: string }) {
  return (
    <Section title="Shape">
      <Field label="Shape">
        <SelectInput
          value={node.shape}
          options={["rect", "ellipse", "triangle", "polygon", "line"]}
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { shape: v as ShapeLayer["shape"] } })}
        />
      </Field>
      {node.fill && (
        <Field label="Fill">
          <ColorInput
            color={node.fill.type === "solid" ? node.fill.color : { hex: "#000000" }}
            onChange={(c) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { fill: { type: "solid", color: c } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      )}
      {node.stroke && (
        <Field label="Stroke">
          <ColorInput
            color={node.stroke.color}
            onChange={(c) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { stroke: { ...node.stroke, color: c } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      )}
      {node.shape === "rect" && (
        <Field label="Radius">
          <DragNumber
            value={node.cornerRadius ?? 0}
            min={0}
            max={50000}
            suffix="px"
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { cornerRadius: v } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      )}
      {node.shape === "polygon" && (
        <Field label="Sides">
          <DragNumber
            value={node.polygonSides ?? 6}
            min={3}
            max={12}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { polygonSides: v } })}
          />
        </Field>
      )}
    </Section>
  );
}

// ============ POSITION SECTION ============

function PositionSection({ store, node, pageId }: { store: EditorStore; node: LayerNode; pageId: string }) {
  return (
    <Section title="Position">
      <div className="grid grid-cols-2 gap-2">
        <Field label="X">
          <DragNumber
            value={node.rect.x}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect: { ...node.rect, x: v } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
        <Field label="Y">
          <DragNumber
            value={node.rect.y}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect: { ...node.rect, y: v } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
        <Field label="W">
          <DragNumber
            value={node.rect.width}
            min={1}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect: { ...node.rect, width: v } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
        <Field label="H">
          <DragNumber
            value={node.rect.height}
            min={1}
            onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect: { ...node.rect, height: v } } }, { ephemeral: true })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      </div>
      <Field label="Rotation">
        <DragNumber
          value={node.rotation}
          min={0}
          max={360}
          suffix="°"
          onChange={(v) => store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rotation: v } }, { ephemeral: true })}
          onCommit={() => store.endTransaction()}
        />
      </Field>
    </Section>
  );
}

// ============ MULTI-SELECT INSPECTOR ============

function MultiSelectInspector({
  store,
  selection,
  pageId,
}: {
  store: EditorStore;
  selection: string[];
  pageId: string;
}) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3 text-sm">
      <Section title={`${selection.length} layers selected`}>
        <Field label="Align">
          <div className="grid grid-cols-6 gap-1">
            <IconButton label="L" title="Align left" onClick={() => alignNodes(store, selection, pageId, "left")} />
            <IconButton label="C" title="Align center H" onClick={() => alignNodes(store, selection, pageId, "centerH")} />
            <IconButton label="R" title="Align right" onClick={() => alignNodes(store, selection, pageId, "right")} />
            <IconButton label="T" title="Align top" onClick={() => alignNodes(store, selection, pageId, "top")} />
            <IconButton label="M" title="Align middle V" onClick={() => alignNodes(store, selection, pageId, "middleV")} />
            <IconButton label="B" title="Align bottom" onClick={() => alignNodes(store, selection, pageId, "bottom")} />
          </div>
        </Field>
        <Field label="Distribute">
          <div className="grid grid-cols-2 gap-1">
            <IconButton label="H" title="Distribute horizontally" onClick={() => distributeNodes(store, selection, pageId, "horizontal")} />
            <IconButton label="V" title="Distribute vertically" onClick={() => distributeNodes(store, selection, pageId, "vertical")} />
          </div>
        </Field>
      </Section>
    </div>
  );
}

// ============ PAGE INSPECTOR ============

function PageInspector({ store, page }: { store: EditorStore; page: Page }) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3 text-sm">
      <Section title="Page">
        <Field label="Name">
          <TextInput value={page.name} onChange={() => { /* TODO: page rename command */ }} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <DragNumber value={page.size.width} min={1} onChange={() => {}} onCommit={() => {}} />
          </Field>
          <Field label="Height">
            <DragNumber value={page.size.height} min={1} onChange={() => {}} onCommit={() => {}} />
          </Field>
        </div>
        <Field label="Background">
          <ColorInput
            color={page.background === "transparent" ? { hex: "#ffffff" } : (page.background as { type: "solid"; color: Color }).color}
            onChange={(c) => store.apply({ op: "SET_PAGE_BG", pageId: page.id, background: { type: "solid", color: c } })}
            onCommit={() => store.endTransaction()}
          />
        </Field>
      </Section>
      <Section title="Size Presets">
        <div className="grid grid-cols-2 gap-1">
          {SIZE_PRESETS.map((preset) => (
            <button
              key={preset.name}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-surfaceMuted"
              onClick={() => {
                /* TODO: resize page command */
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

const SIZE_PRESETS = [
  { name: "1080²", width: 1080, height: 1080 },
  { name: "Story", width: 1080, height: 1920 },
  { name: "A4", width: 2480, height: 3508 },
  { name: "HD", width: 1920, height: 1080 },
];

// ============ ALIGN/DISTRIBUTE ============

function alignNodes(store: EditorStore, selection: string[], pageId: string, mode: string) {
  store.beginBatch("align");
  const state = store.get();
  const page = state.doc.pages.find((p) => p.id === pageId);
  if (!page) return;

  const nodes = selection.map((id) => findLayerById(page, id)).filter(Boolean) as LayerNode[];
  if (nodes.length < 2) return;

  // Compute bounding box.
  const minX = Math.min(...nodes.map((n) => n.rect.x));
  const maxX = Math.max(...nodes.map((n) => n.rect.x + n.rect.width));
  const minY = Math.min(...nodes.map((n) => n.rect.y));
  const maxY = Math.max(...nodes.map((n) => n.rect.y + n.rect.height));

  for (const node of nodes) {
    let x = node.rect.x;
    let y = node.rect.y;
    switch (mode) {
      case "left": x = minX; break;
      case "centerH": x = (minX + maxX) / 2 - node.rect.width / 2; break;
      case "right": x = maxX - node.rect.width; break;
      case "top": y = minY; break;
      case "middleV": y = (minY + maxY) / 2 - node.rect.height / 2; break;
      case "bottom": y = maxY - node.rect.height; break;
    }
    store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect: { ...node.rect, x, y } } });
  }
  store.endBatch();
}

function distributeNodes(store: EditorStore, selection: string[], pageId: string, mode: "horizontal" | "vertical") {
  store.beginBatch("distribute");
  const state = store.get();
  const page = state.doc.pages.find((p) => p.id === pageId);
  if (!page) return;

  const nodes = selection.map((id) => findLayerById(page, id)).filter(Boolean) as LayerNode[];
  if (nodes.length < 3) return;

  // Sort by position.
  nodes.sort((a, b) => mode === "horizontal" ? a.rect.x - b.rect.x : a.rect.y - b.rect.y);

  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const totalSpan = mode === "horizontal"
    ? last.rect.x + last.rect.width - first.rect.x
    : last.rect.y + last.rect.height - first.rect.y;
  const totalSize = nodes.reduce((sum, n) => sum + (mode === "horizontal" ? n.rect.width : n.rect.height), 0);
  const gap = (totalSpan - totalSize) / (nodes.length - 1);

  let pos = mode === "horizontal" ? first.rect.x : first.rect.y;
  for (const node of nodes) {
    const rect = mode === "horizontal"
      ? { ...node.rect, x: pos }
      : { ...node.rect, y: pos };
    store.apply({ op: "UPDATE_PROPS", pageId, id: node.id, props: { rect } });
    pos += (mode === "horizontal" ? node.rect.width : node.rect.height) + gap;
  }
  store.endBatch();
}

// ============ UI PRIMITIVES ============

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-textMuted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="w-20 shrink-0 text-xs text-textMuted">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-border px-2 py-1 text-sm" />;
}

function SelectInput({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-border px-2 py-1 text-sm">{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

function ButtonGroup({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`flex-1 rounded px-2 py-1 text-xs ${value === o.value ? "bg-accent text-white" : "border border-border"}`}>{o.label}</button>
      ))}
    </div>
  );
}

function IconButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return <button title={title} onClick={onClick} className="rounded border border-border px-2 py-1 text-xs hover:bg-surfaceMuted">{label}</button>;
}

function SliderInput({ value, min, max, step, onChange, onCommit, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; onCommit: () => void; format?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(parseFloat(e.target.value))} onMouseUp={onCommit} className="flex-1" />
      <span className="w-12 text-xs text-textMuted">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  );
}

function DragNumber({ value, min, max, step, suffix, onChange, onCommit }: { value: number; min?: number; max?: number; step?: number; suffix?: string; onChange: (v: number) => void; onCommit?: () => void }) {
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startValue: value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const newVal = dragRef.current.startValue + dx * (step ?? 1);
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, newVal));
    onChange(clamped);
    clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => onCommit?.(), 300);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    clearTimeout(idleRef.current);
    onCommit?.();
  };

  return (
    <div className="flex items-center gap-1">
      <span
        className="cursor-ew-resize select-none text-xs text-textMuted"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        ⇄
      </span>
      <input
        type="number"
        value={Math.round(value * 100) / 100}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        onBlur={onCommit}
        className="w-full rounded border border-border px-2 py-1 text-sm"
      />
      {suffix && <span className="text-xs text-textMuted">{suffix}</span>}
    </div>
  );
}

function ColorInput({ color, onChange, onCommit }: { color: Color; onChange: (c: Color) => void; onCommit: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={color.hex.slice(0, 7)}
        onChange={(e) => onChange({ ...color, hex: e.target.value })}
        onBlur={onCommit}
        className="h-7 w-7 rounded border border-border"
      />
      <input
        type="text"
        value={color.hex}
        onChange={(e) => onChange({ ...color, hex: e.target.value })}
        onBlur={onCommit}
        className="w-20 rounded border border-border px-2 py-1 text-xs"
      />
      {color.opacity !== undefined && (
        <input
          type="number"
          value={Math.round(color.opacity * 100)}
          min={0}
          max={100}
          onChange={(e) => onChange({ ...color, opacity: parseFloat(e.target.value) / 100 })}
          onBlur={onCommit}
          className="w-12 rounded border border-border px-1 py-1 text-xs"
        />
      )}
    </div>
  );
}

// ============ HOOK ============

function useEditorState(store: EditorStore) {
  return useSyncExternalStore(store.subscribe, store.get);
}
import { useSyncExternalStore } from "react";
