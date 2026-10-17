// @supa/design-templates — template catalog + publish (Phase 6)
//
// Exports:
//   - types: DesignTemplate, Slot, Theme
//   - instantiate: create a doc from a template + slot values
//   - autofit: shrink-to-fit text within a slot's box
//   - publish: doc → template (extract slots, theme, validate)
//   - catalog: local-first template browser + search

export * from "./types";
export { instantiate, InstantiateError, type Bindings, type SlotBinding, type TextBinding, type ImageBinding, type ColorBinding } from "./instantiate";
export { autofit, wrapText, type AutofitResult } from "./autofit";
export { publish, republish, PublishError, type PublishInput, type PublishResult, type SlotCandidate } from "./publish";
export { InMemoryCatalogSource, searchCatalog, type CatalogSource, type TemplateMeta, type SearchResult } from "./catalog";
