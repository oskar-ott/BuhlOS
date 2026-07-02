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

// ─── #201: legend vocabulary ────────────────────────────────────────────────

export const LEGEND_CATEGORIES = [
  "Power",
  "Lighting",
  "Switch",
  "Data",
  "Comms",
  "Safety",
  "Mechanical",
  "EV",
  "Appliance",
  "Other",
] as const;
export type LegendCategory = (typeof LEGEND_CATEGORIES)[number];

export const LEGEND_STATUSES = [
  "suggested",
  "accepted",
  "edited",
  "rejected",
  "superseded",
] as const;
export type LegendStatus = (typeof LEGEND_STATUSES)[number];

const CropRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const LegendEntrySchema = z.object({
  id: z.string(),
  origin: z.enum(["ai", "human"]),
  status: z.enum(LEGEND_STATUSES),
  label: z.string(),
  effectiveLabel: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  symbolText: z.string().nullable(),
  symbolCropUrl: z.string().nullable(),
  cropRegion: CropRegionSchema.nullable(),
  sourcePlanId: z.string().nullable(),
  sourcePageIndex: z.number().int().nullable(),
  confidence: z.number().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewNote: z.string().nullable(),
});
export type LegendEntry = z.infer<typeof LegendEntrySchema>;

export const LegendListResponseSchema = z.object({
  entries: z.array(LegendEntrySchema),
  categories: z.array(z.string()),
  model: z.string(),
  promptVersion: z.string(),
});
export type LegendListResponse = z.infer<typeof LegendListResponseSchema>;

export const ExtractLegendResponseSchema = z.object({
  cached: z.boolean(),
  isLegendPresent: z.boolean(),
  extracted: z.number(),
  inserted: z.number(),
  duplicates: z.number(),
  rejectedSkipped: z.number(),
  notes: z.string().nullable(),
  entries: z.array(LegendEntrySchema),
  spend: z.object({ totalUsd: z.number(), capUsd: z.number() }).optional(),
});
export type ExtractLegendResponse = z.infer<typeof ExtractLegendResponseSchema>;

export const LegendEntryResponseSchema = z.object({
  entry: LegendEntrySchema.nullable(),
});
export type LegendEntryResponse = z.infer<typeof LegendEntryResponseSchema>;

// ─── #202/#207: schedule tables ─────────────────────────────────────────────

export const SCHEDULE_TABLE_KINDS = ["lighting", "switchboard"] as const;
export type ScheduleTableKind = (typeof SCHEDULE_TABLE_KINDS)[number];

export const SCHEDULE_KIND_LABELS: Record<ScheduleTableKind, string> = {
  lighting: "Lighting schedule",
  switchboard: "Switchboard schedule",
};

/** Human-facing labels for the canonical schedule columns. */
export const SCHEDULE_COLUMN_LABELS: Record<string, string> = {
  typeCode: "Type",
  description: "Description",
  manufacturer: "Manufacturer",
  model: "Model",
  lamp: "Lamp",
  wattage: "Wattage",
  qty: "Qty",
  circuitRef: "Circuit",
  protection: "Protection",
  cableSize: "Cable",
  phase: "Phase",
  load: "Load",
};

const ScheduleCellSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().nullable().optional(),
});

const EffectiveCellSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().nullable(),
  corrected: z.boolean(),
});
export type EffectiveCell = z.infer<typeof EffectiveCellSchema>;

export const ScheduleTableSchema = z.object({
  id: z.string(),
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  tableKind: z.enum(SCHEDULE_TABLE_KINDS),
  boardIdentifier: z.string().nullable(),
  region: CropRegionSchema.nullable(),
  headers: z.array(z.string()),
  columnMap: z.record(z.string(), z.string()),
  rowCount: z.number().int(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  createdAt: z.string(),
});
export type ScheduleTable = z.infer<typeof ScheduleTableSchema>;

export const ScheduleRowSchema = z.object({
  id: z.string(),
  tableId: z.string(),
  rowIndex: z.number().int(),
  cells: z.record(z.string(), ScheduleCellSchema),
  humanCells: z.record(z.string(), z.string().nullable()).nullable(),
  effective: z.record(z.string(), EffectiveCellSchema),
  rowRegion: CropRegionSchema.nullable(),
  status: z.enum(["suggested", "accepted", "edited", "rejected"]),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewNote: z.string().nullable(),
});
export type ScheduleRow = z.infer<typeof ScheduleRowSchema>;

export const SchedulesResponseSchema = z.object({
  tables: z.array(ScheduleTableSchema),
  rows: z.array(ScheduleRowSchema),
  columns: z.record(z.string(), z.array(z.string())),
  promptVersions: z.record(z.string(), z.string()),
});
export type SchedulesResponse = z.infer<typeof SchedulesResponseSchema>;

export const ExtractScheduleResponseSchema = z.object({
  cached: z.boolean(),
  isSchedulePresent: z.boolean(),
  notes: z.string().nullable(),
  tables: z.array(ScheduleTableSchema),
  rows: z.array(ScheduleRowSchema),
  spend: z.object({ totalUsd: z.number(), capUsd: z.number() }).optional(),
});
export type ExtractScheduleResponse = z.infer<typeof ExtractScheduleResponseSchema>;

export const ReviewScheduleRowResponseSchema = z.object({
  row: ScheduleRowSchema,
});
export type ReviewScheduleRowResponse = z.infer<typeof ReviewScheduleRowResponseSchema>;
