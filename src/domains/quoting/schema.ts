import { z } from "zod";

/**
 * Quoting v2 domain model (#183) — the foundation the Epic 7 calculators
 * build on. Shaped per the #172 MIGRATE-BY-REBUILD ruling
 * (docs/quoting-legacy-audit.md): the legacy module is a design reference,
 * not a runtime dependency. Storage is NEW (`quotes-v2.json` registry +
 * one `quotes-v2/<id>.json` document per quote) — the legacy nine-section
 * blob layout under `quotes/<id>/` is never read or written by v2.
 *
 * The model is deliberately TABLE-SHAPED (flat rows with ids + a parent
 * key) so the Supabase Phase 1 quote tables can absorb it when dual-write
 * lands (#152): Quote 1—n Section 1—n Line.
 *
 * Line totals are COMPUTED (qty × rate), never stored per-line — only the
 * quote-level totals snapshot persists (recomputed server-side on every
 * save). See totals.ts for the rounding rule and the #214 boundary.
 *
 * Wire schemas use .passthrough() (house pattern, jobs/schema.ts) so
 * fields added by the calculator children (#193/#195/#214/#223) never
 * break older parsers.
 */

// ── Statuses ─────────────────────────────────────────────────────────────

/**
 * Subset of the legacy ten-status pipeline (#172 §4.2) — only the states a
 * v2 surface will actually offer, kept extensible for the pipeline children
 * (#240 acceptance, #186 client split). The v1 foundation UI itself only
 * ever writes `draft` (create/save) and `archived` (DELETE → status flip).
 */
export const QUOTE_STATUSES = ["draft", "submitted", "won", "lost", "archived"] as const;
export const QuoteStatusSchema = z.enum(QUOTE_STATUSES);
export type QuoteStatus = z.infer<typeof QuoteStatusSchema>;

/** Line kinds — the three the plain-line builder offers. The calculator
 *  children own richer typing (labour crew/risk, material categories). */
export const QUOTE_LINE_KINDS = ["material", "labour", "other"] as const;
export const QuoteLineKindSchema = z.enum(QUOTE_LINE_KINDS);
export type QuoteLineKind = z.infer<typeof QuoteLineKindSchema>;

// ── Input limits (anti-bloat, mirrored by api/quotes-v2.js) ──────────────
// api/quotes-v2.js is CJS and cannot import this module; it mirrors these
// values by hand. Change them TOGETHER (the API harness test pins both).

export const QUOTE_LIMITS = {
  maxSections: 50,
  maxLinesPerSection: 200,
  maxName: 120,
  maxClientName: 120,
  maxSectionTitle: 80,
  maxLineDescription: 200,
  maxUnit: 20,
  maxCategory: 60,
  maxQty: 1_000_000,
  maxRate: 1_000_000,
  maxId: 40,
} as const;

// ── Wire schemas (what the API returns) ──────────────────────────────────

export const QuoteLineSchema = z
  .object({
    id: z.string(),
    kind: QuoteLineKindSchema,
    description: z.string(),
    /** Quantity in `unit`s. */
    qty: z.number(),
    /** Free-text unit label ("ea", "m", "hrs"). */
    unit: z.string(),
    /** Sell rate per unit, ex GST. */
    rate: z.number(),
    /** #214/#193 — INTERNAL cost per unit, ex GST (office-only; the client
     *  projection never carries it). Absent → the line is "uncosted" (margin
     *  honesty: never treated as $0 cost). For a labour line a rate preset
     *  fills this with the loaded cost rate. */
    unitCost: z.number().optional(),
    /** Optional grouping label for the margin view (materials esp.). Internal. */
    category: z.string().optional(),
    /** Snapshot stamp when a labour rate preset was applied (independence:
     *  the rates were COPIED onto the line, editing the preset never changes it). */
    ratePresetId: z.string().optional(),
    ratePresetName: z.string().optional(),
  })
  .passthrough();
export type QuoteLine = z.infer<typeof QuoteLineSchema>;

export const QuoteSectionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    /** Persisted position — the server normalises this to the array index
     *  on save so section order is deterministic and table-portable. */
    sortOrder: z.number(),
    lines: z.array(QuoteLineSchema),
  })
  .passthrough();
export type QuoteSection = z.infer<typeof QuoteSectionSchema>;

/** Server-computed totals snapshot. The builder recomputes the same numbers
 *  live from totals.ts; the snapshot is what lists/registry rows read. */
export const QuoteTotalsSchema = z
  .object({
    subtotalExGst: z.number(),
    gst: z.number(),
    totalIncGst: z.number(),
    lineCount: z.number(),
  })
  .passthrough();
export type QuoteTotals = z.infer<typeof QuoteTotalsSchema>;

export const QuoteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    clientName: z.string().nullish(),
    status: QuoteStatusSchema,
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
    sections: z.array(QuoteSectionSchema),
    totals: QuoteTotalsSchema,
  })
  .passthrough();
export type Quote = z.infer<typeof QuoteSchema>;

/** Registry row (`quotes-v2.json` → quotes[]) — exactly what the list
 *  surface renders; the full document lives in `quotes-v2/<id>.json`. */
export const QuoteSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: QuoteStatusSchema,
    updatedAt: z.string(),
    totalIncGst: z.number(),
    lineCount: z.number(),
  })
  .passthrough();
export type QuoteSummary = z.infer<typeof QuoteSummarySchema>;

export const QuoteListResponseSchema = z.object({
  quotes: z.array(QuoteSummarySchema),
});
export type QuoteListResponse = z.infer<typeof QuoteListResponseSchema>;

export const QuoteDetailResponseSchema = z.object({
  quote: QuoteSchema,
});
export type QuoteDetailResponse = z.infer<typeof QuoteDetailResponseSchema>;

/** 409 body on a stale save — carries the CURRENT server document so the
 *  builder can offer "reload latest" without a second round-trip. */
export const QuoteConflictResponseSchema = z.object({
  error: z.string(),
  quote: QuoteSchema,
});
export type QuoteConflictResponse = z.infer<typeof QuoteConflictResponseSchema>;

// ── Input schemas (what the client sends) ────────────────────────────────

export const QuoteCreateInputSchema = z.object({
  name: z.string().trim().min(1, "name required").max(QUOTE_LIMITS.maxName),
  clientName: z.string().trim().max(QUOTE_LIMITS.maxClientName).optional(),
});
export type QuoteCreateInput = z.infer<typeof QuoteCreateInputSchema>;

const QuoteLineInputSchema = z.object({
  /** Existing line ids are preserved; omit for new lines (server mints). */
  id: z.string().max(QUOTE_LIMITS.maxId).optional(),
  kind: QuoteLineKindSchema,
  description: z.string().trim().max(QUOTE_LIMITS.maxLineDescription),
  qty: z.number().finite().min(0).max(QUOTE_LIMITS.maxQty),
  unit: z.string().trim().max(QUOTE_LIMITS.maxUnit),
  rate: z.number().finite().min(-QUOTE_LIMITS.maxRate).max(QUOTE_LIMITS.maxRate),
  /** #214/#193 internal cost fields (optional; the server persists them and the
   *  client projection strips them). Cost may be negative within range only as a
   *  symmetric guard; the builder enters it as ≥ 0. */
  unitCost: z.number().finite().min(-QUOTE_LIMITS.maxRate).max(QUOTE_LIMITS.maxRate).optional(),
  category: z.string().trim().max(QUOTE_LIMITS.maxCategory).optional(),
  ratePresetId: z.string().trim().max(QUOTE_LIMITS.maxId).optional(),
  ratePresetName: z.string().trim().max(QUOTE_LIMITS.maxName).optional(),
});
export type QuoteLineInput = z.infer<typeof QuoteLineInputSchema>;

const QuoteSectionInputSchema = z.object({
  id: z.string().max(QUOTE_LIMITS.maxId).optional(),
  title: z.string().trim().min(1, "section title required").max(QUOTE_LIMITS.maxSectionTitle),
  lines: z.array(QuoteLineInputSchema).max(QUOTE_LIMITS.maxLinesPerSection),
});
export type QuoteSectionInput = z.infer<typeof QuoteSectionInputSchema>;

/**
 * PUT /api/quotes-v2?id=… full-document save. `updatedAt` is REQUIRED: the
 * client echoes the value it loaded and the server 409s when the stored
 * document has moved (two tabs / two estimators). Section order is the
 * array order — the server rewrites sortOrder from it.
 */
export const QuoteSaveInputSchema = z.object({
  name: z.string().trim().min(1, "name required").max(QUOTE_LIMITS.maxName),
  clientName: z.string().trim().max(QUOTE_LIMITS.maxClientName).optional(),
  status: QuoteStatusSchema.optional(),
  sections: z.array(QuoteSectionInputSchema).max(QUOTE_LIMITS.maxSections),
  updatedAt: z.string().min(1, "updatedAt precondition required"),
});
export type QuoteSaveInput = z.infer<typeof QuoteSaveInputSchema>;
