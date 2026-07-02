// Epic 5 (#197) — AI drawing page understanding: typed client contract.
//
// Mirrors api/ai-drawings.js responses. The server is the single source of
// truth for the effective merge (override > AI) and the needs-review
// derivation; the client only renders what it is given.

import { z } from "zod";

/** Fixed sheet-type vocabulary (#197 AC) — mirrors the API + DB CHECK. */
export const SHEET_TYPES = [
  "floorPlan",
  "schematic",
  "schedule",
  "legend",
  "titleCover",
  "detail",
  "other",
] as const;
export type SheetType = (typeof SHEET_TYPES)[number];

export const SHEET_TYPE_LABELS: Record<SheetType, string> = {
  floorPlan: "Floor plan",
  schematic: "Schematic",
  schedule: "Schedule",
  legend: "Legend",
  titleCover: "Title / cover",
  detail: "Detail",
  other: "Other",
};

/** The five override-able fields, exact spelling the API expects. */
export const SHEET_FIELDS = [
  "sheetType",
  "sheetNumber",
  "sheetTitle",
  "revision",
  "scale",
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

export const SHEET_FIELD_LABELS: Record<SheetField, string> = {
  sheetType: "Type",
  sheetNumber: "Sheet no.",
  sheetTitle: "Title",
  revision: "Rev",
  scale: "Scale",
};

const FieldStateSchema = z.object({
  ai: z
    .object({
      value: z.string().nullable(),
      confidence: z.number().nullable(),
    })
    .nullable(),
  override: z
    .object({
      value: z.string().nullable(),
      correctedBy: z.string(),
      correctedAt: z.string(),
    })
    .nullable(),
  effective: z.string().nullable(),
});
export type FieldState = z.infer<typeof FieldStateSchema>;

export const EffectiveSheetSchema = z.object({
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  updatedAt: z.string(),
  fields: z.object({
    sheetType: FieldStateSchema,
    sheetNumber: FieldStateSchema,
    sheetTitle: FieldStateSchema,
    revision: FieldStateSchema,
    scale: FieldStateSchema,
  }),
  needsReview: z.boolean(),
});
export type EffectiveSheet = z.infer<typeof EffectiveSheetSchema>;

const SpendSchema = z.object({
  totalUsd: z.number(),
  capUsd: z.number(),
});
export type SheetSpend = z.infer<typeof SpendSchema>;

export const SheetsResponseSchema = z.object({
  sheets: z.array(EffectiveSheetSchema),
  reviewThreshold: z.number(),
  model: z.string(),
  promptVersion: z.string(),
  spend: SpendSchema,
});
export type SheetsResponse = z.infer<typeof SheetsResponseSchema>;

export const UnderstandResponseSchema = z.object({
  cached: z.boolean(),
  sheet: EffectiveSheetSchema.nullable(),
  spend: SpendSchema.optional(),
});
export type UnderstandResponse = z.infer<typeof UnderstandResponseSchema>;

export const OverrideResponseSchema = z.object({
  sheet: EffectiveSheetSchema.nullable(),
});
export type OverrideResponse = z.infer<typeof OverrideResponseSchema>;

/** Normalised title-block crop region (0..1 page coordinates). */
export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const sheetKey = (planId: string, pageIndex: number) =>
  `${planId}:${pageIndex}`;
