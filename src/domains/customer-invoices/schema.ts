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
});
export type ExtraLine = z.infer<typeof ExtraLineSchema>;

/** What an unsent stage works out to today (or the frozen snapshot once sent). */
export const StageComputedSchema = z.object({
  grossCents: z.number().nullable(),
  retentionBp: z.number(),
  retentionCents: z.number().nullable(),
  netCents: z.number().nullable(),
  reason: z.enum(["no_contract_value", "invalid"]).nullable(),
});

export const StageSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    kind: z.enum(["stage", "retention_release"]),
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
  })
  .passthrough();
export type Stage = z.infer<typeof StageSchema>;

export const JobInvoicingProfileSchema = z
  .object({
    jobId: z.string(),
    retentionBp: z.number(),
    xeroContactId: z.string().nullable(),
    xeroContactName: z.string().nullable(),
    externalTenantId: z.string().nullable(),
    /** null until the profile is first saved. */
    version: z.number().nullable(),
  })
  .passthrough();
export type JobInvoicingProfile = z.infer<typeof JobInvoicingProfileSchema>;

export const JobInvoicingTotalsSchema = z
  .object({
    contractCents: z.number().nullable(),
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

export const JobInvoicingResponseSchema = z.object({
  jobId: z.string(),
  job: z.object({
    name: z.string(),
    code: z.string().nullable(),
    clientName: z.string().nullable(),
    contractCents: z.number().nullable(),
  }),
  profile: JobInvoicingProfileSchema,
  stages: z.array(StageSchema),
  totals: JobInvoicingTotalsSchema,
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
  "no_job_code",
  "no_contract_value",
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
      lines: z.array(z.object({ description: z.string(), amountCents: z.number() })),
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
