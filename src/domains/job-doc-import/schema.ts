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
