import { z } from "zod";

/**
 * Supplier-invoice capture — API shapes (mirrors api/invoices.js +
 * api/_lib/invoices/store.js). Money is INTEGER CENTS end to end; the
 * supplier's invoice number (`supplierInvoiceNumber`) and the BuhlOS IV job
 * reference (`ivReference`) are separate fields and are never merged.
 */

export const INVOICE_STATUSES = [
  "received",
  "processing",
  "matched",
  "needs_review",
  "confirmed",
  "duplicate",
  "excluded",
  "failed",
  "archived",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const DOCUMENT_TYPES = ["invoice", "tax_invoice", "credit_note", "statement", "quote", "delivery_docket", "order_confirmation", "remittance", "purchase_order", "other", "unknown"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Material categories for line items — mirrors api/_lib/invoices/categories.js. */
export const MATERIAL_CATEGORIES = ["cable", "conduit", "fixings", "switchgear", "boards", "lighting", "accessories", "data", "consumables", "tools", "testing", "freight", "other"] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

export const MeasureSchema = z.object({ amount: z.number().nullable(), unit: z.string().nullable(), explain: z.string().nullable() });
export type Measure = z.infer<typeof MeasureSchema>;

export const InvoiceLineSchema = z
  .object({
    id: z.string(),
    invoiceId: z.string(),
    lineNo: z.number(),
    description: z.string(),
    descriptionKey: z.string().nullable().optional(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    unitPriceCents: z.number().nullable(),
    lineTotalCents: z.number().nullable(),
    category: z.enum(MATERIAL_CATEGORIES),
    categorySource: z.enum(["rule", "learned", "ai", "manual"]),
    confidence: z.string(),
    /** Metres / pieces worked out from qty × the length or pack size in the description. */
    measure: MeasureSchema.default({ amount: null, unit: null, explain: null }),
  })
  .passthrough();
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

export const JobMaterialsBreakdownSchema = z.object({
  jobId: z.string(),
  confirmedCents: z.number(),
  invoiceCount: z.number(),
  linesCents: z.number(),
  byCategory: z.array(
    z.object({
      category: z.enum(MATERIAL_CATEGORIES),
      label: z.string(),
      cents: z.number(),
      lineCount: z.number(),
      /** e.g. { m: 450 } or { pcs: 128, m: 50 } — summed per measure unit, credit notes negative. */
      measure: z.record(z.number()).default({}),
      measuredLines: z.number().default(0),
      unmeasuredLines: z.number().default(0),
      products: z
        .array(
          z.object({
            key: z.string(),
            description: z.string(),
            supplierName: z.string().nullable(),
            cents: z.number(),
            lineCount: z.number(),
            invoiceCount: z.number(),
            quantities: z.record(z.number()),
            measures: z.record(z.number()),
            lineIds: z.array(z.string()),
          })
        )
        .default([]),
    })
  ),
  bySupplier: z.array(z.object({ supplierName: z.string(), cents: z.number() })),
  lines: z.array(
    InvoiceLineSchema.extend({
      supplierName: z.string().nullable(),
      supplierInvoiceNumber: z.string().nullable(),
      invoiceDate: z.string().nullable(),
      documentType: z.string(),
      purchaser: z.string().nullable().default(null),
      signedCents: z.number(),
    })
  ),
  invoicesWithoutLines: z.array(z.object({ invoiceId: z.string(), supplierName: z.string().nullable(), supplierInvoiceNumber: z.string().nullable(), invoiceDate: z.string().nullable(), amountCents: z.number().nullable() })),
});
export type JobMaterialsBreakdown = z.infer<typeof JobMaterialsBreakdownSchema>;

/** The statement check the pipeline stores on a statement row (matchReason.statement). */
export const StatementCheckSchema = z.object({
  listed: z.number(),
  matched: z.array(
    z.object({ ref: z.string(), invoiceId: z.string(), status: z.string(), documentType: z.string(), amountCents: z.number().nullable(), capturedTotalCents: z.number().nullable() })
  ),
  missing: z.array(z.object({ ref: z.string(), kind: z.string(), date: z.string().nullable(), amountCents: z.number().nullable() })),
  checkedAt: z.string().optional(),
});
export type StatementCheck = z.infer<typeof StatementCheckSchema>;
export function statementCheckOf(matchReason: Record<string, unknown> | null | undefined): StatementCheck | null {
  const r = matchReason && typeof matchReason === "object" ? StatementCheckSchema.safeParse((matchReason as { statement?: unknown }).statement) : null;
  return r && r.success ? r.data : null;
}

export const MATCH_STATUSES = ["none", "exact", "ambiguous", "not_found", "multi_reference", "manual", "inferred"] as const;

const FieldSchema = z
  .object({
    value: z.unknown().nullable().optional(),
    confidence: z.string().nullable().optional(),
    provenance: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
  })
  .passthrough();
export type ExtractedField = z.infer<typeof FieldSchema>;

export const InvoiceSchema = z
  .object({
    id: z.string(),
    status: z.enum(INVOICE_STATUSES),
    source: z.enum(["email", "upload", "receipt"]),
    documentType: z.enum(DOCUMENT_TYPES),
    supplierName: z.string().nullable(),
    supplierKey: z.string().nullable(),
    supplierAbn: z.string().nullable(),
    supplierInvoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    currency: z.string(),
    subtotalCents: z.number().int().nullable(),
    gstCents: z.number().int().nullable(),
    totalCents: z.number().int().nullable(),
    totalsConsistent: z.boolean().nullable(),
    ivReferenceRaw: z.string().nullable(),
    ivReference: z.string().nullable(),
    ivCandidates: z.array(z.record(z.unknown())).default([]),
    matchedJobId: z.string().nullable(),
    matchStatus: z.enum(MATCH_STATUSES),
    matchReason: z.record(z.unknown()).nullable(),
    reviewReasons: z.array(z.string()).default([]),
    failureCode: z.string().nullable(),
    extractionMethod: z.string().nullable(),
    fields: z.record(FieldSchema).default({}),
    excerpt: z.string().nullable(),
    attemptCount: z.number().int(),
    duplicateOfId: z.string().nullable(),
    duplicateReason: z.string().nullable(),
    sourceEmailId: z.string().nullable(),
    sourceSubject: z.string().nullable(),
    /** https links found in an email that carried no usable attachment (bounded). */
    linesTotalCents: z.number().nullable().default(null),
    linesConsistent: z.boolean().nullable().default(null),
    /** Who was at the counter, as printed; the employee it matched (only when unambiguous). */
    purchaserName: z.string().nullable().default(null),
    purchaserUserId: z.string().nullable().default(null),
    purchaserWorkerName: z.string().nullable().default(null),
    sourceLinks: z.array(z.string()).default([]),
    sourceTextExcerpt: z.string().nullable().default(null),
    sourceFrom: z.string().nullable(),
    createdBy: z.string().nullable(),
    /** Receipts from the field: the worker paid with their own money. BuhlOS records
     *  the fact for the office; it runs no reimbursement and confirms no payback. */
    paidPersonally: z.boolean().default(false),
    workerNote: z.string().nullable().default(null),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    confirmedBy: z.string().nullable(),
    excludedReason: z.string().nullable(),
    archivedAt: z.string().nullable(),
    autoConfirmEligible: z.boolean().default(false),
    autoConfirmAt: z.string().nullable().default(null),
    autoConfirmChecks: z
      .array(z.object({ code: z.string(), label: z.string().optional(), ok: z.boolean(), detail: z.string().nullable().optional() }).passthrough())
      .default([]),
    heldAt: z.string().nullable().default(null),
    heldBy: z.string().nullable().default(null),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .passthrough();
export type Invoice = z.infer<typeof InvoiceSchema>;

export const InvoiceDocumentSchema = z
  .object({
    id: z.string(),
    invoiceId: z.string(),
    source: z.string(),
    /** pdf = text was read; image = a photo/scan shown for manual entry. */
    kind: z.enum(["pdf", "image"]).default("pdf"),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number(),
    sha256: z.string(),
    pageCount: z.number().nullable(),
    hasTextLayer: z.boolean().nullable(),
    uploadedBy: z.string().nullable(),
    createdAt: z.string().nullable(),
  })
  .passthrough();
export type InvoiceDocument = z.infer<typeof InvoiceDocumentSchema>;

export const AllocationSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    amountCents: z.number().int(),
    gstCents: z.number().int().nullable(),
    totalCents: z.number().int().nullable(),
    status: z.enum(["active", "reversed"]),
    confirmedBy: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    reversedAt: z.string().nullable(),
    reversedBy: z.string().nullable(),
    reversalReason: z.string().nullable(),
  })
  .passthrough();
export type Allocation = z.infer<typeof AllocationSchema>;

export const InvoiceEventSchema = z
  .object({
    id: z.string(),
    event: z.string(),
    actor: z.string().nullable(),
    actorRole: z.string().nullable(),
    detail: z.record(z.unknown()).default({}),
    at: z.string().nullable(),
  })
  .passthrough();
export type InvoiceEvent = z.infer<typeof InvoiceEventSchema>;

export const JobSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  status: z.string(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const InvoiceDetailSchema = z
  .object({
    invoice: InvoiceSchema,
    documents: z.array(InvoiceDocumentSchema),
    allocations: z.array(AllocationSchema),
    events: z.array(InvoiceEventSchema),
    attempts: z.array(z.record(z.unknown())).default([]),
    lines: z.array(InvoiceLineSchema).default([]),
    job: JobSummarySchema.nullable(),
    duplicateOf: z
      .object({
        id: z.string(),
        supplierName: z.string().nullable(),
        supplierInvoiceNumber: z.string().nullable(),
        status: z.string(),
        createdAt: z.string().nullable(),
      })
      .nullable(),
    canConfirm: z.boolean(),
    confirmBlockers: z.array(z.string()).default([]),
    /** Task E (2026-09-27): the distinct IV codes printed on the document when there are several — split allocation required. */
    multiReferences: z.array(z.string()).default([]),
    /** Near-miss job codes when the printed IV number matches nothing ("Did you mean…?"). */
    suggestions: z.array(JobSummarySchema).default([]),
    supplierPref: z.object({ alwaysReview: z.boolean(), setBy: z.string().nullable(), setAt: z.string().nullable() }).default({ alwaysReview: false, setBy: null, setAt: null }),
    alreadyConfirmed: z.boolean().optional(),
  })
  .passthrough();
export type InvoiceDetail = z.infer<typeof InvoiceDetailSchema>;

export const InvoiceListSchema = z
  .object({
    invoices: z.array(InvoiceSchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    counts: z.record(z.number()).default({}),
    autoConfirmPendingCount: z.number().int().default(0),
    suppliers: z.array(z.object({ key: z.string(), name: z.string().nullable(), count: z.number() })).default([]),
    jobsById: z.record(JobSummarySchema).default({}),
  })
  .passthrough();
export type InvoiceList = z.infer<typeof InvoiceListSchema>;

export const InvoiceSetupSchema = z
  .object({
    inbound: z.object({
      configured: z.boolean(),
      address: z.string().nullable(),
      webhookSecretSet: z.boolean(),
      apiKeySet: z.boolean(),
      tokenSet: z.boolean(),
      domainSet: z.boolean(),
      stats: z.record(z.unknown()).default({}),
      quarantinedWaiting: z.boolean(),
    }),
    ai: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
    autoConfirm: z.object({ enabled: z.boolean(), capCents: z.number(), graceHours: z.number(), lookbackDays: z.number() }).optional(),
    pending: z.number().int(),
    maxUploadBytes: z.number().int(),
  })
  .passthrough();
export type InvoiceSetup = z.infer<typeof InvoiceSetupSchema>;

export const JobInvoiceSummarySchema = z
  .object({
    jobId: z.string(),
    confirmedCents: z.number().int().nullable(),
    confirmedCount: z.number().int(),
    awaitingCount: z.number().int(),
    invoices: z.array(InvoiceSchema).default([]),
  })
  .passthrough();
export type JobInvoiceSummary = z.infer<typeof JobInvoiceSummarySchema>;

export const JobPickerSchema = z.object({ jobs: z.array(JobSummarySchema) });

export const ProcessPendingSchema = z.object({
  processed: z.array(z.object({ id: z.string(), status: z.string(), code: z.string().nullable().optional() })),
});

// ── Task F (2026-09-27): automatic-booking shadow report ─────────────────────
const AgreementCountsSchema = z.object({ agree: z.number().int(), differ: z.number().int(), unknown: z.number().int() });
export const ShadowReportSchema = z
  .object({
    period: z.object({ from: z.string(), to: z.string() }),
    generatedAt: z.string(),
    days: z.number().int(),
    autoBookingEnabled: z.boolean(),
    invoicesInPeriod: z.number().int(),
    sampleSize: z.number().int(),
    neverEvaluated: z.number().int(),
    setAside: z.number().int(),
    legacyVerdicts: z.number().int(),
    unresolved: z.number().int(),
    wouldHaveBooked: z.object({
      count: z.number().int(),
      agreed: z.number().int(),
      falsePositives: z.number().int(),
      unresolved: z.number().int(),
      autoBookedStands: z.number().int(),
      autoBookedThenReversed: z.number().int(),
      falsePositiveReasons: z.record(z.number()),
    }),
    wouldHaveWaited: z.object({
      count: z.number().int(),
      correct: z.number().int(),
      falseNegatives: z.number().int(),
      unresolved: z.number().int(),
      falseNegativeReasons: z.record(z.number()),
    }),
    agreement: z.object({ job: AgreementCountsSchema, supplier: AgreementCountsSchema, figures: AgreementCountsSchema }),
    humanExclusions: z.number().int(),
    humanJobChanges: z.number().int(),
    disagreements: z.array(
      z.object({
        invoiceId: z.string(),
        supplierName: z.string().nullable(),
        supplierInvoiceNumber: z.string().nullable(),
        kind: z.string(),
        reasons: z.array(z.string()),
        verdictJob: z.string().nullable(),
        finalJob: z.string().nullable(),
      }),
    ),
    bySupplier: z.array(
      z.object({
        supplierKey: z.string().nullable(),
        supplierName: z.string().nullable(),
        sample: z.number().int(),
        wouldHaveBooked: z.number().int(),
        agreed: z.number().int(),
        falsePositives: z.number().int(),
        falseNegatives: z.number().int(),
        unresolved: z.number().int(),
        autoBooked: z.number().int(),
        autoBookedThenReversed: z.number().int(),
      }),
    ),
    gate: z.object({
      pass: z.boolean(),
      checks: z.array(z.object({ code: z.string(), ok: z.boolean(), detail: z.string() })),
      suppliersReady: z.array(z.string().nullable()),
      thresholds: z.record(z.number()),
    }),
  })
  .passthrough();
export type ShadowReport = z.infer<typeof ShadowReportSchema>;

// ── Task I (2026-09-27): remembered filing (learned product categories) ──────
export const LearnedCategorySchema = z
  .object({
    id: z.string(),
    /** '' = applies to every supplier (a rule saved before a supplier was read). */
    supplierKey: z.string(),
    supplierName: z.string().nullable(),
    descriptionKey: z.string(),
    category: z.string(),
    setBy: z.string().nullable(),
    setAt: z.string().nullable(),
    /** Line items currently filed by this rule (re-reads re-file, so this is "now", not a lifetime count). */
    linesFiledNow: z.number().int(),
  })
  .passthrough();
export type LearnedCategory = z.infer<typeof LearnedCategorySchema>;
export const LearnedCategoryListSchema = z.object({ rules: z.array(LearnedCategorySchema), total: z.number().int() }).passthrough();
export type LearnedCategoryList = z.infer<typeof LearnedCategoryListSchema>;

/**
 * GET /api/invoices?action=job-purchases — a job's recent purchases (owner pull
 * 2026-10-04). `amountCents` / `totalCents` are present ONLY for the office
 * tier (`costVisible`); the server never sends them to the crew or a leading
 * hand, so their absence here is the contract, not a UI choice.
 */
export const JobPurchaseLineSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  category: z.string(),
  categoryLabel: z.string(),
  measure: z.object({ amount: z.number().nullable(), unit: z.string().nullable() }),
});
export const JobPurchaseSchema = z.object({
  id: z.string(),
  date: z.string().nullable(),
  supplier: z.string().nullable(),
  supplierInvoiceNumber: z.string().nullable(),
  boughtBy: z.string().nullable(),
  kind: z.enum(["invoice", "receipt", "return"]),
  lines: z.array(JobPurchaseLineSchema),
  amountCents: z.number().int().nullable().optional(),
});
export const JobPurchasesSchema = z.object({
  purchases: z.array(JobPurchaseSchema),
  totalCount: z.number().int(),
  awaitingCount: z.number().int(),
  costVisible: z.boolean(),
  totalCents: z.number().int().optional(),
});
export type JobPurchaseLine = z.infer<typeof JobPurchaseLineSchema>;
export type JobPurchase = z.infer<typeof JobPurchaseSchema>;
export type JobPurchases = z.infer<typeof JobPurchasesSchema>;
