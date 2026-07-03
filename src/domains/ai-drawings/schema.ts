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

// ─── #203: revision diffs ───────────────────────────────────────────────────

export const PageDiffSchema = z.object({
  id: z.string(),
  basePlanId: z.string(),
  basePageIndex: z.number().int(),
  basePageSha256: z.string(),
  headPlanId: z.string(),
  headPageIndex: z.number().int(),
  headPageSha256: z.string(),
  algoVersion: z.string(),
  identical: z.boolean(),
  alignment: z
    .object({ dx: z.number(), dy: z.number(), quality: z.number() })
    .nullable(),
  /** The diff's honesty payload — threshold, mask, algo knobs. */
  basis: z.record(z.string(), z.unknown()),
  regionCount: z.number().int(),
  createdAt: z.string(),
});
export type PageDiff = z.infer<typeof PageDiffSchema>;

export const DiffRegionSchema = z.object({
  id: z.string(),
  diffId: z.string(),
  regionIndex: z.number().int(),
  bbox: CropRegionSchema,
  areaCells: z.number().int().nullable(),
  status: z.enum(["pending", "reviewed", "dismissed"]),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewNote: z.string().nullable(),
});
export type DiffRegion = z.infer<typeof DiffRegionSchema>;

export const DiffsResponseSchema = z.object({
  diffs: z.array(PageDiffSchema),
  regions: z.array(DiffRegionSchema),
  algoVersion: z.string(),
});
export type DiffsResponse = z.infer<typeof DiffsResponseSchema>;

export const DiffPagesResponseSchema = z.object({
  cached: z.boolean(),
  diff: PageDiffSchema,
  regions: z.array(DiffRegionSchema),
});
export type DiffPagesResponse = z.infer<typeof DiffPagesResponseSchema>;

export const ReviewDiffRegionResponseSchema = z.object({
  region: DiffRegionSchema,
});
export type ReviewDiffRegionResponse = z.infer<typeof ReviewDiffRegionResponseSchema>;

// ─── #204: device detection ─────────────────────────────────────────────────

export const DeviceDetectionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  kind: z.enum(["device", "uncertain-region"]),
  legendEntryId: z.string().nullable(),
  label: z.string().nullable(),
  bbox: CropRegionSchema,
  confidence: z.number().nullable(),
  note: z.string().nullable(),
  runId: z.string(),
  createdAt: z.string(),
});
export type DeviceDetection = z.infer<typeof DeviceDetectionSchema>;

export const DetectionsResponseSchema = z.object({
  detections: z.array(DeviceDetectionSchema),
  promptVersion: z.string(),
  model: z.string(),
});
export type DetectionsResponse = z.infer<typeof DetectionsResponseSchema>;

export const DetectDevicesResponseSchema = z.object({
  cached: z.boolean(),
  inserted: z.number().int(),
  seamDuplicates: z.number().int(),
  offVocabulary: z.number().int(),
  detections: z.array(DeviceDetectionSchema),
  spend: z.object({ totalUsd: z.number(), capUsd: z.number() }).optional(),
});
export type DetectDevicesResponse = z.infer<typeof DetectDevicesResponseSchema>;

/** The overlapping 2×2 tiling used for detection (12% seam overlap). */
export const DETECTION_TILES: readonly CropRegion[] = [
  { x: 0, y: 0, w: 0.56, h: 0.56 },
  { x: 0.44, y: 0, w: 0.56, h: 0.56 },
  { x: 0, y: 0.44, w: 0.56, h: 0.56 },
  { x: 0.44, y: 0.44, w: 0.56, h: 0.56 },
];

// ─── #205: count review ──────────────────────────────────────────────────────

export const EffectiveMarkerSchema = z.object({
  key: z.string(), // 'd:<detectionId>' | 'r:<add reviewId>' — the identity accepts snapshot
  source: z.enum(["ai", "human"]),
  detectionId: z.string().nullable(),
  reviewId: z.string().nullable(),
  bbox: CropRegionSchema,
  legendEntryId: z.string().nullable(),
  label: z.string().nullable(),
  confidence: z.number().nullable(),
  status: z.enum(["live", "deleted"]),
  appliedReviewIds: z.array(z.string()),
});
export type EffectiveMarker = z.infer<typeof EffectiveMarkerSchema>;

export const ReviewActionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  action: z.enum(["delete", "restore", "reclassify", "add"]),
  targetDetectionId: z.string().nullable(),
  targetReviewId: z.string().nullable(),
  legendEntryId: z.string().nullable(),
  label: z.string().nullable(),
  bbox: CropRegionSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

export const AcceptedCountSchema = z.object({
  id: z.string(),
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  legendEntryId: z.string(),
  label: z.string(),
  count: z.number().int(),
  basis: z.object({
    markerKeys: z.array(z.string()),
    markers: z.array(
      z.object({
        key: z.string(),
        source: z.enum(["ai", "human"]),
        bbox: CropRegionSchema,
        label: z.string().nullable(),
        confidence: z.number().nullable().optional(),
      }),
    ),
    reviewIds: z.array(z.string()),
  }),
  acceptedAt: z.string(),
  acceptedBy: z.string().nullable(),
  /** True when corrections (or a page re-render) happened after the sign-off. */
  stale: z.boolean(),
});
export type AcceptedCount = z.infer<typeof AcceptedCountSchema>;

export const CountRowSchema = z.object({
  legendEntryId: z.string().nullable(),
  label: z.string().nullable(),
  liveCount: z.number().int(),
  removedCount: z.number().int(),
  addedCount: z.number().int(),
  accepted: AcceptedCountSchema.nullable(),
});
export type CountRow = z.infer<typeof CountRowSchema>;

export const CountReviewPageSchema = z.object({
  planId: z.string(),
  pageIndex: z.number().int(),
  pageSha256: z.string(),
  markers: z.array(EffectiveMarkerSchema),
  uncertain: z.array(DeviceDetectionSchema),
  counts: z.array(CountRowSchema),
});
export type CountReviewPage = z.infer<typeof CountReviewPageSchema>;

export const CountReviewResponseSchema = z.object({
  pages: z.array(CountReviewPageSchema),
});
export type CountReviewResponse = z.infer<typeof CountReviewResponseSchema>;

export const ReviewMarkerResponseSchema = z.object({
  review: ReviewActionSchema,
  page: CountReviewPageSchema,
});
export type ReviewMarkerResponse = z.infer<typeof ReviewMarkerResponseSchema>;

export const AcceptCountResponseSchema = z.object({
  accepted: AcceptedCountSchema,
  page: CountReviewPageSchema,
});
export type AcceptCountResponse = z.infer<typeof AcceptCountResponseSchema>;
