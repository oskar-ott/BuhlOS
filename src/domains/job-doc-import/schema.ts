import { z } from "zod";

/**
 * #365 — pricing/BOQ workbook import preview (read-only).
 *
 * The boundary schema for the preview returned by POST /api/job-doc-import. The
 * server parser (api/_lib/boq-import.js) produces this shape; the client parses
 * the response against this schema so a malformed payload fails loudly at the
 * boundary rather than rendering garbage. NOTHING here writes job/quote data —
 * this is a reviewable preview only.
 */

export const BOQ_FLAG_KINDS = [
  "supplied_by_others",
  "value_engineered",
  "provisional_sum",
  "needs_clarification",
  "long_lead",
  "excluded",
] as const;
export type BoqFlagKind = (typeof BOQ_FLAG_KINDS)[number];

/** Human labels for the ambiguity chips (UI). */
export const BOQ_FLAG_LABEL: Record<BoqFlagKind, string> = {
  supplied_by_others: "Supplied by others",
  value_engineered: "Value-engineered",
  provisional_sum: "Provisional (PC) sum",
  needs_clarification: "Needs clarification",
  long_lead: "Long-lead",
  excluded: "Excluded",
};

export const BoqLineSchema = z.object({
  section: z.enum(["lighting", "electrical"]),
  code: z.string().nullable(),
  description: z.string(),
  qty: z.number(),
  supplyRate: z.number().nullable(),
  supplyAmount: z.number().nullable(),
  installRate: z.number().nullable(),
  installAmount: z.number().nullable(),
  lineTotal: z.number(),
  notes: z.string(),
  flags: z.array(z.string()),
});
export type BoqLine = z.infer<typeof BoqLineSchema>;

const BoqReconShape = {
  computed: z.number(),
  stated: z.number().nullable(),
  delta: z.number().nullable(),
  reconciles: z.boolean().nullable(),
};
export const BoqReconSchema = z.object(BoqReconShape);
export type BoqRecon = z.infer<typeof BoqReconSchema>;

export const BoqSectionSchema = z.object({
  key: z.enum(["lighting", "electrical"]),
  lineCount: z.number(),
  ...BoqReconShape,
});
export type BoqSection = z.infer<typeof BoqSectionSchema>;

export const BoqAmbiguitySchema = z.object({
  kind: z.string(),
  ref: z.string(),
  message: z.string(),
});
export type BoqAmbiguity = z.infer<typeof BoqAmbiguitySchema>;

export const BoqImportPreviewSchema = z.object({
  source: z.object({ sheetCount: z.number(), sheetNames: z.array(z.string()) }),
  sections: z.array(BoqSectionSchema),
  totals: BoqReconSchema,
  lines: z.array(BoqLineSchema),
  ambiguities: z.array(BoqAmbiguitySchema),
  counts: z.object({ lines: z.number(), byFlag: z.record(z.number()) }),
});
export type BoqImportPreview = z.infer<typeof BoqImportPreviewSchema>;

/**
 * #365 write-half: the cost-basis summary the job hub reads back via
 * GET /api/job-doc-import?jobId=. A projection of the attached cost-import.json
 * — the headline totals + counts + provenance, NOT the full priced lines (the
 * hub card only needs the headline). `costImport` is null when the job was not
 * created from a BOQ import, so the card stays hidden-until-real. Money is whole
 * dollars (2dp), as the BOQ parser emits — NOT integer cents.
 */
export const CostImportSummarySchema = z.object({
  source: z.string(),
  importedAt: z.string().nullable(),
  importedByName: z.string().nullable(),
  fileName: z.string().nullable(),
  total: z.number(),
  stated: z.number().nullable(),
  delta: z.number().nullable(),
  reconciles: z.boolean().nullable(),
  lines: z.number(),
  sections: z.number(),
});
export type CostImportSummary = z.infer<typeof CostImportSummarySchema>;

export const CostImportResponseSchema = z.object({
  costImport: CostImportSummarySchema.nullable(),
});
export type CostImportResponse = z.infer<typeof CostImportResponseSchema>;

// ── #365 quote-side workbook import (attach-to-quote + review) ────────────

/** Per-line classification set (AC: base / alternate / exclusion / PC-sum /
 *  by-others). Mirrors QUOTE_LINE_CLASSIFICATIONS in api/_lib/boq-import.js —
 *  change together. */
export const WORKBOOK_CLASSIFICATIONS = [
  "base",
  "alternate",
  "exclusion",
  "pc_sum",
  "by_others",
] as const;
export const WorkbookClassificationSchema = z.enum(WORKBOOK_CLASSIFICATIONS);
export type WorkbookClassification = z.infer<typeof WorkbookClassificationSchema>;

export const WORKBOOK_CLASSIFICATION_LABEL: Record<WorkbookClassification, string> = {
  base: "Base scope",
  alternate: "Alternate",
  exclusion: "Excluded",
  pc_sum: "PC / provisional",
  by_others: "By others",
};

/** Named health finding with cell provenance — resolve/waive-able. */
export const WorkbookFindingSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.enum(["error", "warning"]),
  cellRef: z.string(),
  message: z.string(),
});
export type WorkbookFinding = z.infer<typeof WorkbookFindingSchema>;

export const WORKBOOK_FINDING_LABEL: Record<string, string> = {
  formula_error: "Formula error",
  qty_rate_mismatch: "Qty × rate ≠ subtotal",
  subtotal_missing_inputs: "Subtotal without qty/rate",
  hardcoded_value: "Hardcoded among formulas",
  total_mismatch: "Totals don't reconcile",
  alternate_counted_in_base: "Alternate counted in base",
};

export const WorkbookLineSchema = z.object({
  id: z.string(),
  sheet: z.string(),
  row: z.number(),
  section: z.string().nullable(),
  description: z.string(),
  qty: z.number().nullable(),
  unit: z.string(),
  rate: z.number().nullable(),
  subtotal: z.number().nullable(),
  lineTotal: z.number().nullable(),
  classification: WorkbookClassificationSchema,
  classificationReason: z.string().nullable(),
  cells: z.object({
    description: z.string(),
    qty: z.string().nullable(),
    unit: z.string().nullable(),
    rate: z.string().nullable(),
    subtotal: z.string().nullable(),
  }),
});
export type WorkbookLine = z.infer<typeof WorkbookLineSchema>;

export const WorkbookSectionSchema = z.object({
  name: z.string(),
  lineCount: z.number(),
  computed: z.number(),
  base: z.number(),
  stated: z.number().nullable(),
  statedCellRef: z.string().nullable(),
  reconciles: z.boolean().nullable(),
});
export type WorkbookSection = z.infer<typeof WorkbookSectionSchema>;

export const WorkbookParseSchema = z.object({
  source: z.object({ sheetCount: z.number(), sheetNames: z.array(z.string()) }),
  lines: z.array(WorkbookLineSchema),
  sections: z.array(WorkbookSectionSchema),
  statedTotal: z.object({ value: z.number(), cellRef: z.string() }).nullable(),
  totals: z.object({
    all: z.number(),
    base: z.number(),
    byClassification: z.record(z.number()),
    stated: z.number().nullable(),
    delta: z.number().nullable(),
    reconciles: z.boolean().nullable(),
  }),
  findings: z.array(WorkbookFindingSchema),
  counts: z.object({
    lines: z.number(),
    findings: z.number(),
    bySeverity: z.object({ error: z.number(), warning: z.number() }),
  }),
});
export type WorkbookParse = z.infer<typeof WorkbookParseSchema>;

/** The stored (wire-projected) import record on a quote: the current import,
 *  the human decisions on it, the review state and the kept record of every
 *  superseded upload. `status` carries the honest counters the quote surface
 *  renders ("imported — N findings, M unconfirmed classifications"). */
export const WorkbookImportRecordSchema = z.object({
  quoteId: z.string(),
  current: z.object({
    importId: z.string(),
    importedAt: z.string(),
    importedById: z.string(),
    importedByName: z.string(),
    fileName: z.string().nullable(),
    parse: WorkbookParseSchema,
  }),
  confirmations: z.array(
    z.object({
      lineId: z.string(),
      classification: WorkbookClassificationSchema,
      by: z.string(),
      at: z.string(),
    })
  ),
  resolutions: z.array(
    z.object({
      findingId: z.string(),
      action: z.enum(["resolved", "waived"]),
      reason: z.string().nullable(),
      by: z.string(),
      at: z.string(),
    })
  ),
  review: z.object({
    status: z.enum(["pending", "complete"]),
    completedBy: z.string().optional(),
    completedAt: z.string().optional(),
    openFindingsAtCompletion: z.number().optional(),
    unconfirmedAtCompletion: z.number().optional(),
  }),
  superseded: z.array(
    z.object({
      importId: z.string(),
      importedAt: z.string(),
      importedByName: z.string(),
      fileName: z.string().nullable(),
      lineCount: z.number(),
      findingCount: z.number(),
      supersededAt: z.string(),
      supersededById: z.string(),
    })
  ),
  status: z.object({
    openFindings: z.number(),
    unconfirmedClassifications: z.number(),
  }),
});
export type WorkbookImportRecord = z.infer<typeof WorkbookImportRecordSchema>;

export const WorkbookImportResponseSchema = z.object({
  workbookImport: WorkbookImportRecordSchema.nullable(),
});
export type WorkbookImportResponse = z.infer<typeof WorkbookImportResponseSchema>;

export const AttachWorkbookResponseSchema = z.object({
  quoteId: z.string(),
  quoteName: z.string(),
  importId: z.string(),
  counts: z.object({
    lines: z.number(),
    findings: z.number(),
    unconfirmedClassifications: z.number(),
    materialisedLines: z.number(),
  }),
  supersededCount: z.number(),
});
export type AttachWorkbookResponse = z.infer<typeof AttachWorkbookResponseSchema>;
