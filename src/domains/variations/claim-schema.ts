import { z } from "zod";

/**
 * Variation CLAIM — the billable record of extra work the contractor must get
 * paid for (#280). This is the money-bearing claim, distinct from (and sitting
 * beside) the approval-state workflow in ./schema.ts:
 *
 *   ./schema.ts          the APPROVAL state a variation/daywork passes through
 *                        (draft → sent_to_builder → approved → released …) — the
 *                        commercial-loop guard "no release without approval".
 *   ./claim-schema.ts    THIS — the per-job billable CLAIM: scope, value (cents),
 *                        evidence links, approval evidence, and the claim
 *                        pipeline draft → quoted → submitted → approved →
 *                        rejected → invoiced.
 *
 * The two are complementary, not duplicates: a claim is what you invoice; the
 * approval record is whether the builder said yes. They share the `method`
 * enum (how an approval was obtained) so the signature-platform child and the
 * client-approval-records child can converge on one shape.
 *
 * Replaces the legacy localStorage register (`public/admin/variations.html`,
 * `buhlos.variations.v1`) — which was DELETED in the 2026-06 legacy-interface
 * cutover. There is no live persisted register to migrate; this is the first
 * server-backed home for the data. Status set carried over from the legacy
 * pipeline (draft / submitted / approved / rejected / invoiced) plus the
 * `quoted` step the issue's target adds between draft and submitted.
 *
 * House pattern: `.passthrough()` so later fields never break older parsers;
 * types are inferred (consumers import from ./types, never the Zod schemas).
 */

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * The claim pipeline. Carried over from the legacy register's working set
 * (draft / submitted / approved / rejected / invoiced) with `quoted` inserted
 * between draft and submitted (the issue's target pipeline:
 * draft → quoted → submitted → approved → rejected → invoiced).
 *
 *   draft      raised internally, scope + value being worked up
 *   quoted     a priced quote/build-up exists (ready to send)
 *   submitted  sent to the builder for a decision
 *   approved   builder approved — REQUIRES approval evidence (see below)
 *   rejected   builder declined
 *   invoiced   billed (manual invoice reference only; Xero is Epic 8 / #184)
 */
export const VARIATION_CLAIM_STATUSES = [
  "draft",
  "quoted",
  "submitted",
  "approved",
  "rejected",
  "invoiced",
] as const;

export const VariationClaimStatusSchema = z.enum(VARIATION_CLAIM_STATUSES);
export type VariationClaimStatus = z.infer<typeof VariationClaimStatusSchema>;

// ── Approval evidence ──────────────────────────────────────────────────────--

/**
 * How a builder approval was obtained. Shared with the approval-state child
 * and the signature-platform child (the method enum anticipates a signature
 * capture landing under `signed`/`portal`).
 */
export const VARIATION_APPROVAL_METHODS = [
  "email",
  "verbal",
  "signed",
  "portal",
] as const;

export const VariationApprovalMethodSchema = z.enum(VARIATION_APPROVAL_METHODS);
export type VariationApprovalMethod = z.infer<typeof VariationApprovalMethodSchema>;

/**
 * The evidence a claim MUST carry to reach `approved`. Every field is required:
 * who approved it, when, by what method, and a reference (an email subject, a
 * call note, a portal id, or an attachment url). A claim can never silently
 * become approved — this is the dispute-survival guarantee.
 */
export const VariationApprovalEvidenceSchema = z
  .object({
    /** The builder-side contact/name who approved (free text — not a user id). */
    approvedBy: z.string().trim().min(1),
    /** ISO timestamp the approval was given/recorded. */
    approvedAt: z.string().trim().min(1),
    /** How the approval was obtained. */
    method: VariationApprovalMethodSchema,
    /** Free-text reference or an attachment url — what proves the approval. */
    reference: z.string().trim().min(1),
  })
  .passthrough();

export type VariationApprovalEvidence = z.infer<typeof VariationApprovalEvidenceSchema>;

// ── Links ─────────────────────────────────────────────────────────────────---

/**
 * What a claim points at. All optional — a claim can be raised from scratch or
 * carry the field trail that justifies it. `observationId` is the back-link set
 * when a claim is converted from a `variation`-typed observation.
 */
export const VariationClaimLinksSchema = z
  .object({
    observationId: z.string().nullable().optional(),
    evidenceIds: z.array(z.string()).default([]),
    documentIds: z.array(z.string()).default([]),
  })
  .passthrough();

export type VariationClaimLinks = z.infer<typeof VariationClaimLinksSchema>;

// ── Money ─────────────────────────────────────────────────────────────────---

/**
 * Money convention: ALL values are integer cents (AUD cents). The rollup sums
 * integers only — never floats — so the open-value total can't drift. A claim
 * displaying as $1,234.50 is stored as `valueCents: 123450`. `null` means the
 * value is not yet known (a draft being scoped); the rollup treats null as 0.
 */
export const VARIATION_CLAIM_LIMITS = {
  maxScope: 200,
  maxDescription: 4000,
  maxRef: 200,
  // A defensive ceiling — a single claim above ~$100M is a typo, not a claim.
  maxValueCents: 10_000_000_000,
} as const;

// ── Record ─────────────────────────────────────────────────────────────────--

/**
 * One variation claim, stored per-job at `jobs/<jobId>/variations.json`.
 * `ref` is the sequential per-job reference `VO-001` (zero-padded, collision
 * safe — minted from the max existing ref on the job). `valueCents` is the
 * billable value in integer cents (see Money above).
 */
export const VariationClaimRecordSchema = z
  .object({
    id: z.string(), // vc_…
    jobId: z.string(),
    /** Sequential per-job reference, e.g. "VO-001". */
    ref: z.string(),
    /** Short scope title an admin and a builder both read. */
    scope: z.string(),
    description: z.string().nullable().optional(),
    status: VariationClaimStatusSchema,
    /** Billable value in integer cents; null while a draft is scoped. */
    valueCents: z.number().int().nullable().default(null),

    links: VariationClaimLinksSchema.default({ evidenceIds: [], documentIds: [] }),

    // Approval evidence — present only once the claim is approved.
    approval: VariationApprovalEvidenceSchema.nullable().default(null),

    // Decision note for reject.
    decisionNote: z.string().nullable().optional(),

    // Invoice — manual reference only (no integration; Xero is Epic 8 / #184).
    invoiceRef: z.string().nullable().optional(),
    invoicedAt: z.string().nullable().optional(),

    // Audit.
    createdAt: z.string(),
    createdById: z.string().nullable().optional(),
    createdByName: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    auditLogIds: z.array(z.string()).default([]),
  })
  .passthrough();

export type VariationClaimRecord = z.infer<typeof VariationClaimRecordSchema>;

// ── Create input ───────────────────────────────────────────────────────────--

/**
 * The shape a caller supplies to raise a fresh claim. The factory stamps the
 * id, `ref`, `status: "draft"`, the timestamps and the empty audit array.
 */
export const CreateVariationClaimInputSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  ref: z.string(),
  scope: z.string().trim().min(1).max(VARIATION_CLAIM_LIMITS.maxScope),
  description: z
    .string()
    .max(VARIATION_CLAIM_LIMITS.maxDescription)
    .nullable()
    .optional(),
  valueCents: z
    .number()
    .int()
    .min(0)
    .max(VARIATION_CLAIM_LIMITS.maxValueCents)
    .nullable()
    .optional(),
  links: VariationClaimLinksSchema.optional(),
  createdById: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
});

export type CreateVariationClaimInput = z.infer<typeof CreateVariationClaimInputSchema>;
