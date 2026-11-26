import { z } from "zod";

/**
 * Wire contract for /api/customer-invoices (customer stage invoices, #1148 —
 * docs/customer-invoices.md). Money is integer cents; percentages are basis
 * points (500 = 5%). A figure the server could not work out is `null`, never
 * 0 — the screen names what is missing instead of showing a made-up number.
 *
 * NOT src/domains/invoices (supplier invoices coming in).
 */

export const STAGE_STATES = ["planned", "sending", "sent", "failed", "cancelled"] as const;

/** The one status a person reads on a row (api/_lib/customer-invoices/status.js). */
export const STAGE_DISPLAY_STATUSES = [
  "planned",
  "sending",
  "failed",
  "cancelled",
  "draft_in_xero",
  "awaiting_payment",
  "part_paid",
  "paid",
  "overdue",
  "voided",
  "deleted_in_xero",
  "sent_unchecked",
] as const;
export type StageDisplayStatus = (typeof STAGE_DISPLAY_STATUSES)[number];

export const ExtraLineSchema = z.object({
  description: z.string(),
  amountCents: z.number(),
  /** Set when the line bills an approved variation (#1163). */
  variationId: z.string().optional(),
});
export type ExtraLine = z.infer<typeof ExtraLineSchema>;

// ── itemised invoices (#1161 / #1162) ───────────────────────────────────────

/**
 * What a charge bills on the job, so nothing can be billed twice:
 *   h   approved hours — one worker, one day (`m` = thousandths of an hour)
 *   sl  one line of a captured supplier invoice
 *   si  a captured supplier invoice taken as one amount
 *   ml  a docket typed into the job's materials ledger
 *   v   an approved variation
 */
export const ItemRefSchema = z.union([
  z.object({ t: z.literal("h"), u: z.string(), d: z.string(), m: z.number() }),
  z.object({ t: z.enum(["sl", "si", "ml", "v"]), id: z.string() }),
]);
export type ItemRef = z.infer<typeof ItemRefSchema>;

export const ITEM_SOURCES = ["manual", "labour", "material", "variation"] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** One line of an itemised invoice: a charge, or wording only. Quantity is in
 *  THOUSANDTHS (2.5 hours = 2500); money is cents. `costCents` and `refs` are
 *  the office's own — they never go to Xero. */
export const InvoiceItemSchema = z.union([
  z.object({ id: z.string(), type: z.literal("note"), description: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("line"),
    description: z.string(),
    quantityMilli: z.number(),
    unit: z.string().nullable(),
    unitCents: z.number(),
    amountCents: z.number(),
    source: z.enum(ITEM_SOURCES),
    costCents: z.number().nullable(),
    refs: z.array(ItemRefSchema),
  }),
]);
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const ItemsSummarySchema = z.object({
  lineCount: z.number(),
  totalCents: z.number(),
  costCents: z.number(),
  costedSellCents: z.number(),
  /** False when a charge pulled from the job has no cost — no margin is shown. */
  costKnown: z.boolean(),
});
export type ItemsSummary = z.infer<typeof ItemsSummarySchema>;

/** What an unsent stage works out to today (or the frozen snapshot once sent). */
export const StageComputedSchema = z.object({
  grossCents: z.number().nullable(),
  retentionBp: z.number(),
  retentionCents: z.number().nullable(),
  netCents: z.number().nullable(),
  reason: z.enum(["no_contract_value", "no_lines", "invalid"]).nullable(),
});

export const StageSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    kind: z.enum(["stage", "retention_release", "itemised"]),
    /** An itemised invoice's lines, as priced by the server. */
    items: z.array(InvoiceItemSchema).optional(),
    itemsSummary: ItemsSummarySchema.optional(),
    seq: z.number().nullable(),
    invoiceNumber: z.string().nullable(),
    title: z.string(),
    basis: z.enum(["amount", "percent"]),
    percentBp: z.number().nullable(),
    amountCents: z.number().nullable(),
    extraLines: z.array(ExtraLineSchema),
    retentionBp: z.number().nullable(),
    plannedDate: z.string().nullable(),
    note: z.string().nullable(),
    state: z.enum(STAGE_STATES),
    version: z.number(),
    computed: StageComputedSchema,
    display: z.enum(STAGE_DISPLAY_STATUSES),
    // ── set once the stage has been sent (#1150) ──
    invoiceDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    reference: z.string().nullable().optional(),
    /** Why the last attempt didn't land (a stable category) and, when Xero
     *  refused it, Xero's own sentence. */
    failureCategory: z.string().nullable().optional(),
    failureDetail: z.string().nullable().optional(),
    xeroInvoiceId: z.string().nullable().optional(),
    xeroStatus: z.string().nullable().optional(),
    /** Xero's own figures for the invoice — these win over BuhlOS's maths. */
    xeroSubtotalCents: z.number().nullable().optional(),
    xeroTaxCents: z.number().nullable().optional(),
    xeroTotalCents: z.number().nullable().optional(),
    /** Present when what is in Xero doesn't match what was sent. */
    drift: z.object({ mismatches: z.array(z.string()) }).passthrough().nullable().optional(),
    // ── what Xero says happened next (#1151) — all Xero's own figures ──
    /** GST-inclusive, as Xero reports them. */
    xeroAmountPaidCents: z.number().nullable().optional(),
    xeroAmountDueCents: z.number().nullable().optional(),
    xeroDueDate: z.string().nullable().optional(),
    xeroFullyPaidOn: z.string().nullable().optional(),
    lastCheckedAt: z.string().nullable().optional(),
    /** Xero shows it deleted or voided and it hasn't been raised again yet. */
    canRaiseAgain: z.boolean().optional(),
    /** Set once a dead stage has been raised again as a new one. */
    replacedById: z.string().nullable().optional(),
    /** An invoice with no job (#1166) only: the Xero contact chosen on it. */
    clientContactId: z.string().nullable().optional(),
    clientContactName: z.string().nullable().optional(),
    /** That client was chosen in a different Xero organisation from the one
     *  connected now, so it has to be chosen again before sending. */
    clientOtherOrganisation: z.boolean().optional(),
  })
  .passthrough();
export type Stage = z.infer<typeof StageSchema>;

/**
 * The ledger that holds invoices with no job (#1166). The server keeps them
 * under this reserved id; a real job id can never contain `~`.
 */
export const NO_JOB_ID = "~no-job";

export const JobInvoicingProfileSchema = z
  .object({
    jobId: z.string(),
    retentionBp: z.number(),
    xeroContactId: z.string().nullable(),
    xeroContactName: z.string().nullable(),
    externalTenantId: z.string().nullable(),
    /** Invoices sent for this job carry the SA payment-claim statement (#1164). */
    paymentClaim: z.boolean().optional(),
    /** null until the profile is first saved. */
    version: z.number().nullable(),
  })
  .passthrough();
export type JobInvoicingProfile = z.infer<typeof JobInvoicingProfileSchema>;

export const JobInvoicingTotalsSchema = z
  .object({
    contractCents: z.number().nullable(),
    // ── variations (#1163) ──
    /** Contract + approved variations. null when the job has no contract value. */
    revisedContractCents: z.number().nullable().optional(),
    variationsApprovedCents: z.number().optional(),
    variationsApprovedCount: z.number().optional(),
    variationsPendingCents: z.number().optional(),
    variationsPendingCount: z.number().optional(),
    variationsUnpricedCount: z.number().optional(),
    plannedCount: z.number(),
    plannedGrossCents: z.number(),
    plannedNetCents: z.number(),
    /** Planned stages whose amount cannot be worked out (a % with no contract). */
    unresolvedCount: z.number(),
    sentCount: z.number(),
    claimedCents: z.number(),
    stillToInvoiceCents: z.number().nullable(),
    overContract: z.boolean(),
    retentionHeldCents: z.number(),
    // ── money in, from Xero's mirror (#1151) ──
    /** Ex GST: invoices still a draft in Xero / approved in Xero. */
    draftedCents: z.number().default(0),
    invoicedCents: z.number().default(0),
    /** Paid, ex GST — null when it can't be split out of Xero's GST-inclusive figure. */
    paidCents: z.number().nullable().default(null),
    /** GST-inclusive, as Xero shows them. */
    paidIncGstCents: z.number().default(0),
    dueIncGstCents: z.number().default(0),
  })
  .passthrough();
export type JobInvoicingTotals = z.infer<typeof JobInvoicingTotalsSchema>;

/**
 * Whether Xero can be used for invoices right now (#1149) — decided on the
 * server from the stored connection alone:
 *   connected           usable
 *   missing_permission  connected without the invoice scopes → reconnect
 *   reconnect_required  the grant was revoked or expired
 *   connecting          authorised, organisation not chosen yet
 *   disconnected        no connection
 *   not_configured      Xero isn't set up in this environment
 *   unavailable         the connection couldn't be read (the schedule still works)
 */
export const XERO_READINESS_STATES = [
  "connected",
  "missing_permission",
  "reconnect_required",
  "connecting",
  "disconnected",
  "not_configured",
  "unavailable",
] as const;
export type XeroReadinessState = (typeof XERO_READINESS_STATES)[number];

export const XeroContactSchema = z.object({ id: z.string(), name: z.string() });
export type XeroContact = z.infer<typeof XeroContactSchema>;

/** Where one job stands against Xero. */
export const JobXeroStandingSchema = z.object({
  state: z.enum(XERO_READINESS_STATES),
  organisationName: z.string().nullable(),
  /** Sales account, tax rate and payment terms are all chosen. */
  settingsComplete: z.boolean(),
  /** Everything a send needs at job level is in place (#1150): Xero usable,
   *  defaults chosen, client linked in this organisation, job has an IV number. */
  sendReady: z.boolean(),
  client: z.object({
    linked: z.boolean(),
    name: z.string().nullable(),
    /** Linked while a DIFFERENT Xero organisation was connected. */
    otherOrganisation: z.boolean(),
    /** The contact another job with the same client name uses — offered, never applied. */
    suggestion: XeroContactSchema.nullable(),
  }),
});
export type JobXeroStanding = z.infer<typeof JobXeroStandingSchema>;

export const ContactSearchResponseSchema = z.object({ contacts: z.array(XeroContactSchema) });

export const InvoiceSettingsSchema = z
  .object({
    salesAccountCode: z.string().nullable(),
    salesAccountName: z.string().nullable(),
    taxType: z.string().nullable(),
    taxName: z.string().nullable(),
    taxRateBp: z.number().nullable(),
    paymentTermsDays: z.number().nullable(),
    version: z.number().nullable(),
    updatedBy: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();
export type InvoiceSettings = z.infer<typeof InvoiceSettingsSchema>;

export const InvoiceSettingsResponseSchema = z.object({
  xero: z.object({ state: z.enum(XERO_READINESS_STATES), organisationName: z.string().nullable() }),
  /** null until the defaults are first saved for the connected organisation. */
  settings: InvoiceSettingsSchema.nullable(),
  complete: z.boolean(),
});
export type InvoiceSettingsResponse = z.infer<typeof InvoiceSettingsResponseSchema>;

export const InvoiceSettingsOptionsSchema = z.object({
  accounts: z.array(z.object({ code: z.string(), name: z.string(), taxType: z.string().nullable() })),
  taxRates: z.array(z.object({ taxType: z.string(), name: z.string(), rateBp: z.number() })),
});
export type InvoiceSettingsOptions = z.infer<typeof InvoiceSettingsOptionsSchema>;

// ── variations (#1163) ──────────────────────────────────────────────────────

export const VARIATION_STATUSES = ["proposed", "approved", "declined"] as const;
export const VariationSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    seq: z.number(),
    /** "V3" */
    number: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    requestedBy: z.string().nullable(),
    requestedOn: z.string().nullable(),
    /** The price put to the client, ex GST. null = not priced yet. */
    quotedCents: z.number().nullable(),
    status: z.enum(VARIATION_STATUSES),
    /** What was approved — the figure that counts and is billed. */
    approvedCents: z.number().nullable(),
    approvalRef: z.string().nullable(),
    decidedOn: z.string().nullable(),
    decidedBy: z.string().nullable().optional(),
    /** The invoice it is on, read from the invoices' own lines. */
    billedOn: z.string().nullable(),
    version: z.number(),
  })
  .passthrough();
export type Variation = z.infer<typeof VariationSchema>;

export interface VariationInput {
  title: string;
  detail?: string | null;
  requestedBy?: string | null;
  requestedOn?: string | null;
  quotedCents?: number | null;
}

export const JobInvoicingResponseSchema = z.object({
  jobId: z.string(),
  /** True for the ledger of invoices with no job (#1166). */
  noJob: z.boolean().optional(),
  job: z.object({
    name: z.string(),
    code: z.string().nullable(),
    clientName: z.string().nullable(),
    contractCents: z.number().nullable(),
  }),
  profile: JobInvoicingProfileSchema,
  stages: z.array(StageSchema),
  variations: z.array(VariationSchema).optional(),
  totals: JobInvoicingTotalsSchema,
  /** How fresh the paid / owing figures are: the OLDEST "last checked with
   *  Xero" among the job's sent invoices. null when nothing has been sent. */
  statusAsOf: z.string().nullable().default(null),
  xero: JobXeroStandingSchema,
  asOf: z.string(),
});
export type JobInvoicingResponse = z.infer<typeof JobInvoicingResponseSchema>;

// ── sending (#1150) ─────────────────────────────────────────────────────────

/** Why a stage can't be sent — stable codes from the server. */
export const SEND_BLOCKER_CODES = [
  "not_planned",
  "xero_not_ready",
  "settings_incomplete",
  "no_client_link",
  "client_other_organisation",
  "no_client_chosen",
  "client_chosen_other_organisation",
  "no_job_code",
  "no_contract_value",
  "no_lines",
  "amount_invalid",
  "nothing_to_invoice",
  "not_awaiting_xero",
  "other_organisation",
] as const;
export const SendBlockerSchema = z.object({ code: z.string() }).passthrough();
export type SendBlocker = z.infer<typeof SendBlockerSchema>;

/** Exactly what would be sent (the preview) — writes nothing. */
export const SendPreviewSchema = z.object({
  blockers: z.array(SendBlockerSchema),
  invoice: z
    .object({
      invoiceNumber: z.string(),
      organisationName: z.string().nullable(),
      contactName: z.string().nullable(),
      invoiceDate: z.string(),
      dueDate: z.string().nullable(),
      reference: z.string(),
      lines: z.array(
        z.object({
          description: z.string(),
          amountCents: z.number(),
          /** Present on an itemised charge. */
          quantityMilli: z.number().optional(),
          unit: z.string().nullable().optional(),
          unitCents: z.number().optional(),
          /** Wording only — no amount. */
          note: z.boolean().optional(),
        })
      ),
      netCents: z.number(),
      /** What Xero is expected to add, from the rate Xero gave — an estimate. */
      estimatedTaxCents: z.number().nullable(),
      estimatedTotalCents: z.number().nullable(),
      salesAccountCode: z.string(),
      salesAccountName: z.string().nullable(),
      taxName: z.string().nullable(),
      taxRateBp: z.number().nullable(),
    })
    .nullable(),
});
export type SendPreview = z.infer<typeof SendPreviewSchema>;

/**
 * How a send / retry / reset ended:
 *   sent     created in Xero as a draft
 *   adopted  it was already in Xero — taken over, nothing sent twice
 *   failed   Xero refused it; nothing exists there
 *   unknown  no answer from Xero — it may or may not exist there
 *   reset    put back to planned; Xero confirmed it holds nothing
 */
export const SEND_OUTCOMES = ["sent", "adopted", "failed", "unknown", "reset"] as const;
export const SendResultSchema = z.object({
  outcome: z.enum(SEND_OUTCOMES),
  invoiceNumber: z.string().nullable(),
  verified: z.boolean().nullable(),
  mismatches: z.array(z.string()),
  category: z.string().nullable(),
  detail: z.string().nullable(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const SendResponseSchema = JobInvoicingResponseSchema.extend({
  send: SendResultSchema,
  syncLogWarning: z.string().optional(),
});
export type SendResponse = z.infer<typeof SendResponseSchema>;

/** "Check Xero now" (#1151): the refreshed job plus what the check found. */
export const RefreshResponseSchema = JobInvoicingResponseSchema.extend({
  refresh: z.object({ checked: z.number(), changed: z.number(), notFound: z.number() }),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/** What the stage editor sends (mirrors the handler's StageBody). */
export interface StageInput {
  title: string;
  basis: "amount" | "percent";
  amountCents?: number | null;
  percentBp?: number | null;
  extraLines?: ExtraLine[];
  /** null = use the job's retention. */
  retentionBp?: number | null;
  plannedDate?: string | null;
  note?: string | null;
}

// ── an itemised invoice, as the editor sends it ─────────────────────────────

export type ItemInput =
  | { id?: string; type: "note"; description: string }
  | {
      id?: string;
      type: "line";
      description: string;
      quantityMilli: number;
      unit?: string | null;
      unitCents: number;
      source?: ItemSource;
      /** The office's own cost for a typed line; ignored on a line that bills job data. */
      costCents?: number | null;
      refs?: ItemRef[];
    };

export interface ItemisedInput {
  kind: "itemised";
  title: string;
  items: ItemInput[];
  retentionBp?: number | null;
  plannedDate?: string | null;
  note?: string | null;
  /** An invoice with no job (#1166) only: the Xero contact it is for.
   *  null = no client chosen yet. Never sent for a job's invoice. */
  contactId?: string | null;
}

// ── what on the job can go on an invoice (#1162) ────────────────────────────

const source = { available: z.boolean(), reason: z.string().nullable() };

export const BillableDaySchema = z.object({
  userId: z.string(),
  name: z.string(),
  date: z.string(),
  hoursMilli: z.number(),
  billedMilli: z.number(),
  unbilledMilli: z.number(),
  onInvoice: z.string().nullable(),
  chargeOutRateCents: z.number().nullable(),
  /** What an hour of this worker costs the business (office only). */
  costRateCents: z.number().nullable(),
  hasCostRate: z.boolean(),
});
export type BillableDay = z.infer<typeof BillableDaySchema>;

const materialHead = {
  id: z.string(),
  supplier: z.string(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  costCents: z.number(),
  onInvoice: z.string().nullable(),
};
export const SupplierLineSchema = z.object({
  ...materialHead,
  invoiceId: z.string(),
  credit: z.boolean().optional(),
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unitCostCents: z.number().nullable(),
});
export const SupplierWholeSchema = z.object({ ...materialHead, invoiceId: z.string(), credit: z.boolean().optional(), lineCount: z.number() });
export const LedgerLineSchema = z.object({ ...materialHead, description: z.string().nullable() });

export const UsualChargeSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  unitCents: z.number(),
  kind: z.enum(["labour", "other"]),
});
export type UsualCharge = z.infer<typeof UsualChargeSchema>;

export const InvoicePrefsSchema = z.object({
  /** Usual markup on materials, basis points. null until the office sets one. */
  materialsMarkupBp: z.number().nullable(),
  /** Pulled hours are rounded UP to this many minutes per line. 0 = as logged. */
  labourRoundMinutes: z.number(),
  usualCharges: z.array(UsualChargeSchema),
  version: z.number().nullable(),
});
export type InvoicePrefs = z.infer<typeof InvoicePrefsSchema>;
export const InvoicePrefsResponseSchema = z.object({ prefs: InvoicePrefsSchema });

export const BillableResponseSchema = z.object({
  jobId: z.string(),
  labour: z.object({ ...source, days: z.array(BillableDaySchema), pendingMilli: z.number() }),
  supplier: z.object({ ...source, lines: z.array(SupplierLineSchema), whole: z.array(SupplierWholeSchema) }),
  ledger: z.object({ ...source, lines: z.array(LedgerLineSchema) }),
  summary: z.object({
    unbilledHoursMilli: z.number(),
    unbilledMaterialCount: z.number(),
    unbilledMaterialCostCents: z.number(),
    anyBilled: z.boolean(),
  }),
  prefs: InvoicePrefsSchema,
  asOf: z.string(),
});
export type BillableResponse = z.infer<typeof BillableResponseSchema>;
