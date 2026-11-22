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
  asOf: z.string(),
});
export type JobInvoicingResponse = z.infer<typeof JobInvoicingResponseSchema>;

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
