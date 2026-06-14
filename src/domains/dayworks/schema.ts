import { z } from "zod";

/**
 * Daywork register (#370) — per-job dockets for day-labour work, signed the day
 * it happens, landing in an admin register where unsigned and aging dockets are
 * visible payment risk. Grounded in 100 Arthur St, whose terms require day
 * labour sheets signed DAILY by the builder's supervisor.
 *
 * This module is the DOMAIN FOUNDATION: schema + types + pure logic (ref
 * minting, unsigned-aging, status transitions, immutability/amendment, register
 * summary). The admin API + register page, the on-glass drawn signature
 * (build-once, coordinated with #328/#295) and the Phil docket-create UI (gated
 * by the #132 job-screen review wave) are follow-ups.
 *
 * Hard rules baked into the model:
 *   - A docket without a signature saves as `unsigned` — never blocked, never
 *     faked. No signature image is ever synthesised.
 *   - Hours here are a COMMERCIAL record, NOT payroll — `linkedTimeEntryIds` is
 *     a one-way cross-reference; nothing in this domain writes to time-entries.
 *   - A signed/invoiced docket is immutable; changes are a linked amendment.
 *
 * House pattern: `.passthrough()` so later fields don't break older parsers.
 */

export const DAYWORK_STATUSES = ["unsigned", "signed", "invoiced"] as const;
export const DayworkStatusSchema = z.enum(DAYWORK_STATUSES);
export type DayworkStatus = z.infer<typeof DayworkStatusSchema>;

export const DayworkLabourLineSchema = z
  .object({
    id: z.string(),
    /** Defaults to the creator (self) when omitted at create. */
    workerId: z.string().nullable().optional(),
    workerName: z.string(),
    hours: z.number(),
    note: z.string().nullable().optional(),
  })
  .passthrough();

export const DayworkMaterialLineSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    quantity: z.number(),
    unit: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * The signature record. `supervisorName` is the typed, required builder's
 * supervisor; the drawn `imageUrl`/`imageSha256` are populated by the on-glass
 * capture (deferred follow-on). All stamps are server-set — never client-trusted.
 */
export const DayworkSignatureSchema = z
  .object({
    supervisorName: z.string(),
    imageUrl: z.string().nullable().optional(),
    imageSha256: z.string().nullable().optional(),
    signedAt: z.string(),
    capturedById: z.string(),
    capturedByName: z.string(),
  })
  .passthrough();

export const DayworkSchema = z
  .object({
    id: z.string(), // dw_…
    jobId: z.string(),
    jobName: z.string().nullable().optional(),
    /** Sequential per job — "DW-001". */
    ref: z.string(),
    /** The integer behind the ref; minting is max(seq)+1, never array length. */
    seq: z.number(),
    /** Work date (ISO), defaults to today at create. */
    date: z.string(),
    description: z.string(),
    labourLines: z.array(DayworkLabourLineSchema).default([]),
    materialLines: z.array(DayworkMaterialLineSchema).default([]),
    photoIds: z.array(z.string()).default([]),
    status: DayworkStatusSchema,
    signature: DayworkSignatureSchema.nullable().default(null),
    /** Manual invoice reference — Xero is Epic 8; no integration here. */
    invoiceRef: z.string().nullable().optional(),
    /** One-way cross-reference to a worker's day entry. NEVER written back. */
    linkedTimeEntryIds: z.array(z.string()).default([]),
    /** Spine / variation links (link only). */
    workPackageId: z.string().nullable().optional(),
    variationId: z.string().nullable().optional(),
    // Actor stamps.
    createdById: z.string(),
    createdByName: z.string(),
    createdByRole: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    invoicedById: z.string().nullable().optional(),
    invoicedByName: z.string().nullable().optional(),
    invoicedAt: z.string().nullable().optional(),
    // Amendment lineage — an amendment points at its immutable original.
    amendmentOfId: z.string().nullable().optional(),
    amended: z.boolean().optional(),
    auditLogIds: z.array(z.string()).default([]),
  })
  .passthrough();

// ── Input payloads ───────────────────────────────────────────────────────────

export const DAYWORK_LIMITS = {
  maxDescription: 2000,
  maxLabourLines: 50,
  maxMaterialLines: 100,
  maxPhotos: 10,
  maxSupervisorName: 140,
} as const;

export const CreateDayworkLabourLineSchema = z.object({
  workerId: z.string().nullable().optional(),
  workerName: z.string().trim().min(1),
  hours: z.number().finite().min(0).max(24),
  note: z.string().nullable().optional(),
});

export const CreateDayworkMaterialLineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.number().finite().min(0),
  unit: z.string().trim().max(24).nullable().optional(),
});

export const CreateDayworkPayloadSchema = z.object({
  description: z.string().trim().min(1).max(DAYWORK_LIMITS.maxDescription),
  date: z.string().optional(), // defaults to today server-side
  labourLines: z.array(CreateDayworkLabourLineSchema).max(DAYWORK_LIMITS.maxLabourLines).optional(),
  materialLines: z
    .array(CreateDayworkMaterialLineSchema)
    .max(DAYWORK_LIMITS.maxMaterialLines)
    .optional(),
  photoIds: z.array(z.string()).max(DAYWORK_LIMITS.maxPhotos).optional(),
  workPackageId: z.string().nullable().optional(),
  variationId: z.string().nullable().optional(),
  linkedTimeEntryIds: z.array(z.string()).optional(),
});

export const SignDayworkPayloadSchema = z.object({
  supervisorName: z.string().trim().min(1).max(DAYWORK_LIMITS.maxSupervisorName),
  /** Drawn signature image (data URL) — optional in the foundation; the capture
   *  UI is the deferred follow-on. A typed supervisor name alone signs. */
  signatureDataUrl: z.string().nullable().optional(),
});

export const UpdateDayworkStatusPayloadSchema = z.object({
  status: DayworkStatusSchema,
  invoiceRef: z.string().nullable().optional(),
});
