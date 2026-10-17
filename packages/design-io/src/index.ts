// @supa/design-io — export/import pipeline (Phase 8)
//
// Export: PNG/JPEG/WebP (raster), PDF (vector+text), SVG (re-importable)
// Import: SVG → DesignDoc, PDF → DesignDoc, images (incl. HEIC/RAW)

export {
  exportDoc,
  exportSvg,
  type ExportSpec,
  type ExportProgress,
  type ExportResult,
  type ExportResultItem,
} from "./export";

export {
  importSvg,
  type ImportOptions,
  type ImportResult,
  type FidelityReport,
  type FidelityIssue,
} from "./import";

export {
  importPdf,
  type PdfImportOptions,
} from "./pdf-import";

export {
  importImage,
  createImageLayerFromImport,
  type ImageImportOptions,
  type ImageImportResult,
} from "./pdf-import";

export {
  PAGE_SIZE_PRESETS,
  DEFAULT_BLEED,
  mmToPx,
  pxToMm,
  mmToPt,
  extendBleed,
  generateTrimMarks,
  generateColorBar,
  renderPrintChrome,
  generatePreviewOverlay,
  renderPreviewOverlay,
  type PageSizePreset,
  type BleedConfig,
  type BleedExtensionResult,
  type TrimMarkLine,
  type PreviewOverlay,
} from "./print";
