import { z } from "zod";

/**
 * Zod schemas for the gear domain — match api/assets.js wire shape verbatim
 * so the typed client can consume the existing legacy endpoint and the new
 * Phase C `?action=report` action without re-modelling the storage layer.
 *
 * Field nullability follows the server: optional/nullable fields are written
 * as explicit `null` by api/assets.js's `sanitiseAsset`, not omitted, so
 * schemas use `.nullable().optional()` to accept both shapes.
 *
 * Cross-ref:
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 *   api/assets.js — list/detail/create/transfer/report/edit/archive
 */

export const GEAR_ASSET_TYPES = [
  "vehicle",
  "key",
  "tool",
  "accessory",
  "ppe",
  "other",
] as const;
export const GearAssetTypeSchema = z.enum(GEAR_ASSET_TYPES);

/**
 * Derived status taxonomy. Not stored on the wire — computed by
 * `deriveStatus()` in service.ts from `(archived, condition, currentHolderId)`.
 *
 * `assigned` covers both "with worker" and "checked out" semantics from the
 * audit doc; the legacy model only tracks holder presence, not the
 * distinction between admin-assigned and worker-borrowed.
 *
 * `returned` is the transient label for an asset that has just transferred
 * back to storage — once persisted it appears as `available` again.
 */
export const GEAR_ASSET_STATUSES = [
  "available",
  "assigned",
  "damaged",
  "missing",
  "retired",
] as const;
export const GearAssetStatusSchema = z.enum(GEAR_ASSET_STATUSES);

/**
 * Stored on the wire (added by the Phase C `?action=report` action).
 * Defaults to `good` when absent — the legacy data did not carry this
 * field, so any pre-existing asset reads as `good` until reported.
 */
export const GEAR_ASSET_CONDITIONS = ["good", "damaged", "missing"] as const;
export const GearAssetConditionSchema = z.enum(GEAR_ASSET_CONDITIONS);

/**
 * The Phase C asset row.
 *
 * Legacy fields (`identifier`, `notes`, `currentHolderId`, `assignedAt`,
 * `expectedReturn`, `archived`, `ownership`, `hireEndDate`,
 * `hireRateExGst`, `hireSupplier`) all preserved. The new optional
 * fields (`condition`, `lastConditionAt`, `lastConditionBy`,
 * `lastCheckedAt`, `lastCheckedBy`) are written by `?action=report`.
 *
 * `currentHolderName` is enriched server-side from users.json (see
 * api/assets.js GET handler).
 */
export const GearAssetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: GearAssetTypeSchema,
    identifier: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),

    currentHolderId: z.string().nullable().optional(),
    currentHolderName: z.string().nullable().optional(),
    assignedAt: z.string().nullable().optional(),
    expectedReturn: z.string().nullable().optional(),

    // Phase C additions — optional so legacy rows (pre-condition write) parse.
    condition: GearAssetConditionSchema.optional(),
    lastConditionAt: z.string().nullable().optional(),
    lastConditionBy: z.string().nullable().optional(),
    lastConditionByName: z.string().nullable().optional(),
    lastCheckedAt: z.string().nullable().optional(),
    lastCheckedBy: z.string().nullable().optional(),

    // Existing hired-gear fields (Phase 12 in legacy).
    ownership: z.enum(["owned", "hired"]).optional(),
    hireEndDate: z.string().nullable().optional(),
    hireRateExGst: z.number().nullable().optional(),
    hireSupplier: z.string().nullable().optional(),

    archived: z.boolean().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * History entries stored in `assets/<id>/history.json`. Legacy entries
 * carry only transfer events (`from` / `to` / `at` / `byUserId` / `byRole`
 * / `byName` / `note`); the Phase C addition is `kind`, which is set on
 * every new entry the rebuild writes and is absent on legacy transfer rows
 * (default `'transfer'`).
 */
export const GEAR_HISTORY_KINDS = [
  "transfer",
  "check",
  "report_damaged",
  "report_missing",
  "admin_updated",
] as const;
export const GearHistoryKindSchema = z.enum(GEAR_HISTORY_KINDS);

export const GearHistoryEntrySchema = z
  .object({
    id: z.string(),
    kind: GearHistoryKindSchema.optional(), // optional for legacy transfer-only rows
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    fromName: z.string().nullable().optional(),
    toName: z.string().nullable().optional(),
    at: z.string(),
    byUserId: z.string().nullable().optional(),
    byRole: z.string().nullable().optional(),
    byName: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    condition: GearAssetConditionSchema.optional(),
  })
  .passthrough();

export const GearListResponseSchema = z.object({
  assets: z.array(GearAssetSchema),
});

export const GearDetailResponseSchema = z.object({
  asset: GearAssetSchema,
  history: z.array(GearHistoryEntrySchema),
});

export const GearMutationResponseSchema = z.object({
  asset: GearAssetSchema,
});

/* ----------------------------------------------------------------------
 * Mutation payload schemas
 * -------------------------------------------------------------------- */

/**
 * POST /api/assets — create asset. Mirrors legacy `api/assets.js` validation.
 * Admin only at the server (returns 403 otherwise).
 */
export const CreateGearAssetPayloadSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name too long"),
  type: GearAssetTypeSchema,
  identifier: z
    .string()
    .trim()
    .max(120, "Identifier too long")
    .nullable()
    .optional(),
  notes: z.string().trim().max(2000, "Notes too long").nullable().optional(),
  currentHolderId: z.string().nullable().optional(),
  expectedReturn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected return must be YYYY-MM-DD")
    .nullable()
    .optional(),
});

/**
 * POST /api/assets?action=transfer — assign / return gear. The legacy
 * server enforces visibility (tradie may only transfer something they
 * currently hold).
 */
export const TransferGearPayloadSchema = z.object({
  assetId: z.string().min(1, "assetId required"),
  /**
   * `null` returns the asset to storage. A worker id transfers it to that
   * worker. Admin may transfer anywhere; tradies may only transfer items
   * they currently hold and may not transfer to admin.
   */
  toUserId: z.string().nullable(),
  expectedReturn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected return must be YYYY-MM-DD")
    .nullable()
    .optional(),
  note: z.string().trim().max(500, "Note too long").nullable().optional(),
});

/**
 * POST /api/assets?action=report — Phase C condition / check action.
 *
 * `check` records a possession confirmation without changing condition.
 * `damaged` / `missing` set the asset condition and log the report.
 *
 * The server-side handler is added to api/assets.js as part of Phase C.
 */
export const REPORT_KINDS = ["check", "damaged", "missing"] as const;
export const ReportKindSchema = z.enum(REPORT_KINDS);

export const ReportGearPayloadSchema = z.object({
  assetId: z.string().min(1, "assetId required"),
  kind: ReportKindSchema,
  note: z.string().trim().max(500, "Note too long").nullable().optional(),
});

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
