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
