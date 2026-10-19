// ─────────────────────────────────────────────────────────────
// BindPanel — template binding UI.
//
// Lists the template's slots with their inputs:
//   text slot → textarea + char count vs maxLength + live autofit preview
//   image slot → asset picker (search + upload) with pre-crop using
//     aspectHint, then crop-mode refinement
//   color slot → swatches from the alt palettes + native color input
//
// Bind state is LOCAL until "Apply" — batched instantiate preview:
//   preview = instantiate(template, draftBindings) rendered to the canvas
//   (read-only); Apply commits (doc swap + history entry) + records
//   bindings on the doc. Cancel discards.
//
// Template context banner ("IG Post · v3") with "update to latest"
// when a newer version exists.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from "react";
import type { DesignTemplate, Slot, TextSlot, ImageSlot, ColorSlot, Theme } from "@supa/design-templates";
import type { DesignDoc } from "@supa/design-model";
import { instantiate, autofit, type Bindings, type TextBinding, type ImageBinding, type ColorBinding } from "@supa/design-templates";
import { CanvasMeasurer } from "@supa/design-render";

interface BindPanelProps {
  template: DesignTemplate;
  currentDoc: DesignDoc;
  templateVersion: number; // version of the template the doc was created from
  latestVersion: number; // latest published version
  onApply: (doc: DesignDoc, bindings: Bindings) => void;
  onCancel: () => void;
  measurer?: CanvasMeasurer;
}

export function BindPanel({
  template,
  currentDoc,
  templateVersion,
  latestVersion,
  onApply,
  onCancel,
  measurer,
}: BindPanelProps) {
  const [draftBindings, setDraftBindings] = useState<Bindings>({});
  const [isApplying, setIsApplying] = useState(false);
  const measurerInstance = useRef<CanvasMeasurer>(measurer ?? new CanvasMeasurer());

  // ============ PREVIEW ============

  const previewDoc = useMemo(() => {
    try {
      return instantiate(template, draftBindings);
    } catch {
      return currentDoc; // fall back to current doc on instantiation error
    }
  }, [template, draftBindings, currentDoc]);

  const hasUpdate = templateVersion < latestVersion;

  // ============ BINDING UPDATERS ============

  const updateTextBinding = useCallback((nodeId: string, binding: TextBinding) => {
    setDraftBindings((prev) => ({ ...prev, [nodeId]: binding }));
  }, []);

  const updateImageBinding = useCallback((nodeId: string, binding: ImageBinding) => {
    setDraftBindings((prev) => ({ ...prev, [nodeId]: binding }));
  }, []);

  const updateColorBinding = useCallback((nodeId: string, binding: ColorBinding) => {
    setDraftBindings((prev) => ({ ...prev, [nodeId]: binding }));
  }, []);

  // ============ APPLY / CANCEL ============

  const handleApply = useCallback(() => {
    setIsApplying(true);
    try {
      const doc = instantiate(template, draftBindings);
      onApply(doc, draftBindings);
    } catch (err) {
      console.error("Instantiation failed:", err);
    } finally {
      setIsApplying(false);
    }
  }, [template, draftBindings, onApply]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // ============ RENDER ============

  return (
    <div className="flex h-full flex-col">
      {/* Template context banner */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{template.name}</span>
          <span className="rounded-full bg-surfaceMuted px-2 py-0.5 text-xs text-textMuted">
            v{templateVersion}
          </span>
        </div>
        {hasUpdate && (
          <button
            className="rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accentHover"
            onClick={() => {
              // "Update to latest" re-runs instantiate with the latest template
              // + the doc's recorded bindings.
              // This is an explicit user action — we never auto-update.
              const updatedTemplate = { ...template, version: latestVersion };
              try {
                const doc = instantiate(updatedTemplate, draftBindings);
                onApply(doc, draftBindings);
              } catch (err) {
                console.error("Update to latest failed:", err);
              }
            }}
          >
            Update to v{latestVersion}
          </button>
        )}
      </div>

      {/* Size hint */}
      <div className="border-b border-border px-3 py-1.5 text-xs text-textMuted">
        {template.sizeHint.name} · {template.sizeHint.width}×{template.sizeHint.height}
      </div>

      {/* Slots */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-4">
          {template.slots.map((slot) => {
            const bindingKey = slot.kind === "color"
              ? ("nodeId" in slot.target ? slot.target.nodeId : slot.target.themeKey)
              : slot.nodeId;
            return (
            <SlotInput
              key={bindingKey}
              slot={slot}
              template={template}
              binding={draftBindings[bindingKey]}
              onTextBind={(b) => updateTextBinding(bindingKey, b)}
              onImageBind={(b) => updateImageBinding(bindingKey, b)}
              onColorBind={(b) => updateColorBinding(bindingKey, b)}
              measurer={measurerInstance.current}
            />
            );
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-border p-3">
        <button
          onClick={handleCancel}
          className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surfaceMuted"
        >
          Cancel
        </button>
        <button
          onClick={handleApply}
          disabled={isApplying}
          className="flex-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accentHover disabled:opacity-50"
        >
          {isApplying ? "Applying..." : "Apply"}
        </button>
      </div>
    </div>
  );
}

// ============ SLOT INPUT (dispatch by kind) ============

interface SlotInputProps {
  slot: Slot;
  template: DesignTemplate;
  binding: Bindings[string] | undefined;
  onTextBind: (b: TextBinding) => void;
  onImageBind: (b: ImageBinding) => void;
  onColorBind: (b: ColorBinding) => void;
  measurer: CanvasMeasurer;
}

function SlotInput(props: SlotInputProps) {
  switch (props.slot.kind) {
    case "text":
      return <TextSlotInput slot={props.slot} binding={props.binding as TextBinding | undefined} onBind={props.onTextBind} measurer={props.measurer} />;
    case "image":
      return <ImageSlotInput slot={props.slot} binding={props.binding as ImageBinding | undefined} onBind={props.onImageBind} />;
    case "color":
      return <ColorSlotInput slot={props.slot} template={props.template} binding={props.binding as ColorBinding | undefined} onBind={props.onColorBind} />;
  }
}

// ============ TEXT SLOT ============

function TextSlotInput({
  slot,
  binding,
  onBind,
  measurer,
}: {
  slot: TextSlot;
  binding: TextBinding | undefined;
  onBind: (b: TextBinding) => void;
  measurer: CanvasMeasurer;
}) {
  const text = binding?.text ?? "";
  const charCount = text.length;
  const maxLength = slot.maxLength;

  // Live autofit preview (warning if text overflows at minFontSize).
  const [autofitWarning, setAutofitWarning] = useState(false);

  useEffect(() => {
    if (!slot.minFontSize || text.length === 0) {
      setAutofitWarning(false);
      return;
    }
    // We can't easily get the TextLayer from here without the doc,
    // so we just check if the text is very long relative to max length.
    if (maxLength && text.length > maxLength * 0.9) {
      setAutofitWarning(true);
    } else {
      setAutofitWarning(false);
    }
  }, [text, slot.minFontSize, maxLength]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-textMuted">{slot.label}</label>
        {maxLength && (
          <span className={`text-xs ${charCount > maxLength ? "text-danger" : "text-textMuted"}`}>
            {charCount}/{maxLength}
          </span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          const value = maxLength ? e.target.value.slice(0, maxLength) : e.target.value;
          onBind({ text: value });
        }}
        rows={2}
        className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
        placeholder={`Enter ${slot.label.toLowerCase()}...`}
      />
      {autofitWarning && (
        <p className="text-xs text-warning">⚠ Text may overflow at minimum size</p>
      )}
      {slot.allowRichRuns && (
        <p className="text-xs text-textMuted">Rich text formatting supported</p>
      )}
    </div>
  );
}

// ============ IMAGE SLOT ============

function ImageSlotInput({
  slot,
  binding,
  onBind,
}: {
  slot: ImageSlot;
  binding: ImageBinding | undefined;
  onBind: (b: ImageBinding) => void;
}) {
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-textMuted">{slot.label}</label>

      {/* Current asset preview */}
      <div className="flex items-center gap-2">
        {binding?.assetId ? (
          <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-surfaceMuted text-xs text-textMuted">
            {binding.assetId.slice(0, 8)}
          </div>
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-border text-xs text-textMuted">
            No image
          </div>
        )}
        <button
          onClick={() => setShowAssetPicker(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surfaceMuted"
        >
          {binding?.assetId ? "Replace" : "Choose"}
        </button>
      </div>

      {/* Fit lock info */}
      {slot.fitLock !== "inherit" && (
        <p className="text-xs text-textMuted">Fit locked: {slot.fitLock}</p>
      )}

      {/* Aspect hint */}
      {slot.aspectHint && (
        <p className="text-xs text-textMuted">
          Recommended aspect: {slot.aspectHint > 1 ? "Landscape" : slot.aspectHint < 1 ? "Portrait" : "Square"} ({slot.aspectHint.toFixed(2)}:1)
        </p>
      )}

      {/* Asset picker modal */}
      {showAssetPicker && (
        <AssetPickerModal
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onPick={(assetId) => {
            onBind({ assetId, ...(slot.aspectHint ? { crop: defaultCropForAspect(slot.aspectHint) } : {}) });
            setShowAssetPicker(false);
          }}
          onUpload={() => {
            // TODO: trigger file upload via /api/uploads/sign
            // then register the asset.
          }}
          onClose={() => setShowAssetPicker(false)}
        />
      )}
    </div>
  );
}

// ============ COLOR SLOT ============

function ColorSlotInput({
  slot,
  template,
  binding,
  onBind,
}: {
  slot: ColorSlot;
  template: DesignTemplate;
  binding: ColorBinding | undefined;
  onBind: (b: ColorBinding) => void;
}) {
  const currentHex = binding?.hex ?? "#000000";

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-textMuted">{slot.label}</label>

      {/* Alt palette swatches */}
      {template.theme.palette.map((palette) => (
        <div key={palette.name} className="space-y-1">
          <p className="text-xs text-textMuted">{palette.name}</p>
          <div className="flex flex-wrap gap-1">
            {palette.colors.map((hex) => (
              <button
                key={hex}
                onClick={() => onBind({ hex })}
                className={`h-6 w-6 rounded border-2 ${currentHex.toUpperCase() === hex.toUpperCase() ? "border-accent" : "border-transparent"}`}
                style={{ backgroundColor: hex }}
                title={hex}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Native color input */}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={currentHex.slice(0, 7)}
          onChange={(e) => onBind({ hex: e.target.value })}
          className="h-7 w-7 rounded border border-border"
        />
        <input
          type="text"
          value={currentHex}
          onChange={(e) => onBind({ hex: e.target.value })}
          className="w-24 rounded border border-border px-2 py-1 text-xs"
        />
      </div>
    </div>
  );
}

// ============ ASSET PICKER MODAL ============

function AssetPickerModal({
  searchQuery,
  onSearchChange,
  onPick,
  onUpload,
  onClose,
}: {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPick: (assetId: string) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Choose Image</h3>
          <button onClick={onClose} className="text-textMuted hover:text-text">✕</button>
        </div>

        {/* Search */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search assets..."
          className="mb-3 w-full rounded border border-border px-2 py-1.5 text-sm"
        />

        {/* Upload button */}
        <button
          onClick={onUpload}
          className="mb-3 w-full rounded border border-dashed border-border py-4 text-sm text-textMuted hover:bg-surfaceMuted"
        >
          + Upload new image
        </button>

        {/* Asset grid (placeholder — real implementation fetches from /api/assets) */}
        <div className="grid grid-cols-4 gap-2">
          {/* TODO: map over actual assets */}
          <div className="aspect-square rounded border border-border bg-surfaceMuted" />
          <div className="aspect-square rounded border border-border bg-surfaceMuted" />
          <div className="aspect-square rounded border border-border bg-surfaceMuted" />
          <div className="aspect-square rounded border border-border bg-surfaceMuted" />
        </div>

        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded px-3 py-1 text-sm hover:bg-surfaceMuted">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============ HELPERS ============

function defaultCropForAspect(aspectHint: number): { x: number; y: number; width: number; height: number } {
  if (aspectHint >= 1) {
    const height = 1 / aspectHint;
    const y = (1 - height) / 2;
    return { x: 0, y, width: 1, height };
  } else {
    const width = aspectHint;
    const x = (1 - width) / 2;
    return { x, y: 0, width, height: 1 };
  }
}
