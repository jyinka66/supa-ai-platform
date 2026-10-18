import { z } from "zod";
import type { DesignDoc, LayerNode, Page, Color, Fill, Stroke, Gradient, GradientStop, Constraints, RichRun, AutoLayout, Rect, LayerBase } from "./types";

/**
 * Zod validators for the design document model.
 *
 * These schemas validate untrusted input (paste, import, AI-generated)
 * before it enters the document state. Every shape from an external source
 * is validated; shapes created by the editor itself are trusted (bypass
 * validation for performance).
 *
 * The schemas are the source of truth for the types in types.ts — if you
 * add a field to a type, add it to the schema too (and vice versa).
 */

// ============ PRIMITIVES ============

const ColorSchema = z.object({
  hex: z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
  opacity: z.number().min(0).max(1).optional(),
});

const GradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: ColorSchema,
});

const GradientSchema = z.object({
  kind: z.enum(["linear", "radial"]),
  stops: z.array(GradientStopSchema).min(2),
  angle: z.number().min(0).max(360).optional(),
});

const FillSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: ColorSchema }),
  z.object({ type: z.literal("gradient"), gradient: GradientSchema }),
]);

const StrokeSchema = z.object({
  color: ColorSchema,
  width: z.number().min(0).max(1000),
  align: z.enum(["inside", "center", "outside"]).optional(),
});

const ConstraintsSchema = z.object({
  horizontal: z.enum(["left", "right", "center", "scale"]).optional(),
  vertical: z.enum(["top", "bottom", "center", "scale"]).optional(),
});

const RichRunSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: ColorSchema.optional(),
  link: z.string().max(2000).optional(),
  fontFamily: z.string().max(100).optional(),
  fontSize: z.number().min(1).max(1000).optional(),
}).refine((r) => r.start <= r.end, { message: "run.start must be <= run.end" });

const AutoLayoutSchema = z.object({
  direction: z.enum(["horizontal", "vertical"]),
  gap: z.number().min(0).max(10000),
  padding: z.object({
    top: z.number().min(0),
    right: z.number().min(0),
    bottom: z.number().min(0),
    left: z.number().min(0),
  }),
  alignMain: z.enum(["start", "center", "end", "space-between"]),
  alignCross: z.enum(["start", "center", "end", "stretch"]),
  wrap: z.boolean().optional(),
});

const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0).max(100000),
  height: z.number().min(0).max(100000),
});

// ============ LAYER BASE ============

const LayerBaseSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  locked: z.boolean(),
  hidden: z.boolean(),
  rect: RectSchema,
  rotation: z.number().min(0).max(360),
  opacity: z.number().min(0).max(1),
  blend: z.string().min(1).max(50),
  constraints: ConstraintsSchema,
  children: z.lazy(() => z.array(LayerNodeSchema)).optional(),
});

// ============ LAYERS (discriminated union) ============

const LayerNodeSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    // group
    z.object({ ...LayerBaseSchema.shape, type: z.literal("group") }),
    // container
    z.object({
      ...LayerBaseSchema.shape,
      type: z.literal("container"),
      layout: AutoLayoutSchema,
      fill: FillSchema.optional(),
      cornerRadius: z.number().min(0).max(50000).optional(),
      clip: z.boolean(),
    }),
    // text
    z.object({
      ...LayerBaseSchema.shape,
      type: z.literal("text"),
      content: z.string().max(100000),
      runs: z.array(RichRunSchema),
      fontFamily: z.string().min(1).max(100),
      fontSize: z.number().min(1).max(1000),
      fontWeight: z.number().min(100).max(900),
      lineHeight: z.number().min(0.1).max(10),
      letterSpacing: z.object({
        value: z.number().min(-50).max(50),
        unit: z.enum(["px", "em", "%"]),
      }),
      align: z.enum(["left", "center", "right", "justify", "start", "end"]),
      direction: z.enum(["ltr", "rtl", "auto"]),
      autoResize: z.enum(["none", "width", "height", "both"]),
    }),
    // image
    z.object({
      ...LayerBaseSchema.shape,
      type: z.literal("image"),
      assetId: z.string().min(1).max(100),
      fit: z.enum(["cover", "contain", "fill"]),
      crop: RectSchema.optional(),
      filters: z.object({
        brightness: z.number().min(0).max(2).optional(),
        contrast: z.number().min(0).max(2).optional(),
        saturation: z.number().min(0).max(2).optional(),
        blur: z.number().min(0).max(100).optional(),
      }).optional(),
      altText: z.string().max(500),
    }),
    // shape
    z.object({
      ...LayerBaseSchema.shape,
      type: z.literal("shape"),
      shape: z.enum(["rect", "ellipse", "triangle", "polygon", "line"]),
      fill: FillSchema.optional(),
      stroke: StrokeSchema.optional(),
      cornerRadius: z.number().min(0).max(50000).optional(),
      polygonSides: z.number().int().min(3).max(12).optional(),
    }),
    // icon
    z.object({
      ...LayerBaseSchema.shape,
      type: z.literal("icon"),
      library: z.string().min(1).max(50),
      iconId: z.string().min(1).max(100),
      color: ColorSchema,
    }),
  ]),
) as unknown as z.ZodType<LayerNode>;

// ============ PAGE ============

const PageSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  size: z.object({
    width: z.number().min(1).max(100000),
    height: z.number().min(1).max(100000),
  }),
  background: z.union([FillSchema, z.literal("transparent")]),
  bleed: z.number().min(0).max(1000).optional(),
  layers: z.array(LayerNodeSchema),
}) as unknown as z.ZodType<Page>;

// ============ DESIGN DOC ============

export const DesignDocSchema = z.object({
  schemaVersion: z.number().int().min(1),
  id: z.string().min(1).max(100),
  kind: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  isTemplate: z.boolean(),
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  pages: z.array(PageSchema).min(1),
  assets: z.record(
    z.string(),
    z.object({
      kind: z.enum(["raster", "svg"]),
      ref: z.string().min(1).max(10000),
    }),
  ),
  a11y: z.object({ issues: z.array(z.string()) }),
  brandKitId: z.string().optional(),
}) as unknown as z.ZodType<DesignDoc>;

// ============ VALIDATION HELPERS ============

export function validateLayer(data: unknown): LayerNode {
  return LayerNodeSchema.parse(data);
}

export function safeValidateLayer(data: unknown): { success: true; data: LayerNode } | { success: false; error: z.ZodError } {
  return LayerNodeSchema.safeParse(data);
}

export function validateDoc(data: unknown): DesignDoc {
  return DesignDocSchema.parse(data);
}

export function safeValidateDoc(data: unknown): { success: true; data: DesignDoc } | { success: false; error: z.ZodError } {
  return DesignDocSchema.safeParse(data);
}

export function validatePage(data: unknown): Page {
  return PageSchema.parse(data);
}
